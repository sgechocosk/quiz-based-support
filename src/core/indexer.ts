import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  chunkFile,
  DEFAULT_CHUNK_OPTIONS,
  embeddingTextOf,
  isIndexable,
  languageForPath,
  type ChunkOptions,
  type ParserProvider,
} from "./chunker";
import type { Embedder, FileInfo, WorkspacePort } from "./ports";
import { buildRepoMap } from "./repomap";
import { HybridIndex, type SearchOptions } from "./search";
import { estimateTokens, sha1 } from "./text";
import type { ChunkRecord, SearchHit } from "./types";
import { decodeVectors, encodeVectors, normalizeVector } from "./vectorStore";

interface ManifestFile {
  hash: string;
  size: number;
  mtime: number;
  chunks: ChunkRecord[];
}

interface Manifest {
  version: 2;
  maxChars: number;
  /** ユーザーがセマンティック検索(埋め込み)を有効化済みか */
  semantic: boolean;
  embeddingModel?: string;
  files: Record<string, ManifestFile>;
}

export interface IndexerOptions {
  dir: string;
  workspace: WorkspacePort;
  parser?: ParserProvider;
  /** キー未設定なら undefined を返す */
  embedder: () => Embedder | undefined;
  embeddingModel: () => string;
  chunkOptions?: ChunkOptions;
  maxFiles?: number;
  maxFileBytes?: number;
  embedBatchSize?: number;
}

export interface SyncPlan {
  updates: Map<string, ManifestFile | null>;
  changedFiles: number;
  removedFiles: number;
  newChunks: number;
  /** 埋め込みが必要なユニークチャンク */
  pendingEmbeds: Array<{ hash: string; text: string }>;
  pendingTokens: number;
  truncated: boolean;
}

export interface IndexStats {
  files: number;
  chunks: number;
  vectors: number;
  coverage: number;
  semantic: boolean;
  embeddingModel?: string;
}

export type Progress = (message: string) => void;

function emptyManifest(maxChars: number): Manifest {
  return { version: 2, maxChars, semantic: false, files: {} };
}

/**
 * ワークスペースのコードをチャンク化して保存する。
 * - 変更されたファイルだけを再処理(size+mtime → 内容ハッシュ)する差分更新
 * - 埋め込みはチャンク内容ハッシュでキャッシュ(行がずれただけなら再計算しない)
 * - 埋め込みなし(BM25のみ)でも動作。ベクトルは任意の上乗せ
 */
export class IndexManager {
  private manifest: Manifest;
  private vectors = new Map<string, Float32Array>();
  private hybrid: HybridIndex | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly chunkOptions: ChunkOptions;

  constructor(private readonly opts: IndexerOptions) {
    this.chunkOptions = opts.chunkOptions ?? DEFAULT_CHUNK_OPTIONS;
    this.manifest = emptyManifest(this.chunkOptions.maxChars);
  }

  /** 同時実行を直列化する */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private get manifestPath(): string {
    return path.join(this.opts.dir, "manifest.json");
  }

  private get vectorsPath(): string {
    return path.join(this.opts.dir, "vectors.bin");
  }

  load(): Promise<void> {
    return this.exclusive(async () => {
      try {
        const raw = await fs.readFile(this.manifestPath, "utf8");
        const parsed = JSON.parse(raw) as Manifest;
        if (parsed.version === 2 && parsed.maxChars === this.chunkOptions.maxChars) {
          this.manifest = parsed;
        }
      } catch {
        this.manifest = emptyManifest(this.chunkOptions.maxChars);
      }
      this.vectors = new Map();
      if (this.manifest.semantic) {
        try {
          const sameModel = this.manifest.embeddingModel === this.opts.embeddingModel();
          if (sameModel) {
            this.vectors = decodeVectors(await fs.readFile(this.vectorsPath));
          }
        } catch {
          this.vectors = new Map();
        }
      }
      this.rebuild();
    });
  }

  private rebuild(): void {
    const chunks = Object.values(this.manifest.files).flatMap((f) => f.chunks);
    this.hybrid = new HybridIndex(chunks, this.vectors);
  }

  stats(): IndexStats {
    const files = Object.keys(this.manifest.files).length;
    const chunks = this.hybrid?.chunks.length ?? 0;
    return {
      files,
      chunks,
      vectors: this.vectors.size,
      coverage: this.hybrid?.vectorCoverage ?? 0,
      semantic: this.manifest.semantic,
      embeddingModel: this.manifest.embeddingModel,
    };
  }

  hasChunks(): boolean {
    return (this.hybrid?.chunks.length ?? 0) > 0;
  }

  isSemanticEnabled(): boolean {
    return this.manifest.semantic;
  }

  /** 差分計算(副作用なし)。paths を渡すとそのファイルだけを対象にする。 */
  async prepare(paths?: string[], progress?: Progress): Promise<SyncPlan> {
    const maxFiles = this.opts.maxFiles ?? 3000;
    const maxBytes = this.opts.maxFileBytes ?? 300_000;
    const updates = new Map<string, ManifestFile | null>();
    let truncated = false;

    let targets: FileInfo[];
    const removed: string[] = [];
    if (paths) {
      targets = [];
      for (const p of paths) {
        const info = await this.opts.workspace.stat(p);
        if (info && isIndexable(p) && info.size <= maxBytes) {
          targets.push(info);
        } else if (this.manifest.files[p]) {
          removed.push(p);
        }
      }
    } else {
      const all = (await this.opts.workspace.listFiles())
        .filter((f) => isIndexable(f.path) && f.size <= maxBytes)
        .sort((a, b) => a.path.localeCompare(b.path));
      truncated = all.length > maxFiles;
      targets = all.slice(0, maxFiles);
      const present = new Set(targets.map((t) => t.path));
      for (const p of Object.keys(this.manifest.files)) {
        if (!present.has(p)) {
          removed.push(p);
        }
      }
    }

    let changed = 0;
    let done = 0;
    for (const file of targets) {
      done++;
      const prev = this.manifest.files[file.path];
      if (prev && prev.size === file.size && prev.mtime === file.mtime) {
        continue;
      }
      let text: string;
      try {
        text = await this.opts.workspace.readText(file.path);
      } catch {
        continue;
      }
      const hash = sha1(text);
      if (prev && prev.hash === hash) {
        updates.set(file.path, { ...prev, size: file.size, mtime: file.mtime });
        continue;
      }
      const drafts = await chunkFile(file.path, text, this.opts.parser, this.chunkOptions);
      const language = languageForPath(file.path)?.language ?? "text";
      const chunks: ChunkRecord[] = drafts.map((d) => {
        const body = embeddingTextOf(file.path, d);
        const chunkHash = sha1(body);
        return {
          id: `${file.path}:${d.startLine}-${d.endLine}:${chunkHash.slice(0, 8)}`,
          hash: chunkHash,
          file: file.path,
          language,
          kind: d.kind,
          scope: d.scope,
          symbols: d.symbols,
          startLine: d.startLine,
          endLine: d.endLine,
          text: d.text,
        };
      });
      updates.set(file.path, { hash, size: file.size, mtime: file.mtime, chunks });
      changed++;
      if (progress && done % 20 === 0) {
        progress(`解析中 (${done}/${targets.length})`);
      }
    }
    for (const p of removed) {
      updates.set(p, null);
    }

    // 埋め込みが必要なチャンク = 反映後の全チャンクのうちベクトル未計算のもの。
    // (変更ファイルだけでなく、後から意味検索を有効化した場合の既存チャンクも含める)
    let newChunks = 0;
    const finalChunks: ChunkRecord[] = [];
    for (const [p, f] of Object.entries(this.manifest.files)) {
      if (!updates.has(p)) {
        finalChunks.push(...f.chunks);
      }
    }
    for (const entry of updates.values()) {
      if (entry) {
        newChunks += entry.chunks.length;
        finalChunks.push(...entry.chunks);
      }
    }
    const pending = new Map<string, string>();
    for (const c of finalChunks) {
      if (!this.vectors.has(c.hash) && !pending.has(c.hash)) {
        pending.set(c.hash, embeddingTextOf(c.file, c));
      }
    }
    const pendingEmbeds = [...pending].map(([hash, text]) => ({ hash, text }));
    return {
      updates,
      changedFiles: changed,
      removedFiles: removed.length,
      newChunks,
      pendingEmbeds,
      pendingTokens: pendingEmbeds.reduce((sum, p) => sum + estimateTokens(p.text), 0),
      truncated,
    };
  }

  /**
   * 差分を反映して保存する。embed=true かつ埋め込み器があれば、不足分のベクトルも作る。
   * 途中で失敗しても、それまでのチャンクと作成済みベクトルは保存される。
   */
  commit(plan: SyncPlan, options: { embed: boolean }, progress?: Progress, signal?: AbortSignal): Promise<IndexStats> {
    return this.exclusive(async () => {
      for (const [p, entry] of plan.updates) {
        if (entry) {
          this.manifest.files[p] = entry;
        } else {
          delete this.manifest.files[p];
        }
      }
      let failure: unknown;
      const embedder = this.opts.embedder();
      if (options.embed && embedder && plan.pendingEmbeds.length > 0) {
        const batch = this.opts.embedBatchSize ?? 64;
        try {
          for (let i = 0; i < plan.pendingEmbeds.length; i += batch) {
            if (signal?.aborted) {
              throw new Error("中止しました。");
            }
            const slice = plan.pendingEmbeds.slice(i, i + batch);
            progress?.(
              `埋め込み生成中 (${Math.min(i + slice.length, plan.pendingEmbeds.length)}/${plan.pendingEmbeds.length})`,
            );
            const result = await embedder.embed(
              slice.map((s) => s.text),
              signal,
              `索引の埋め込み作成(${Math.min(i + slice.length, plan.pendingEmbeds.length)}/${plan.pendingEmbeds.length}件)`,
            );
            slice.forEach((s, j) => {
              const v = result[j];
              if (v && v.length > 0) {
                this.vectors.set(s.hash, normalizeVector(v));
              }
            });
          }
          this.manifest.semantic = true;
          this.manifest.embeddingModel = this.opts.embeddingModel();
        } catch (error) {
          failure = error;
          if (this.vectors.size > 0) {
            this.manifest.semantic = true;
            this.manifest.embeddingModel = this.opts.embeddingModel();
          }
        }
      }
      const referenced = new Set<string>();
      for (const f of Object.values(this.manifest.files)) {
        for (const c of f.chunks) {
          referenced.add(c.hash);
        }
      }
      for (const hash of [...this.vectors.keys()]) {
        if (!referenced.has(hash)) {
          this.vectors.delete(hash);
        }
      }
      await this.persist();
      this.rebuild();
      if (failure) {
        throw failure;
      }
      return this.stats();
    });
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.opts.dir, { recursive: true });
    const tmpManifest = this.manifestPath + ".tmp";
    await fs.writeFile(tmpManifest, JSON.stringify(this.manifest), "utf8");
    await fs.rename(tmpManifest, this.manifestPath);
    if (this.vectors.size > 0) {
      const tmpVectors = this.vectorsPath + ".tmp";
      await fs.writeFile(tmpVectors, encodeVectors(this.vectors));
      await fs.rename(tmpVectors, this.vectorsPath);
    } else {
      await fs.rm(this.vectorsPath, { force: true });
    }
  }

  async clear(): Promise<void> {
    await this.exclusive(async () => {
      this.manifest = emptyManifest(this.chunkOptions.maxChars);
      this.vectors = new Map();
      await fs.rm(this.opts.dir, { recursive: true, force: true });
      this.rebuild();
    });
  }

  /** ハイブリッド検索。ベクトル未整備/埋め込み失敗時は BM25 のみで返す。 */
  async search(
    query: string,
    options: SearchOptions,
  ): Promise<{ hits: SearchHit[]; semantic: boolean; note?: string }> {
    const hybrid = this.hybrid;
    if (!hybrid || hybrid.chunks.length === 0) {
      return { hits: [], semantic: false, note: "インデックスが空です。" };
    }
    let queryVector: Float32Array | undefined;
    let note: string | undefined;
    const embedder = this.opts.embedder();
    if (embedder && hybrid.hasVectors()) {
      try {
        const [v] = await embedder.embed([query], undefined, "検索クエリの埋め込み");
        if (v && v.length > 0) {
          queryVector = normalizeVector(v);
        }
      } catch (error) {
        note = `埋め込み検索に失敗したためキーワード検索のみ(${error instanceof Error ? error.message : String(error)})`;
      }
    }
    return { hits: hybrid.search(query, queryVector, options), semantic: queryVector !== undefined, note };
  }

  fileChunks(filePath: string): ChunkRecord[] {
    return this.manifest.files[filePath]?.chunks ?? [];
  }

  findSymbols(query: string, limit = 30): ChunkRecord[] {
    const q = query.toLowerCase();
    const out: ChunkRecord[] = [];
    for (const f of Object.values(this.manifest.files)) {
      for (const c of f.chunks) {
        if (c.symbols.some((s) => s.toLowerCase().includes(q))) {
          out.push(c);
          if (out.length >= limit) {
            return out;
          }
        }
      }
    }
    return out;
  }

  repoMap(budgetChars: number): string {
    return this.hybrid ? buildRepoMap(this.hybrid, budgetChars) : "";
  }
}
