/**
 * VS Code に依存しない境界(ポート)。実体は host/ にあり、テストでは偽物に差し替える。
 */

export interface FileInfo {
  /** ワークスペース相対パス(/区切り) */
  path: string;
  size: number;
  mtime: number;
}

export interface WorkspacePort {
  /** ワークスペースを一意に表す文字列(インデックス保存先の決定に使う) */
  readonly id: string;
  /** 除外設定(.gitignore等)適用済みのファイル一覧 */
  listFiles(): Promise<FileInfo[]>;
  /** 存在しない/除外対象なら undefined */
  stat(path: string): Promise<FileInfo | undefined>;
  readText(path: string): Promise<string>;
}

export interface SymbolInfo {
  name: string;
  kind: string;
  path: string;
  /** 1始まり */
  startLine: number;
  endLine: number;
  /** 名前トークンの位置(0始まりの character、1始まりの line) */
  nameLine: number;
  nameChar: number;
  container?: string;
}

export interface LocationInfo {
  path: string;
  /** 1始まり */
  line: number;
  /** 0始まり */
  character: number;
}

export interface LspPort {
  workspaceSymbols(query: string): Promise<SymbolInfo[]>;
  documentSymbols(path: string): Promise<SymbolInfo[]>;
  references(path: string, line: number, character: number): Promise<LocationInfo[]>;
  definition(path: string, line: number, character: number): Promise<LocationInfo[]>;
}

export interface Embedder {
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON文字列 */
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
}

export interface ChatLlm {
  chat(request: ChatRequest): Promise<ChatResult>;
}

/** 構文チェック(tree-sitter)。判定不能なら undefined。 */
export interface SyntaxChecker {
  /** true: エラー無し / false: 構文エラーあり / undefined: 判定不能 */
  isValid(path: string, text: string): Promise<boolean | undefined>;
}

export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
}
