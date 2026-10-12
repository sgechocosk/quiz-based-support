import { languageForPath } from "./chunker";
import { globToRegExp } from "./ignore";
import type { LspPort, SymbolInfo, ToolDefinition, WorkspacePort } from "./ports";
import { numberLines, splitLines, toPosix, truncate } from "./text";
import type { ChunkRecord, SearchHit } from "./types";

export interface CodeIndex {
  hasChunks(): boolean;
  search(
    query: string,
    options: { k: number; minSimilarity: number },
  ): Promise<{ hits: SearchHit[]; semantic: boolean; note?: string }>;
  fileChunks(path: string): ChunkRecord[];
  findSymbols(query: string, limit?: number): ChunkRecord[];
}

/** エージェントが「実際に見た」コード行を蓄積する。クイズ生成はこの内容だけを根拠にする。 */
export class EvidenceStore {
  private readonly files = new Map<string, Map<number, string>>();
  private readonly recency: string[] = [];

  add(path: string, startLine: number, lines: string[]): void {
    let map = this.files.get(path);
    if (!map) {
      map = new Map();
      this.files.set(path, map);
    }
    lines.forEach((text, i) => map!.set(startLine + i, text));
    const at = this.recency.indexOf(path);
    if (at >= 0) {
      this.recency.splice(at, 1);
    }
    this.recency.push(path);
  }

  paths(): string[] {
    return [...this.recency];
  }

  isEmpty(): boolean {
    return this.files.size === 0;
  }

  /** 新しく見たファイルから優先して、文字数予算内で行番号付きに整形する。 */
  render(maxChars: number): string {
    const sections: string[] = [];
    let used = 0;
    for (const path of [...this.recency].reverse()) {
      const map = this.files.get(path)!;
      const nums = [...map.keys()].sort((a, b) => a - b);
      const blocks: string[] = [];
      let blockStart = -1;
      let prev = -2;
      let buf: string[] = [];
      const close = (): void => {
        if (buf.length > 0) {
          blocks.push(numberLines(buf, blockStart));
          buf = [];
        }
      };
      for (const n of nums) {
        if (n !== prev + 1) {
          close();
          blockStart = n;
        }
        buf.push(map.get(n)!);
        prev = n;
      }
      close();
      const section = `### ${path}\n${blocks.join("\n…\n")}`;
      if (used + section.length > maxChars && sections.length > 0) {
        break;
      }
      sections.push(truncate(section, Math.max(maxChars - used, 2000)));
      used += section.length;
    }
    return sections.join("\n\n");
  }
}

export interface ToolContext {
  ws: WorkspacePort;
  lsp?: LspPort;
  index: CodeIndex;
  evidence: EvidenceStore;
  minSimilarity: number;
  /** 1回の応答に含める最大文字数 */
  maxOutputChars?: number;
}

const MAX_READ_LINES = 250;
const MAX_GREP_FILES = 4000;
const MAX_FILE_BYTES = 300_000;

export const TOOL_DEFS: ToolDefinition[] = [
  {
    name: "search_code",
    description:
      "ワークスペースのコードをハイブリッド検索(キーワードBM25 + 意味ベクトル)する。概念的な探索に向く。クエリには関数名・変数名などの識別子や英語のキーワードを含めると精度が上がる。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "検索クエリ(識別子・英語キーワード推奨)" },
        k: { type: "integer", description: "返す件数(既定6、最大10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "grep",
    description:
      "正規表現でワークスペース内を厳密に検索する。特定の名前・文字列・エラーメッセージの全出現箇所を知りたいときに使う。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript正規表現" },
        glob: { type: "string", description: "対象ファイルの絞り込み(例: src/**/*.ts, *.java)" },
        ignoreCase: { type: "boolean" },
        maxResults: { type: "integer", description: "既定40、最大100" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "read_file",
    description: `ファイルを行番号付きで読む(1回最大${MAX_READ_LINES}行)。クイズの根拠にできるのは、ここで読んだ行だけ。`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "ワークスペース相対パス" },
        startLine: { type: "integer", description: "既定1" },
        endLine: { type: "integer" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description: "ファイル一覧(除外設定適用済み)。globで絞り込める。",
    parameters: {
      type: "object",
      properties: { glob: { type: "string", description: "例: src/**/*.ts" } },
    },
  },
  {
    name: "outline",
    description: "1ファイルのシンボル(クラス・関数・メソッド)一覧と行範囲。構造を素早く把握するのに使う。",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "find_symbols",
    description: "名前の一部からシンボル定義を探す(言語サーバ / インデックス)。",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "find_references",
    description: "シンボルの参照箇所(呼び出し元など)を言語サーバで調べる。取得できなければ単語境界grepに切り替える。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "シンボルが現れるファイル" },
        symbol: { type: "string" },
        line: { type: "integer", description: "同名が複数ある場合の行番号(任意)" },
      },
      required: ["path", "symbol"],
    },
  },
  {
    name: "find_definition",
    description: "シンボルの定義位置を言語サーバで調べる。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        symbol: { type: "string" },
        line: { type: "integer" },
      },
      required: ["path", "symbol"],
    },
  },
];

// ---------- ヘルパ ----------

export function normalizeRelPath(input: string): string | undefined {
  let p = toPosix(String(input ?? "")).trim().replace(/^\.\//, "");
  if (!p || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split("/").includes("..")) {
    return undefined;
  }
  p = p.replace(/\/+/g, "/");
  return p;
}

export function matchGlob(glob: string | undefined, filePath: string): boolean {
  if (!glob) {
    return true;
  }
  const g = toPosix(glob);
  if (!g.includes("/")) {
    return globToRegExp(g).test(filePath.split("/").pop() ?? filePath);
  }
  return globToRegExp(g).test(filePath);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : fallback;
}

async function readFileLines(ctx: ToolContext, p: string): Promise<string[] | undefined> {
  try {
    return splitLines(await ctx.ws.readText(p));
  } catch {
    return undefined;
  }
}

async function suggestPaths(ctx: ToolContext, wanted: string): Promise<string> {
  const base = wanted.split("/").pop()!.toLowerCase();
  const files = await ctx.ws.listFiles();
  const near = files.filter((f) => f.path.toLowerCase().endsWith(base) || f.path.toLowerCase().includes(base)).slice(0, 5);
  return near.length > 0 ? ` 近いパス: ${near.map((f) => f.path).join(", ")}` : "";
}

interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

async function grepFiles(
  ctx: ToolContext,
  regex: RegExp,
  glob: string | undefined,
  limit: number,
): Promise<{ matches: GrepMatch[]; truncated: boolean }> {
  const files = (await ctx.ws.listFiles())
    .filter((f) => f.size <= MAX_FILE_BYTES && matchGlob(glob, f.path) && (languageForPath(f.path) || glob))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, MAX_GREP_FILES);
  const matches: GrepMatch[] = [];
  for (const f of files) {
    const lines = await readFileLines(ctx, f.path);
    if (!lines) {
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (regex.test(lines[i]!)) {
        matches.push({ path: f.path, line: i + 1, text: truncate(lines[i]!.trim(), 200) });
        if (matches.length >= limit) {
          return { matches, truncated: true };
        }
      }
    }
  }
  return { matches, truncated: false };
}

function innermostSymbol(symbols: SymbolInfo[], line: number): SymbolInfo | undefined {
  let best: SymbolInfo | undefined;
  for (const s of symbols) {
    if (s.startLine <= line && line <= s.endLine && /function|method|constructor|class/i.test(s.kind)) {
      if (!best || s.endLine - s.startLine < best.endLine - best.startLine) {
        best = s;
      }
    }
  }
  return best;
}

/** シンボル名からLSP問い合わせ用の位置(1始まりの行 / 0始まりの文字)を求める。 */
export async function locateSymbol(
  ctx: ToolContext,
  filePath: string,
  symbol: string,
  line?: number,
): Promise<{ line: number; character: number } | undefined> {
  const lines = await readFileLines(ctx, filePath);
  if (!lines) {
    return undefined;
  }
  const word = new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}(?![\\w$])`);
  if (line && line >= 1 && line <= lines.length) {
    const idx = lines[line - 1]!.search(word);
    if (idx >= 0) {
      return { line, character: idx };
    }
  }
  if (ctx.lsp) {
    try {
      const sym = (await ctx.lsp.documentSymbols(filePath)).find((s) => s.name === symbol);
      if (sym) {
        return { line: sym.nameLine, character: sym.nameChar };
      }
    } catch {
      // LSPが使えなければテキスト走査へ
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i]!.search(word);
    if (idx >= 0) {
      return { line: i + 1, character: idx };
    }
  }
  return undefined;
}

// ---------- 各ツール ----------

async function searchCode(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) {
    return "エラー: query が空です。";
  }
  if (!ctx.index.hasChunks()) {
    return "インデックスが空です。grep / list_files / read_file を使ってください。";
  }
  const k = asInt(args.k, 6, 1, 10);
  const { hits, semantic, note } = await ctx.index.search(query, { k, minSimilarity: ctx.minSimilarity });
  if (hits.length === 0) {
    return `「${query}」に該当するコードは見つかりませんでした。別のキーワードや grep を試してください。`;
  }
  const out: string[] = [`検索結果(${semantic ? "キーワード+意味" : "キーワードのみ"})${note ? " ※" + note : ""}`];
  const cache = new Map<string, string[] | undefined>();
  for (const [i, hit] of hits.entries()) {
    const c = hit.chunk;
    if (!cache.has(c.file)) {
      cache.set(c.file, await readFileLines(ctx, c.file));
    }
    const lines = cache.get(c.file);
    const body = lines ? lines.slice(c.startLine - 1, c.endLine) : splitLines(c.text);
    const shown = body.slice(0, 14);
    const label = [c.kind, c.scope, c.symbols.slice(0, 3).join(",")].filter(Boolean).join(" ");
    out.push(
      `[${i + 1}] ${c.file}:${c.startLine}-${c.endLine} (${label})${hit.similarity !== undefined ? ` sim=${hit.similarity.toFixed(2)}` : ""}\n${numberLines(shown, c.startLine)}${body.length > shown.length ? "\n  …" : ""}`,
    );
    if (i < 3) {
      ctx.evidence.add(c.file, c.startLine, body.slice(0, 60));
    }
  }
  return out.join("\n\n");
}

async function grepTool(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const pattern = String(args.pattern ?? "");
  if (!pattern) {
    return "エラー: pattern が空です。";
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, args.ignoreCase ? "i" : "");
  } catch (error) {
    return `エラー: 正規表現が不正です: ${error instanceof Error ? error.message : String(error)}`;
  }
  const limit = asInt(args.maxResults, 40, 1, 100);
  const { matches, truncated } = await grepFiles(ctx, regex, args.glob ? String(args.glob) : undefined, limit);
  if (matches.length === 0) {
    return `「${pattern}」に一致する行はありません。`;
  }
  return (
    matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") +
    (truncated ? `\n…(上限${limit}件で打ち切り。pattern/globを絞ってください)` : "")
  );
}

async function readFileTool(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const p = normalizeRelPath(String(args.path ?? ""));
  if (!p) {
    return "エラー: path はワークスペース相対パスで指定してください。";
  }
  const lines = await readFileLines(ctx, p);
  if (!lines) {
    return `エラー: ファイルを読めません: ${p}.${await suggestPaths(ctx, p)}`;
  }
  const start = asInt(args.startLine, 1, 1, Math.max(lines.length, 1));
  const requestedEnd = asInt(args.endLine, start + MAX_READ_LINES - 1, start, lines.length);
  const end = Math.min(requestedEnd, start + MAX_READ_LINES - 1, lines.length);
  const slice = lines.slice(start - 1, end);
  ctx.evidence.add(p, start, slice);
  const more = end < lines.length ? `\n(全${lines.length}行。続きは startLine=${end + 1} で読めます)` : "";
  return `${p} (L${start}-${end} / 全${lines.length}行)\n${numberLines(slice, start)}${more}`;
}

async function listFilesTool(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const glob = args.glob ? String(args.glob) : undefined;
  const files = (await ctx.ws.listFiles())
    .filter((f) => matchGlob(glob, f.path))
    .map((f) => f.path)
    .sort();
  if (files.length === 0) {
    return "該当するファイルはありません。";
  }
  const shown = files.slice(0, 200);
  return shown.join("\n") + (files.length > shown.length ? `\n…他${files.length - shown.length}件` : "");
}

async function outlineTool(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const p = normalizeRelPath(String(args.path ?? ""));
  if (!p) {
    return "エラー: path が不正です。";
  }
  if (ctx.lsp) {
    try {
      const syms = await ctx.lsp.documentSymbols(p);
      if (syms.length > 0) {
        return syms
          .sort((a, b) => a.startLine - b.startLine)
          .map((s) => `${s.container ? "  " : ""}${s.kind} ${s.name}  L${s.startLine}-${s.endLine}`)
          .join("\n");
      }
    } catch {
      // インデックスから代替
    }
  }
  const chunks = ctx.index.fileChunks(p);
  if (chunks.length === 0) {
    return `シンボル情報がありません: ${p}(read_file で直接読んでください)`;
  }
  return chunks
    .map((c) => `${c.kind} ${c.symbols.join(", ") || "(無名)"}  L${c.startLine}-${c.endLine}${c.scope ? `  in ${c.scope}` : ""}`)
    .join("\n");
}

async function findSymbolsTool(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) {
    return "エラー: query が空です。";
  }
  if (ctx.lsp) {
    try {
      const syms = await ctx.lsp.workspaceSymbols(query);
      if (syms.length > 0) {
        return syms
          .slice(0, 30)
          .map((s) => `${s.kind} ${s.name}  ${s.path}:${s.startLine}${s.container ? `  in ${s.container}` : ""}`)
          .join("\n");
      }
    } catch {
      // インデックスから代替
    }
  }
  const found = ctx.index.findSymbols(query, 30);
  if (found.length === 0) {
    return `「${query}」を含むシンボルは見つかりませんでした。`;
  }
  return found.map((c) => `${c.kind} ${c.symbols.join(", ")}  ${c.file}:${c.startLine}-${c.endLine}`).join("\n");
}

async function lspLookup(
  ctx: ToolContext,
  args: Record<string, unknown>,
  mode: "references" | "definition",
): Promise<string> {
  const p = normalizeRelPath(String(args.path ?? ""));
  const symbol = String(args.symbol ?? "").trim();
  if (!p || !symbol) {
    return "エラー: path と symbol を指定してください。";
  }
  const pos = await locateSymbol(ctx, p, symbol, args.line ? asInt(args.line, 0, 0, 1_000_000) : undefined);
  if (!pos) {
    return `エラー: ${p} に「${symbol}」が見つかりません。`;
  }
  let locations: Array<{ path: string; line: number; character: number }> = [];
  if (ctx.lsp) {
    try {
      locations =
        mode === "references"
          ? await ctx.lsp.references(p, pos.line, pos.character)
          : await ctx.lsp.definition(p, pos.line, pos.character);
    } catch {
      locations = [];
    }
  }
  if (locations.length === 0) {
    if (mode === "definition") {
      return "言語サーバから定義を取得できませんでした(該当言語の拡張が未導入/起動待ちの可能性)。find_symbols か grep を試してください。";
    }
    const { matches } = await grepFiles(ctx, new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}(?![\\w$])`), undefined, 40);
    return (
      "言語サーバから参照を取得できなかったため、単語境界grepで代替しました(定義・コメント・同名の別シンボルも含みます):\n" +
      matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n")
    );
  }
  const out: string[] = [];
  const fileCache = new Map<string, string[] | undefined>();
  const symCache = new Map<string, SymbolInfo[]>();
  for (const loc of locations.slice(0, 40)) {
    if (!fileCache.has(loc.path)) {
      fileCache.set(loc.path, await readFileLines(ctx, loc.path));
    }
    const text = fileCache.get(loc.path)?.[loc.line - 1]?.trim() ?? "";
    let enclosing = "";
    if (mode === "references" && ctx.lsp && symCache.size < 10) {
      if (!symCache.has(loc.path)) {
        symCache.set(loc.path, await ctx.lsp.documentSymbols(loc.path).catch(() => []));
      }
      const s = innermostSymbol(symCache.get(loc.path) ?? [], loc.line);
      enclosing = s ? `  [in ${s.name}]` : "";
    }
    out.push(`${loc.path}:${loc.line}: ${truncate(text, 160)}${enclosing}`);
  }
  if (locations.length > 40) {
    out.push(`…他${locations.length - 40}件`);
  }
  return out.join("\n");
}

export async function executeTool(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return "エラー: 引数がJSONとして不正です。";
  }
  try {
    let result: string;
    switch (name) {
      case "search_code":
        result = await searchCode(ctx, args);
        break;
      case "grep":
        result = await grepTool(ctx, args);
        break;
      case "read_file":
        result = await readFileTool(ctx, args);
        break;
      case "list_files":
        result = await listFilesTool(ctx, args);
        break;
      case "outline":
        result = await outlineTool(ctx, args);
        break;
      case "find_symbols":
        result = await findSymbolsTool(ctx, args);
        break;
      case "find_references":
        result = await lspLookup(ctx, args, "references");
        break;
      case "find_definition":
        result = await lspLookup(ctx, args, "definition");
        break;
      default:
        result = `エラー: 未知のツールです: ${name}。使えるのは ${TOOL_DEFS.map((t) => t.name).join(", ")} です。`;
    }
    return truncate(result, ctx.maxOutputChars ?? 7000, "\n…(出力が長いため省略)");
  } catch (error) {
    return `エラー: ツール実行に失敗しました: ${error instanceof Error ? error.message : String(error)}`;
  }
}
