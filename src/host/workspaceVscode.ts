import * as path from "node:path";
import * as vscode from "vscode";
import { supportedExtensions } from "../core/chunker";
import { DEFAULT_IGNORES, IgnoreFilter } from "../core/ignore";
import type { FileInfo, LocationInfo, LspPort, SymbolInfo, WorkspacePort } from "../core/ports";
import { toPosix } from "../core/text";

/** VS Code のワークスペース(1フォルダ)を WorkspacePort として見せる。 */
export class VscodeWorkspace implements WorkspacePort {
  readonly id: string;
  private filter = new IgnoreFilter(DEFAULT_IGNORES);

  constructor(readonly folder: vscode.WorkspaceFolder) {
    this.id = folder.uri.fsPath;
  }

  /** ルートの .gitignore を読み直す。 */
  async refreshIgnore(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.folder.uri, ".gitignore"));
      const lines = new TextDecoder("utf-8").decode(bytes).split("\n");
      this.filter = new IgnoreFilter([...DEFAULT_IGNORES, ...lines]);
    } catch {
      this.filter = new IgnoreFilter(DEFAULT_IGNORES);
    }
  }

  uriOf(relPath: string): vscode.Uri {
    return vscode.Uri.joinPath(this.folder.uri, relPath);
  }

  /** ワークスペース外ならundefined。 */
  relativeOf(uri: vscode.Uri): string | undefined {
    const rel = path.relative(this.folder.uri.fsPath, uri.fsPath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      return undefined;
    }
    return toPosix(rel);
  }

  async listFiles(): Promise<FileInfo[]> {
    const pattern = new vscode.RelativePattern(this.folder, `**/*.{${supportedExtensions().join(",")}}`);
    const uris = await vscode.workspace.findFiles(pattern, "**/node_modules/**");
    const targets = uris
      .map((uri) => ({ uri, rel: this.relativeOf(uri) }))
      .filter((t): t is { uri: vscode.Uri; rel: string } => !!t.rel && !this.filter.isIgnored(t.rel));
    const out: FileInfo[] = [];
    for (let i = 0; i < targets.length; i += 50) {
      const batch = await Promise.all(
        targets.slice(i, i + 50).map(async ({ uri, rel }) => {
          try {
            const st = await vscode.workspace.fs.stat(uri);
            return { path: rel, size: st.size, mtime: st.mtime } satisfies FileInfo;
          } catch {
            return undefined;
          }
        }),
      );
      out.push(...batch.filter((b): b is FileInfo => b !== undefined));
    }
    return out;
  }

  async stat(relPath: string): Promise<FileInfo | undefined> {
    if (this.filter.isIgnored(relPath)) {
      return undefined;
    }
    try {
      const st = await vscode.workspace.fs.stat(this.uriOf(relPath));
      return st.type & vscode.FileType.File ? { path: relPath, size: st.size, mtime: st.mtime } : undefined;
    } catch {
      return undefined;
    }
  }

  async readText(relPath: string): Promise<string> {
    const uri = this.uriOf(relPath);
    // 保存前の編集内容を優先する(画面に見えているコードと問題の根拠を一致させるため)
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (open) {
      return open.getText();
    }
    return new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(uri));
  }
}

/** 各言語拡張が提供する LSP 機能を、言語を問わず vscode.execute*Provider 経由で呼ぶ。 */
export class VscodeLsp implements LspPort {
  constructor(private readonly ws: VscodeWorkspace) {}

  private toInfo(
    uri: vscode.Uri,
    name: string,
    kind: vscode.SymbolKind,
    range: vscode.Range,
    selection: vscode.Range,
    container?: string,
  ): SymbolInfo | undefined {
    const rel = this.ws.relativeOf(uri);
    if (!rel) {
      return undefined;
    }
    return {
      name,
      kind: vscode.SymbolKind[kind] ?? "Symbol",
      path: rel,
      startLine: range.start.line + 1,
      endLine: range.end.line + 1,
      nameLine: selection.start.line + 1,
      nameChar: selection.start.character,
      container,
    };
  }

  async workspaceSymbols(query: string): Promise<SymbolInfo[]> {
    const result =
      (await vscode.commands.executeCommand<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", query)) ?? [];
    const out: SymbolInfo[] = [];
    for (const s of result) {
      const info = this.toInfo(s.location.uri, s.name, s.kind, s.location.range, s.location.range, s.containerName);
      if (info && !info.path.includes("node_modules/")) {
        out.push(info);
      }
    }
    return out;
  }

  async documentSymbols(relPath: string): Promise<SymbolInfo[]> {
    const uri = this.ws.uriOf(relPath);
    const result =
      (await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
        "vscode.executeDocumentSymbolProvider",
        uri,
      )) ?? [];
    const out: SymbolInfo[] = [];
    const walk = (list: vscode.DocumentSymbol[], container?: string): void => {
      for (const s of list) {
        const info = this.toInfo(uri, s.name, s.kind, s.range, s.selectionRange, container);
        if (info) {
          out.push(info);
        }
        walk(s.children, s.name);
      }
    };
    for (const s of result) {
      if ("children" in s) {
        walk([s]);
      } else {
        const info = this.toInfo(s.location.uri, s.name, s.kind, s.location.range, s.location.range, s.containerName);
        if (info) {
          out.push(info);
        }
      }
    }
    return out;
  }

  private mapLocations(list: Array<vscode.Location | vscode.LocationLink>): LocationInfo[] {
    const out: LocationInfo[] = [];
    for (const item of list) {
      const uri = "targetUri" in item ? item.targetUri : item.uri;
      const range = "targetUri" in item ? (item.targetSelectionRange ?? item.targetRange) : item.range;
      const rel = this.ws.relativeOf(uri);
      if (rel && !rel.includes("node_modules/")) {
        out.push({ path: rel, line: range.start.line + 1, character: range.start.character });
      }
    }
    return out;
  }

  async references(relPath: string, line: number, character: number): Promise<LocationInfo[]> {
    const result =
      (await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider",
        this.ws.uriOf(relPath),
        new vscode.Position(line - 1, character),
      )) ?? [];
    return this.mapLocations(result);
  }

  async definition(relPath: string, line: number, character: number): Promise<LocationInfo[]> {
    const result =
      (await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
        "vscode.executeDefinitionProvider",
        this.ws.uriOf(relPath),
        new vscode.Position(line - 1, character),
      )) ?? [];
    return this.mapLocations(result);
  }
}
