import * as path from "node:path";
import * as TreeSitter from "web-tree-sitter";
import { languageForPath, type AstLanguage, type AstNode, type ParsedTree, type ParserProvider } from "../core/chunker";
import type { SyntaxChecker } from "../core/ports";

const WASM: Record<AstLanguage, string> = {
  javascript: "tree-sitter-javascript.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  java: "tree-sitter-java.wasm",
};

/** web-tree-sitter(WASM)で構文木を作る。チャンク分割と、生成コードの構文チェックの両方に使う。 */
export class TreeSitterProvider implements ParserProvider, SyntaxChecker {
  private initPromise: Promise<void> | undefined;
  private readonly languages = new Map<AstLanguage, Promise<TreeSitter.Language>>();

  constructor(private readonly extensionPath: string) {}

  private parserDir(): string {
    return path.join(this.extensionPath, "resources", "parsers");
  }

  private ensureInit(): Promise<void> {
    this.initPromise ??= TreeSitter.Parser.init({
      locateFile: () => path.join(this.parserDir(), "web-tree-sitter.wasm"),
    });
    return this.initPromise;
  }

  private loadLanguage(language: AstLanguage): Promise<TreeSitter.Language> {
    let p = this.languages.get(language);
    if (!p) {
      p = TreeSitter.Language.load(path.join(this.parserDir(), WASM[language]));
      this.languages.set(language, p);
    }
    return p;
  }

  async parse(language: AstLanguage, text: string): Promise<ParsedTree | undefined> {
    await this.ensureInit();
    const lang = await this.loadLanguage(language);
    const parser = new TreeSitter.Parser();
    try {
      parser.setLanguage(lang);
      const tree = parser.parse(text);
      if (!tree) {
        parser.delete();
        return undefined;
      }
      const root = tree.rootNode as unknown as AstNode & { hasError: boolean | (() => boolean) };
      const hasError = typeof root.hasError === "function" ? root.hasError() : Boolean(root.hasError);
      return {
        root,
        hasError,
        dispose: () => {
          tree.delete();
          parser.delete();
        },
      };
    } catch (error) {
      parser.delete();
      throw error;
    }
  }

  async isValid(filePath: string, text: string): Promise<boolean | undefined> {
    const language = languageForPath(filePath)?.ast;
    if (!language) {
      return undefined;
    }
    try {
      const tree = await this.parse(language, text);
      if (!tree) {
        return undefined;
      }
      try {
        return !tree.hasError;
      } finally {
        tree.dispose();
      }
    } catch {
      return undefined;
    }
  }
}
