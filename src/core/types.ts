export interface ChunkRecord {
  id: string;
  /** 埋め込み対象テキストのハッシュ(行番号を含まない)。ベクトルキャッシュのキー */
  hash: string;
  file: string;
  language: string;
  kind: string;
  scope: string;
  symbols: string[];
  startLine: number;
  endLine: number;
  text: string;
}

export interface SearchHit {
  chunk: ChunkRecord;
  /** RRF統合スコア */
  score: number;
  lexRank?: number;
  vecRank?: number;
  /** コサイン類似度(ベクトル検索にヒットした場合) */
  similarity?: number;
}

export interface BlankSpec {
  answer: string;
  concept: string;
  /** [概念, 方針, 形] の3段階 */
  hints: string[];
}

export type QuizKind = "change" | "read";

export interface QuizItem {
  kind: QuizKind;
  path: string;
  startLine: number;
  endLine: number;
  /** 生成時点のファイル内容(``` 等は含まない生テキスト) */
  original: string;
  quizCode: string;
  blanks: BlankSpec[];
  explanation: string;
}

export interface McqQuestion {
  id: string;
  prompt: string;
  options: string[];
  /** 正解の選択肢インデックス(複数可) */
  correct: number[];
  explanation: string;
  concept: string;
  path?: string;
  line?: number;
}

export interface GeneratedQuiz {
  goal: string;
  overallExplanation: string;
  items: QuizItem[];
  rejected: string[];
}

export const BLANK = "___BLANK___";
