import type { ClarifyAnswer } from "./agent";
import type { PlanEdit } from "./overlay";
import type { PatternId } from "./patterns";
import type { TypeDiagnostic } from "./ports";

/** ステップの種類。説明の順序(依存される側から)にも使う */
export type StepKind = "data" | "core" | "caller" | "ui" | "test" | "config" | "doc";

export const STEP_KINDS: StepKind[] = ["data", "core", "caller", "ui", "test", "config", "doc"];

export const STEP_KIND_LABEL: Record<StepKind, string> = {
  data: "データ・型",
  core: "中核の処理",
  caller: "呼び出し元",
  ui: "画面",
  test: "テスト",
  config: "設定",
  doc: "説明文",
};

export type ContractKind = "behavior" | "signature" | "variant" | "data" | "dependency" | "none";

/** 変更によって「何の約束が変わるか」 */
export interface ContractChange {
  kind: ContractKind;
  /** 対象(関数名・型名・メッセージの種類など) */
  subject: string;
  description: string;
}

/** 大きな依頼を分けた段階(それだけで動作が完結する単位。1段階ずつ、依頼全体が完成するまで進める) */
export interface StagePlan {
  label: string;
  /** この段階を終えると何ができるようになるか */
  goal: string;
  /** この段階の受け入れ条件 */
  criteria: string[];
}

/** 段階に分けて進めているときの、今回の段階の位置づけ */
export interface StageContext {
  /** 0始まり */
  index: number;
  total: number;
  label: string;
  /** 依頼全体の理解 */
  overall: string;
  /** 依頼全体の受け入れ条件 */
  overallCriteria: string[];
  /** 済んだ段階(名前と結果の要約) */
  done: string[];
  /** 後の段階(今回は手を付けない) */
  later: string[];
}

/** 整理・確定した要件 */
export interface RequirementSpec {
  query: string;
  understanding: string;
  /** 受け入れ条件(検証できる振る舞い) */
  criteria: string[];
  contracts: ContractChange[];
  /** ユーザーに確認した内容 */
  answers: ClarifyAnswer[];
  /** 依頼全体を分けた段階(2つ以上のときだけ。1段階ずつ、依頼全体が完成するまで進める) */
  stages?: StagePlan[];
  /** 段階に分けて進めているときの、今回の段階 */
  stage?: StageContext;
}

/** 確認が必要な場所(行番号は、変更計画を重ねた現在の内容での位置) */
export interface Site {
  path: string;
  line: number;
  text: string;
  /** その行を含む関数・メソッドなど */
  symbol?: string;
  /** 型エラーのメッセージなどの補足 */
  note?: string;
}

/** 確認した結果 */
export interface Verdict extends Site {
  changed: boolean;
  reason: string;
  /** 変更したステップ */
  step?: string;
  /** 計画内の別の変更で既に書き換わっていた(機械的に判定) */
  auto?: boolean;
  /** 変更が必要と判断したが、編集を作れなかった(手で対応が必要) */
  needsAction?: boolean;
}

/** 確認事項: ある変更によって、確認が必要になった場所の一覧と、その判断 */
export interface Obligation {
  id: string;
  pattern: PatternId;
  /** この確認事項を生んだステップ */
  fromStep?: string;
  /** 何についての確認か(シンボル名・キー・ファイル) */
  subject: string;
  /** 探し方(人に見せる説明) */
  query: string;
  sites: Site[];
  /** 見つかったが表示を省いた数 */
  more: number;
  status: "open" | "done" | "gave-up";
  verdicts: Verdict[];
  attempts: number;
  lastError?: string;
  /** プロジェクトの約束に由来する場合の名前と判断基準 */
  ruleName?: string;
  criterion?: string;
}

/** 変更計画の1ステップ(変更理由グラフのノード) */
export interface PlanStep {
  /** 作成順の id(s1, s2, ...) */
  id: string;
  /** 説明の順番(1始まり。並べ替えた後に決まる) */
  number: number;
  /** サブゴール名 */
  label: string;
  kind: StepKind;
  why: string;
  contract: string;
  mechanical: boolean;
  /** 満たす受け入れ条件の番号(1始まり) */
  requirements: number[];
  dependsOn: string[];
  /** どの確認事項から生まれたか(起点のステップは undefined) */
  causedBy?: { obligation: string; step?: string; pattern: PatternId };
  edits: PlanEdit[];
  /** このステップの変更から生まれた確認事項の id */
  obligations: string[];
}

export interface PlannedFile {
  path: string;
  /** 変更前(新規作成なら null) */
  original: string | null;
  final: string;
}

/** 変更計画(全体) */
export interface ChangePlan {
  spec: RequirementSpec;
  /** 説明の順に並べたステップ */
  steps: PlanStep[];
  obligations: Obligation[];
  files: PlannedFile[];
  typecheck: { available: boolean; remaining: TypeDiagnostic[]; note?: string };
  warnings: string[];
}
