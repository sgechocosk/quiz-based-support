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

/** 実ファイル上の位置(検証済み)。手がかり・参考コードのリンクに使う。 */
export interface CodeRef {
  path: string;
  /** 1始まり */
  line: number;
  note: string;
}

/** 選択式の選択肢。note は採点後に見せる「なぜ正しい/誤りか」 */
export interface Choice {
  code: string;
  note: string;
}

export interface BlankSpec {
  answer: string;
  concept: string;
  /** [概念, 考え方] の段階的ヒント */
  hints: string[];
  /** 選択肢(正解を含む・表示順)。旧データには無い */
  choices?: Choice[];
  /** 採点後に見せる「なぜこのコードになるか」 */
  why?: string;
  /** 答えを導く手がかりになる別の場所(答えそのものは含まない行) */
  clue?: CodeRef;
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
  /** 解答前に見せる課題文(read: この範囲の役割と読みどころ / change: 何をどう変えるか)。答えは含まない */
  task?: string;
  /** 解答前に見せる参考コードの場所 */
  refs?: CodeRef[];
  /** change で新しく作る名前(メソッド・変数など)。推測させず解答前に明示する */
  newNames?: NewName[];
}

export interface NewName {
  name: string;
  /** 何のための名前か */
  role: string;
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
  /** 利用者に伝えるべき出題上の注意(例: 実装依頼なのに実装問題を作れなかった) */
  notice?: string;
}

export const BLANK = "___BLANK___";
