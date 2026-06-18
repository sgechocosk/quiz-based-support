import * as crypto from "node:crypto";
import * as path from "node:path";
import OpenAI from "openai";
import * as vscode from "vscode";
import * as TreeSitter from "web-tree-sitter";
import { LocalIndex } from "vectra";

type SupportedLanguage =
  | "javascript"
  | "typescript"
  | "tsx"
  | "java"
  | "html"
  | "css";
type MetadataValue = string | number | boolean;

type CodeChunkMetadata = Record<string, MetadataValue> & {
  workspaceId: string;
  filePath: string;
  language: string;
  kind: string;
  symbolName: string;
  startLine: number;
  endLine: number;
  signature: string;
};

interface CodeChunk {
  id: string;
  embeddingText: string;
  metadata: CodeChunkMetadata;
  tokenCount: number;
}

interface IndexPreparationSummary {
  workspaceId: string;
  files: number;
  chunks: number;
  tokens: number;
  chunkPreview: CodeChunk[];
}

interface SearchHit {
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  kind: string;
  symbolName: string;
  score: number;
  snippet: string;
}

export class WorkspaceVectorSearchService {
  private static parserInitPromise: Promise<void> | undefined;
  private static languageCache = new Map<
    SupportedLanguage,
    Promise<TreeSitter.Language>
  >();
  private static tokenEncoderPromise:
    | Promise<{ encode(text: string): number[] }>
    | undefined;

  private readonly workspaceFolder: vscode.WorkspaceFolder;
  private readonly indexFolder: string;
  private readonly index: LocalIndex<CodeChunkMetadata>;
  private pendingSummary?: IndexPreparationSummary;

  constructor(private readonly context: vscode.ExtensionContext) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error("ワークスペースフォルダが見つかりません。");
    }

    this.workspaceFolder = workspaceFolder;
    const workspaceId = this.getWorkspaceId();
    this.indexFolder = path.join(
      context.globalStorageUri.fsPath,
      "vector-index",
      workspaceId,
    );
    this.index = new LocalIndex<CodeChunkMetadata>(this.indexFolder);
  }

  public async getStatus(): Promise<{
    ready: boolean;
    summary?: IndexPreparationSummary;
  }> {
    if (await this.index.isIndexCreated()) {
      return { ready: true };
    }

    return { ready: false, summary: await this.prepareIndexSummary() };
  }

  public async buildIndex(
    force = false,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
  ): Promise<void> {
    const summary = this.pendingSummary ?? (await this.prepareIndexSummary());
    const apiKey = await this.context.secrets.get("openai-api-key");
    if (!apiKey) {
      throw new Error("OpenAI APIキーが設定されていません。");
    }

    if (force && (await this.index.isIndexCreated())) {
      await this.index.deleteIndex();
    }

    if (!(await this.index.isIndexCreated())) {
      await this.index.createIndex({
        version: 1,
        metadata_config: {
          indexed: [
            "workspaceId",
            "filePath",
            "language",
            "kind",
            "symbolName",
            "startLine",
            "endLine",
          ],
        },
      });
    }

    const client = new OpenAI({ apiKey });
    const batchSize = 32;

    for (
      let start = 0;
      start < summary.chunkPreview.length;
      start += batchSize
    ) {
      const batch = summary.chunkPreview.slice(start, start + batchSize);
      progress?.report({
        message: `埋め込み生成中 (${Math.min(start + batch.length, summary.chunkPreview.length)}/${summary.chunkPreview.length})`,
      });

      const response = await client.embeddings.create({
        model: "text-embedding-3-small",
        input: batch.map((chunk) => chunk.embeddingText),
      });

      const items = batch.map((chunk, index) => ({
        id: chunk.id,
        vector: response.data[index]?.embedding ?? [],
        metadata: chunk.metadata,
      }));

      await this.index.batchInsertItems(items);
    }

    this.pendingSummary = undefined;
  }

  public async search(query: string): Promise<SearchHit[]> {
    if (!(await this.index.isIndexCreated())) {
      throw new Error("先にワークスペースのベクトル化を完了してください。");
    }

    const apiKey = await this.context.secrets.get("openai-api-key");
    if (!apiKey) {
      throw new Error("OpenAI APIキーが設定されていません。");
    }

    const client = new OpenAI({ apiKey });
    const response = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });

    const vector = response.data[0]?.embedding ?? [];
    const results = await this.index.queryItems(vector, query, 5);

    const hits: SearchHit[] = [];
    for (const result of results) {
      const metadata = result.item.metadata;
      const snippet = await this.readSnippet(
        metadata.filePath,
        metadata.startLine,
        metadata.endLine,
      );
      hits.push({
        filePath: metadata.filePath,
        startLine: metadata.startLine,
        endLine: metadata.endLine,
        language: metadata.language,
        kind: metadata.kind,
        symbolName: metadata.symbolName,
        score: result.score,
        snippet,
      });
    }

    return hits;
  }

  public formatSearchResults(query: string, hits: SearchHit[]): string {
    if (hits.length === 0) {
      return `"${query}" に一致するコードは見つかりませんでした。`;
    }

    return [
      `"${query}" に対する検索結果です。`,
      "",
      ...hits.map((hit, index) => {
        const header = `[${index + 1}] ${hit.filePath}:${hit.startLine}-${hit.endLine} (${hit.kind} ${hit.symbolName}, score=${hit.score.toFixed(3)})`;
        return `${header}\n${hit.snippet}`;
      }),
    ].join("\n");
  }

  public async getReadyMessage(): Promise<string> {
    const stats = await this.index.getIndexStats();
    return `ベクトルDBは保存済みです。${stats.items}件のチャンクが検索可能です。`;
  }

  public async prepareIndexSummary(
    force = false,
  ): Promise<IndexPreparationSummary> {
    if (force) {
      this.pendingSummary = undefined;
    }
    if (this.pendingSummary) {
      return this.pendingSummary;
    }

    await this.ensureParserInitialized();
    const files = await this.findWorkspaceFiles();
    const chunkPreview: CodeChunk[] = [];
    let tokenTotal = 0;

    for (const file of files) {
      const text = await this.readFileText(file);
      const chunks = await this.extractChunks(file, text);
      for (const chunk of chunks) {
        chunkPreview.push(chunk);
        tokenTotal += chunk.tokenCount;
      }
    }

    this.pendingSummary = {
      workspaceId: this.getWorkspaceId(),
      files: files.length,
      chunks: chunkPreview.length,
      tokens: tokenTotal,
      chunkPreview,
    };

    return this.pendingSummary;
  }

  private async ensureParserInitialized(): Promise<void> {
    if (!WorkspaceVectorSearchService.parserInitPromise) {
      WorkspaceVectorSearchService.parserInitPromise = TreeSitter.Parser.init({
        locateFile: () =>
          path.join(
            this.context.extensionUri.fsPath,
            "resources",
            "parsers",
            "web-tree-sitter.wasm",
          ),
      });
    }

    await WorkspaceVectorSearchService.parserInitPromise;
  }

  private static async getTokenEncoder(): Promise<{
    encode(text: string): number[];
  }> {
    if (!WorkspaceVectorSearchService.tokenEncoderPromise) {
      WorkspaceVectorSearchService.tokenEncoderPromise =
        import("js-tiktoken").then(({ encodingForModel }) =>
          encodingForModel("text-embedding-3-small"),
        );
    }

    return WorkspaceVectorSearchService.tokenEncoderPromise;
  }

  private async extractChunks(
    file: vscode.Uri,
    text: string,
  ): Promise<CodeChunk[]> {
    const language = this.getSupportedLanguage(file);
    if (!language) return [];

    if (language === "html" || language === "css") {
      return this.extractLineBasedChunks(file, text, language);
    }

    const parser = new TreeSitter.Parser();
    try {
      parser.setLanguage(await this.loadLanguage(language));
      const tree = parser.parse(text);
      if (!tree) {
        return [];
      }

      const candidates = this.findCandidateNodes(tree.rootNode, language);
      const workspaceId = this.getWorkspaceId();
      const relativePath = this.relativePath(file);
      const nodes = candidates.length > 0 ? candidates : [tree.rootNode];
      const results: CodeChunk[] = [];

      for (const [index, node] of nodes.entries()) {
        const sourceText = text.slice(node.startIndex, node.endIndex).trim();
        if (!sourceText) {
          continue;
        }

        const kind = this.getChunkKind(node, language);
        const symbolName = this.getNodeName(node, kind);
        const signature = sourceText.split(/\r?\n/, 1)[0]?.trim() ?? symbolName;
        const embeddingText = [
          `file: ${relativePath}`,
          `symbol: ${symbolName}`,
          `kind: ${kind}`,
          sourceText,
        ].join("\n");
        const tokenEncoder =
          await WorkspaceVectorSearchService.getTokenEncoder();

        results.push({
          id: `${workspaceId}:${relativePath}:${node.startPosition.row + 1}-${node.endPosition.row + 1}:${kind}:${index}`,
          embeddingText,
          tokenCount: tokenEncoder.encode(embeddingText).length,
          metadata: {
            workspaceId,
            filePath: relativePath,
            language,
            kind,
            symbolName,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            signature,
          },
        });
      }

      if (results.length === 0) {
        const sourceText = text.trim();
        if (sourceText) {
          const tokenEncoder =
            await WorkspaceVectorSearchService.getTokenEncoder();
          results.push({
            id: `${workspaceId}:${relativePath}:file`,
            embeddingText: [
              `file: ${relativePath}`,
              `kind: file`,
              sourceText,
            ].join("\n"),
            tokenCount: tokenEncoder.encode(sourceText).length,
            metadata: {
              workspaceId,
              filePath: relativePath,
              language,
              kind: "file",
              symbolName: path.basename(relativePath),
              startLine: 1,
              endLine: text.split(/\r?\n/).length,
              signature:
                sourceText.split(/\r?\n/, 1)[0]?.trim() ??
                path.basename(relativePath),
            },
          });
        }
      }

      return results;
    } finally {
      parser.delete();
    }
  }

  private async extractLineBasedChunks(
    file: vscode.Uri,
    text: string,
    language: "html" | "css",
  ): Promise<CodeChunk[]> {
    const CHUNK_LINES = 60; // 1チャンクあたりの行数
    const OVERLAP_LINES = 10; // チャンク間のオーバーラップ（文脈保持）
    const lines = text.split(/\r?\n/);
    const relativePath = this.relativePath(file);
    const workspaceId = this.getWorkspaceId();
    const tokenEncoder = await WorkspaceVectorSearchService.getTokenEncoder();
    const results: CodeChunk[] = [];

    for (
      let start = 0;
      start < lines.length;
      start += CHUNK_LINES - OVERLAP_LINES
    ) {
      const end = Math.min(start + CHUNK_LINES, lines.length);
      const sourceText = lines.slice(start, end).join("\n").trim();
      if (!sourceText) continue;

      const embeddingText = [
        `file: ${relativePath}`,
        `kind: chunk`,
        `lines: ${start + 1}-${end}`,
        sourceText,
      ].join("\n");

      results.push({
        id: `${workspaceId}:${relativePath}:${start + 1}-${end}`,
        embeddingText,
        tokenCount: tokenEncoder.encode(embeddingText).length,
        metadata: {
          workspaceId,
          filePath: relativePath,
          language,
          kind: "chunk",
          symbolName: `${path.basename(relativePath)}:L${start + 1}`,
          startLine: start + 1,
          endLine: end,
          signature: lines[start]?.trim() ?? "",
        },
      });

      if (end >= lines.length) break;
    }
    return results;
  }

  private findCandidateNodes(
    rootNode: TreeSitter.Node,
    language: SupportedLanguage,
  ): TreeSitter.Node[] {
    const types =
      language === "java"
        ? ["method_declaration", "constructor_declaration"]
        : [
            "function_declaration",
            "method_definition",
            "generator_function_declaration",
          ];
    return rootNode.descendantsOfType(types);
  }

  private getChunkKind(
    node: TreeSitter.Node,
    language: SupportedLanguage,
  ): string {
    if (language === "java") {
      return node.type === "constructor_declaration" ? "constructor" : "method";
    }

    if (
      node.type === "method_definition" &&
      node.childForFieldName("name")?.text === "constructor"
    ) {
      return "constructor";
    }

    return node.type === "function_declaration" ? "function" : "method";
  }

  private getNodeName(node: TreeSitter.Node, kind: string): string {
    return (
      node.childForFieldName("name")?.text?.trim() ??
      (kind === "constructor" ? "constructor" : kind)
    );
  }

  private async loadLanguage(
    language: SupportedLanguage,
  ): Promise<TreeSitter.Language> {
    const cached = WorkspaceVectorSearchService.languageCache.get(language);
    if (cached) {
      return cached;
    }

    const promise = TreeSitter.Language.load(
      this.getLanguageWasmPath(language),
    );
    WorkspaceVectorSearchService.languageCache.set(language, promise);
    return promise;
  }

  private getLanguageWasmPath(language: SupportedLanguage): string {
    const parserDir = path.join(
      this.context.extensionUri.fsPath,
      "resources",
      "parsers",
    );
    switch (language) {
      case "javascript":
        return path.join(parserDir, "tree-sitter-javascript.wasm");
      case "typescript":
        return path.join(parserDir, "tree-sitter-typescript.wasm");
      case "tsx":
        return path.join(parserDir, "tree-sitter-tsx.wasm");
      case "java":
        return path.join(parserDir, "tree-sitter-java.wasm");
    }
  }

  private getSupportedLanguage(
    file: vscode.Uri,
  ): SupportedLanguage | undefined {
    switch (path.extname(file.fsPath).toLowerCase()) {
      case ".js":
      case ".jsx":
      case ".mjs":
      case ".cjs":
        return "javascript";
      case ".ts":
        return "typescript";
      case ".tsx":
        return "tsx";
      case ".java":
        return "java";
      case ".html":
      case ".htm":
        return "html";
      case ".css":
      case ".scss":
      case ".less":
        return "css";
      default:
        return undefined;
    }
  }

  private async findWorkspaceFiles(): Promise<vscode.Uri[]> {
    return vscode.workspace.findFiles(
      "**/*.{ts,tsx,js,jsx,mjs,cjs,java,html,css}",
      "{**/node_modules/**,**/dist/**,**/out/**,**/.git/**,**/coverage/**,**/build/**}",
    );
  }

  private async readFileText(file: vscode.Uri): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(file);
    return new TextDecoder("utf-8").decode(bytes);
  }

  private async readSnippet(
    relativePath: string,
    startLine: number,
    endLine: number,
  ): Promise<string> {
    const file = vscode.Uri.joinPath(this.workspaceFolder.uri, relativePath);
    const text = await this.readFileText(file);
    const lines = text.split(/\r?\n/);
    return [
      "```",
      ...lines.slice(
        Math.max(startLine - 1, 0),
        Math.min(endLine, lines.length),
      ),
      "```",
    ].join("\n");
  }

  private relativePath(file: vscode.Uri): string {
    return vscode.workspace.asRelativePath(file, false).replace(/\\/g, "/");
  }

  private getWorkspaceId(): string {
    return crypto
      .createHash("sha1")
      .update(this.workspaceFolder.uri.fsPath)
      .digest("hex")
      .slice(0, 12);
  }
}
