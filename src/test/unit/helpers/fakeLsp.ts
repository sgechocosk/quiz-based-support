import type { LocationInfo, LspPort, SymbolInfo, WorkspacePort } from "../../../core/ports";
import { splitLines } from "../../../core/text";

/** テスト用の簡易LSP: `function name(` 宣言だけを正規表現で拾う。 */
export class FakeLsp implements LspPort {
  constructor(private readonly ws: WorkspacePort) {}

  async documentSymbols(path: string): Promise<SymbolInfo[]> {
    const lines = splitLines(await this.ws.readText(path));
    const out: SymbolInfo[] = [];
    lines.forEach((text, i) => {
      const m = /^(?:export\s+)?function\s+(\w+)\s*\(/.exec(text);
      if (m) {
        let end = i;
        while (end < lines.length && lines[end] !== "}") {
          end++;
        }
        out.push({
          name: m[1]!,
          kind: "Function",
          path,
          startLine: i + 1,
          endLine: end + 1,
          nameLine: i + 1,
          nameChar: text.indexOf(m[1]!),
        });
      }
    });
    return out;
  }

  async workspaceSymbols(query: string): Promise<SymbolInfo[]> {
    const all: SymbolInfo[] = [];
    for (const f of await this.ws.listFiles()) {
      if (/\.(ts|js)$/.test(f.path)) {
        all.push(...(await this.documentSymbols(f.path)));
      }
    }
    return all.filter((s) => s.name.toLowerCase().includes(query.toLowerCase()));
  }

  private async wordAt(path: string, line: number, character: number): Promise<string | undefined> {
    const text = splitLines(await this.ws.readText(path))[line - 1] ?? "";
    const m = /[\w$]*$/.exec(text.slice(0, character + 1));
    const n = /^[\w$]*/.exec(text.slice(character + 1));
    const word = (m?.[0] ?? "") + (n?.[0] ?? "");
    return word || undefined;
  }

  async references(path: string, line: number, character: number): Promise<LocationInfo[]> {
    const word = await this.wordAt(path, line, character);
    if (!word) {
      return [];
    }
    const re = new RegExp(`(?<![\\w$])${word}(?![\\w$])`, "g");
    const out: LocationInfo[] = [];
    for (const f of await this.ws.listFiles()) {
      if (!/\.(ts|js)$/.test(f.path)) {
        continue;
      }
      splitLines(await this.ws.readText(f.path)).forEach((text, i) => {
        for (const m of text.matchAll(re)) {
          out.push({ path: f.path, line: i + 1, character: m.index! });
        }
      });
    }
    return out;
  }

  async definition(path: string, line: number, character: number): Promise<LocationInfo[]> {
    const word = await this.wordAt(path, line, character);
    if (!word) {
      return [];
    }
    return (await this.workspaceSymbols(word))
      .filter((s) => s.name === word)
      .map((s) => ({ path: s.path, line: s.nameLine, character: s.nameChar }));
  }
}
