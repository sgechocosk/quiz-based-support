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
  /** purpose: 何のための呼び出しか(API 実行前の確認画面に表示する) */
  embed(texts: string[], signal?: AbortSignal, purpose?: string): Promise<number[][]>;
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
  /** 何のための呼び出しか(API 実行前の確認画面に表示する) */
  purpose?: string;
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
  /** 応答が終わった理由("length" は出力の上限で途中で切れた) */
  finishReason?: string;
}

export interface ChatLlm {
  chat(request: ChatRequest): Promise<ChatResult>;
}

/** 構文チェック(tree-sitter)。判定不能なら undefined。 */
export interface SyntaxChecker {
  /** true: エラー無し / false: 構文エラーあり / undefined: 判定不能 */
  isValid(path: string, text: string): Promise<boolean | undefined>;
  /** 最初の構文エラーの行(1始まり。分からなければ undefined) */
  errorLine?(path: string, text: string): Promise<number | undefined>;
}

export interface TypeDiagnostic {
  /** ワークスペース相対パス */
  path: string;
  /** 1始まり */
  line: number;
  code: string;
  message: string;
}

/** 型検査(TypeScript 等)。変更計画を仮想的に重ねた状態で、新しく生じたエラーを見つけるのに使う。 */
export interface TypeChecker {
  /**
   * overlay(変更後の内容。新規ファイルを含む。キーはワークスペース相対パス)を重ねた状態(after)と、
   * 重ねない状態(before)の型エラーを、変更したファイルとそれを読み込むファイルについて返す。
   * 型検査できない(設定が無い・対応言語でない等)なら undefined。
   */
  check(overlay: ReadonlyMap<string, string>, signal?: AbortSignal): Promise<{ before: TypeDiagnostic[]; after: TypeDiagnostic[] } | undefined>;
}

/** 変更履歴(git 等) */
export interface HistoryPort {
  /** 最近のコミットごとの、変更されたファイル(ワークスペース相対パス)の一覧。取得できなければ空配列 */
  commits(): Promise<string[][]>;
}

export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
}
