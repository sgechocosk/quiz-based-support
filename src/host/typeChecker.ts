import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type * as TS from "typescript";
import type { TypeChecker, TypeDiagnostic } from "../core/ports";
import { toPosix } from "../core/text";

type TsModule = typeof TS;

/**
 * 型検査に使う TypeScript を探す。
 * 信頼済みのワークスペースならその node_modules(プロジェクトと同じ版)、無ければ VS Code 同梱のもの。
 * 信頼していないワークスペースの node_modules は実行しない(任意のコードを読み込むことになるため)。
 */
export function loadTypeScript(root: string, appRoot: string | undefined, trusted: boolean): TsModule | undefined {
  const bases: string[] = [];
  if (trusted) {
    bases.push(path.join(root, "package.json"));
  }
  if (appRoot) {
    bases.push(path.join(appRoot, "extensions", "package.json"));
  }
  for (const base of bases) {
    try {
      const ts = createRequire(base)("typescript") as TsModule;
      if (typeof ts?.createLanguageService === "function") {
        return ts;
      }
    } catch {
      // 次の候補へ
    }
  }
  return undefined;
}

/** 依存元(import しているファイル)を含めて型検査するファイル数の上限 */
const MAX_TARGETS = 80;
/** これより大きいプロジェクトでは型検査しない(待ち時間が長くなりすぎるため) */
const MAX_PROGRAM_FILES = 4000;
const TS_LIKE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

/**
 * TypeScript の言語サービスで、変更を重ねた状態の型エラーを調べる。
 * tsconfig.json / jsconfig.json がワークスペース直下にあるときだけ動く。
 */
export class TsTypeChecker implements TypeChecker {
  private service?: TS.LanguageService;
  private options?: TS.CompilerOptions;
  private fileNames: string[] = [];
  private failed = false;
  /** 正規化した絶対パス → 重ねる内容 */
  private overlay = new Map<string, { file: string; text: string; version: number }>();
  private versionSeq = 0;
  /** 変更前の型エラー(ファイルごと)。ディスクの内容が変わったら捨てる */
  private baseline = new Map<string, TypeDiagnostic[]>();
  private baselineStamp = "";
  private importCache = new Map<string, { stamp: string; resolved: string[] }>();

  constructor(
    private readonly ts: TsModule,
    private readonly root: string,
  ) {}

  private canon(file: string): string {
    const p = toPosix(path.resolve(file));
    return this.ts.sys.useCaseSensitiveFileNames ? p : p.toLowerCase();
  }

  private relative(file: string): string | undefined {
    const rel = path.relative(this.root, file);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      return undefined;
    }
    return toPosix(rel);
  }

  private stamp(file: string): string {
    try {
      return String(fs.statSync(file).mtimeMs);
    } catch {
      return "0";
    }
  }

  private init(): boolean {
    if (this.service) {
      return true;
    }
    if (this.failed) {
      return false;
    }
    const ts = this.ts;
    const config =
      ts.findConfigFile(this.root, ts.sys.fileExists, "tsconfig.json") ?? ts.findConfigFile(this.root, ts.sys.fileExists, "jsconfig.json");
    // ワークスペースの外(親フォルダ)の設定は使わない
    if (!config || !this.relative(config)) {
      this.failed = true;
      return false;
    }
    const parsed = ts.getParsedCommandLineOfConfigFile(
      config,
      { noEmit: true },
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
    );
    if (!parsed || parsed.fileNames.length === 0 || parsed.fileNames.length > MAX_PROGRAM_FILES) {
      this.failed = true;
      return false;
    }
    this.options = { ...parsed.options, noEmit: true };
    this.fileNames = parsed.fileNames;
    const host: TS.LanguageServiceHost = {
      getScriptFileNames: () => {
        const created = [...this.overlay.values()].map((o) => o.file).filter((f) => TS_LIKE.test(f) && !ts.sys.fileExists(f));
        return [...this.fileNames, ...created];
      },
      getScriptVersion: (file) => {
        const o = this.overlay.get(this.canon(file));
        return o ? `o${o.version}` : this.stamp(file);
      },
      getScriptSnapshot: (file) => {
        const o = this.overlay.get(this.canon(file));
        const text = o ? o.text : ts.sys.readFile(file);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => this.root,
      getCompilationSettings: () => this.options!,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: (file) => this.overlay.has(this.canon(file)) || ts.sys.fileExists(file),
      readFile: (file) => this.overlay.get(this.canon(file))?.text ?? ts.sys.readFile(file),
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
    return true;
  }

  private setOverlay(changes: ReadonlyMap<string, string>): void {
    const next = new Map<string, { file: string; text: string; version: number }>();
    for (const [rel, text] of changes) {
      const file = toPosix(path.join(this.root, rel));
      const key = this.canon(file);
      const prev = this.overlay.get(key);
      next.set(key, { file, text, version: prev && prev.text === text ? prev.version : ++this.versionSeq });
    }
    this.overlay = next;
  }

  /** file が import しているファイル(正規化した絶対パス) */
  private importsOf(file: string): string[] {
    const stamp = this.stamp(file);
    const key = this.canon(file);
    const cached = this.importCache.get(key);
    if (cached && cached.stamp === stamp) {
      return cached.resolved;
    }
    const text = this.ts.sys.readFile(file) ?? "";
    const info = this.ts.preProcessFile(text, true, true);
    const resolved: string[] = [];
    for (const ref of info.importedFiles) {
      const r = this.ts.resolveModuleName(ref.fileName, file, this.options!, this.ts.sys).resolvedModule?.resolvedFileName;
      if (r) {
        resolved.push(this.canon(r));
      }
    }
    this.importCache.set(key, { stamp, resolved });
    return resolved;
  }

  /** 変更したファイルと、それを import しているファイル */
  private targets(changed: string[]): string[] {
    const changedKeys = new Set(changed.map((f) => this.canon(f)));
    const out = [...changed];
    for (const file of this.fileNames) {
      if (out.length >= MAX_TARGETS) {
        break;
      }
      if (!changedKeys.has(this.canon(file)) && this.importsOf(file).some((i) => changedKeys.has(i))) {
        out.push(file);
      }
    }
    return out;
  }

  private diagnosticsOf(file: string): TypeDiagnostic[] {
    const service = this.service!;
    let list: TS.Diagnostic[];
    try {
      list = [...service.getSyntacticDiagnostics(file), ...service.getSemanticDiagnostics(file)];
    } catch {
      return []; // プログラムに含まれないファイル(設定の対象外など)
    }
    const out: TypeDiagnostic[] = [];
    for (const d of list) {
      if (d.category !== this.ts.DiagnosticCategory.Error) {
        continue;
      }
      const rel = this.relative(d.file?.fileName ?? file);
      if (!rel) {
        continue;
      }
      const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 1;
      const message = this.ts.flattenDiagnosticMessageText(d.messageText, "\n").split("\n")[0] ?? "";
      out.push({ path: rel, line, code: String(d.code), message });
    }
    return out;
  }

  /** ディスクの内容が変わっていないかの目印(変わっていたら変更前の結果を捨てる) */
  private diskStamp(): string {
    let sum = 0;
    for (const f of this.fileNames) {
      sum = (sum + Number(this.stamp(f))) % 1e15;
    }
    return `${this.fileNames.length}:${sum}`;
  }

  async check(
    changes: ReadonlyMap<string, string>,
    signal?: AbortSignal,
  ): Promise<{ before: TypeDiagnostic[]; after: TypeDiagnostic[] } | undefined> {
    try {
      if (!this.init()) {
        return undefined;
      }
      const changed = [...changes.keys()].map((rel) => toPosix(path.join(this.root, rel))).filter((f) => TS_LIKE.test(f));
      if (changed.length === 0) {
        return { before: [], after: [] };
      }
      const targets = this.targets(changed);
      const stamp = this.diskStamp();
      if (stamp !== this.baselineStamp) {
        this.baseline.clear();
        this.baselineStamp = stamp;
      }
      // 変更前: 重ねない状態で、まだ調べていないファイルだけ調べる
      const missing = targets.filter((f) => !this.baseline.has(this.canon(f)) && this.ts.sys.fileExists(f));
      if (missing.length > 0) {
        this.setOverlay(new Map());
        for (const f of missing) {
          if (signal?.aborted) {
            return undefined;
          }
          this.baseline.set(this.canon(f), this.diagnosticsOf(f));
        }
      }
      const before = targets.flatMap((f) => this.baseline.get(this.canon(f)) ?? []);
      // 変更後
      this.setOverlay(changes);
      const after: TypeDiagnostic[] = [];
      for (const f of targets) {
        if (signal?.aborted) {
          return undefined;
        }
        after.push(...this.diagnosticsOf(f));
      }
      return { before, after };
    } catch {
      return undefined;
    }
  }
}
