import * as ts from "typescript";
import type { AstNode, AstLanguage, ParsedTree, ParserProvider } from "../../../core/chunker";

const RENAMES: Record<string, string> = {
  variable_statement: "lexical_declaration",
  variable_declaration: "variable_declarator",
  method_declaration: "method_definition",
};

function snake(kind: ts.SyntaxKind): string {
  const name = ts.SyntaxKind[kind] ?? "unknown";
  const s = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return RENAMES[s] ?? s;
}

/** テスト専用: TypeScript コンパイラ API の AST を tree-sitter 互換の最小インターフェースに包む。 */
function wrap(node: ts.Node, sf: ts.SourceFile, full = true): AstNode {
  return {
    type: snake(node.kind),
    startIndex: full ? node.getFullStart() : node.getStart(sf),
    endIndex: node.getEnd(),
    get children() {
      return node.getChildren(sf).map((c) => wrap(c, sf));
    },
    childForFieldName(name: string) {
      const anyNode = node as unknown as Record<string, ts.Node | undefined>;
      const target = anyNode[name];
      return target && typeof target === "object" && "kind" in target ? wrap(target, sf, false) : null;
    },
  };
}

export class TsCompilerParser implements ParserProvider {
  async parse(_language: AstLanguage, text: string): Promise<ParsedTree | undefined> {
    const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const diagnostics = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
    return { root: wrap(sf, sf), hasError: diagnostics.length > 0, dispose: () => undefined };
  }
}
