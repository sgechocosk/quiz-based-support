import {
  applyReview,
  checkpointAfter,
  continueMessage,
  defaultNeeds,
  definitionGaps,
  formatNotes,
  markKeyLocations,
  NEED_LABEL,
  NEEDS_SCHEMA,
  parseNeeds,
  planRequest,
  REVIEW_SCHEMA,
  reviewRequest,
  startMessage,
  type InfoNeed,
  type RawReview,
  type ReviewOutcome,
} from "./investigation";
import { maskAnswers, revealsAnswer } from "./leak";
import { levelGuide, levelStyle, type LearnerLevel } from "./level";
import type { ChatLlm, ChatMessage, LspPort, SyntaxChecker, ToolCall, WorkspacePort } from "./ports";
import { applyItemToText, compactItem, validateRawItem, type RawItem, type Validation } from "./quiz";
import { parseJson, splitLines } from "./text";
import { EvidenceStore, executeTool, normalizeRelPath, TOOL_DEFS, type CodeIndex } from "./tools";
import type { ContractChange, ContractKind, RequirementSpec, StagePlan } from "./planTypes";
import { parseStages, STAGES_PROPERTY, stageBrief, stageRules, type RawStage } from "./stages";
import type { CodeRef, GeneratedQuiz, QuizItem } from "./types";

export type QuizMode = "auto" | "change" | "read";

export interface AgentConfig {
  /** 調査で呼べるツールの回数の上限(目安ではない。材料が足りたと判断した時点で終える) */
  maxSteps: number;
  minSimilarity: number;
  repoMapChars: number;
  evidenceChars: number;
  /** 利用者のレベル(解説の細かさ・用語・空欄の難しさ) */
  level?: LearnerLevel;
}

export interface AgentDeps {
  llm: ChatLlm;
  ws: WorkspacePort;
  lsp?: LspPort;
  index: CodeIndex & { repoMap(budgetChars: number): string };
  syntax?: SyntaxChecker;
  config: AgentConfig;
}

export interface RunHooks {
  onStatus?: (message: string) => void;
  signal?: AbortSignal;
}

export interface AgentResult {
  quiz: GeneratedQuiz;
  evidencePaths: string[];
  notes: string;
  steps: number;
}

/** 調査の結果。要件の確認を挟んでも、同じ調査の続きから出題できるように保持する。 */
export interface Investigation {
  query: string;
  mode: QuizMode;
  /** 調査の会話(回答を受けた追加調査はこの続きで行う) */
  messages: ChatMessage[];
  evidence: EvidenceStore;
  notes: string;
  steps: number;
  /** 調べること(要求に答えるために知る必要があること)と、それぞれ分かったか */
  needs: InfoNeed[];
  /** 実行したツール呼び出し(呼び出しの内容 → 何手目か)。同じ呼び出しの繰り返しで回数を使わないため */
  calls: Map<string, number>;
}

export interface ClarifyOption {
  label: string;
  /** 選ぶと何がどう変わるか(触るファイル・関数、動作の違い) */
  detail: string;
  recommended: boolean;
}

export interface ClarifyQuestion {
  question: string;
  /** なぜ決める必要があるか */
  why: string;
  options: ClarifyOption[];
}

/** 実装に移る前にユーザーへ確認する内容 */
export interface Clarification {
  /** 依頼をどう理解したか */
  understanding: string;
  /** なぜ確認が必要か */
  reason: string;
  estimatedFiles: number;
  estimatedLines: number;
  /** 1回の手順で扱える規模を超える見込みか(超えるなら段階に分けて、依頼全体が完成するまで進める) */
  large: boolean;
  questions: ClarifyQuestion[];
  /** 依頼全体を分けた段階(large のときだけ。1段階ずつ最後まで進める) */
  stages: StagePlan[];
  /** 確認前の時点の受け入れ条件(「確認せずに進める」ときはこれを使う) */
  criteria: string[];
  contracts: ContractChange[];
}

export interface ClarifyAnswer {
  question: string;
  answer: string;
}

const STRING = { type: "string" } as const;
const INTEGER = { type: "integer" } as const;
const MAX_ITEMS = 3;
/** 初回 + 不合格だった問題の作り直し(最大2回) */
const MAX_QUIZ_ATTEMPTS = 3;
/** 1回の手順で扱える変更行数の目安(これを超える依頼は段階に分ける) */
export const LARGE_CHANGE_LINES = 60;
/** 1回の手順(段階)で扱える規模 */
export const STAGE_SIZE = { places: MAX_ITEMS, lines: LARGE_CHANGE_LINES };
/** 要件の回答を受けて行う追加調査のツール呼び出し上限 */
const FOLLOW_UP_STEPS = 6;
/** 段階ごとに今のコードで調べ直すときのツール呼び出し上限(材料が足りれば上限を待たずに終える) */
const STAGE_STEPS = 8;
/** 段階ごとに調べ直すとき、ファイル全体を参照コードにする行数の上限(超えれば変えた行の周りだけ) */
const STAGE_FILE_LINES = 400;
/** 1回の調査で「材料が足りたか」を確かめる回数の上限 */
const MAX_REVIEWS = 3;
/** 要求の文で検索して、調査の手がかりとして最初に示す候補の数 */
const SEED_LEADS = 6;

export const QUIZ_SCHEMA = {
  name: "quiz",
  schema: {
    type: "object",
    properties: {
      goal: STRING,
      overallExplanation: STRING,
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["read", "change"] },
            path: STRING,
            startLine: INTEGER,
            endLine: INTEGER,
            firstLine: STRING,
            lastLine: STRING,
            oldCode: STRING,
            task: STRING,
            newCode: STRING,
            blanks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  line: INTEGER,
                  target: STRING,
                  concept: STRING,
                  hintConcept: STRING,
                  hintApproach: STRING,
                  why: STRING,
                  distractors: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { code: STRING, whyWrong: STRING },
                      required: ["code", "whyWrong"],
                      additionalProperties: false,
                    },
                  },
                  cluePath: STRING,
                  clueLine: INTEGER,
                  clueNote: STRING,
                },
                required: [
                  "line", "target", "concept", "hintConcept", "hintApproach", "why", "distractors", "cluePath", "clueLine", "clueNote",
                ],
                additionalProperties: false,
              },
            },
            refs: {
              type: "array",
              items: {
                type: "object",
                properties: { path: STRING, line: INTEGER, note: STRING },
                required: ["path", "line", "note"],
                additionalProperties: false,
              },
            },
            newNames: {
              type: "array",
              items: {
                type: "object",
                properties: { name: STRING, role: STRING },
                required: ["name", "role"],
                additionalProperties: false,
              },
            },
            explanation: STRING,
          },
          required: [
            "kind", "path", "startLine", "endLine", "firstLine", "lastLine", "oldCode", "task", "newCode", "blanks", "refs", "newNames", "explanation",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["goal", "overallExplanation", "items"],
    additionalProperties: false,
  },
} as const;

export function exploreSystemPrompt(maxSteps: number, repoMap: string): string {
  return [
    "あなたはコードベースの理解を支援するアシスタントの「調査担当」です。この段階ではクイズも回答コードも作りません。",
    "経験のあるエンジニアが初めてのコードベースで作業するときと同じように、",
    "(1) 要求に答える(実装する)には何を知る必要があるかを先に決め、(2) それを1つずつコードで確かめ、(3) 材料がそろったら上限を待たずに調査を終えます。",
    "",
    "【進め方】",
    "- 当たりを付ける: 下の「リポジトリ概観」と、要求の文で検索した「手がかり」から候補を選ぶ。search_code(識別子や英語のキーワードを含めると精度が上がる)で探し、名前や文字列を厳密に探すなら grep、シンボル名なら find_symbols。",
    "- 確かめる: 候補は read_file で実際に読む(検索結果の抜粋だけで判断しない)。大きなファイルは outline で構造を見てから、必要な関数の範囲を読む。",
    "- たどる: 呼び出し関係は find_references / find_definition で確かめる。中心のコードが呼んでいる関数・使っている型の定義も読んでおく(利用者が答えを自力で導く手がかりになり、変更で既存の関数を正しく使う根拠になる)。",
    "- 要求が「〜を追加・修正したい」なら、変更が入る場所と、手本にすべき既存の実装を見つける。「〜はどう動く/どこ?」なら、中心となる処理と呼び出し関係を見つける。",
    "- 互いに関係しない呼び出し(別々のファイルを読む・別々の名前を探す)は、1回の応答でまとめて呼ぶ。同じ呼び出しを繰り返さない。",
    `- ツール呼び出しの上限は${maxSteps}回(目安ではない)。調べることがすべて分かったら、ツールを呼ばずに「どのファイルの何行目付近が重要で、なぜか(何を受け取り、何を返し、誰から呼ばれるか)」を短い箇条書きで答えて終える。`,
    "- 終えるとシステムが材料が足りているかを確かめ、足りなければ何が足りないかを伝えます。",
    "- 行番号は read_file の表示(L数字|)のとおりに引用する。推測で行番号を作らない。",
    "",
    "【リポジトリ概観(ファイル — 主なシンボル。他から参照される順)】",
    repoMap || "(インデックス未作成のため概観なし。list_files / grep を使ってください)",
  ].join("\n");
}

// ---------- 要件の確認(大きな変更・複数案がある依頼) ----------

export const SCOPE_SCHEMA = {
  name: "scope",
  schema: {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["proceed", "clarify"] },
      reason: STRING,
      understanding: STRING,
      estimatedFiles: INTEGER,
      estimatedLines: INTEGER,
      acceptanceCriteria: { type: "array", items: STRING },
      contractChanges: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["behavior", "signature", "variant", "data", "dependency", "none"] },
            subject: STRING,
            description: STRING,
          },
          required: ["kind", "subject", "description"],
          additionalProperties: false,
        },
      },
      stages: STAGES_PROPERTY,
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: STRING,
            why: STRING,
            options: {
              type: "array",
              items: {
                type: "object",
                properties: { label: STRING, detail: STRING, recommended: { type: "boolean" } },
                required: ["label", "detail", "recommended"],
                additionalProperties: false,
              },
            },
          },
          required: ["question", "why", "options"],
          additionalProperties: false,
        },
      },
    },
    required: ["decision", "reason", "understanding", "estimatedFiles", "estimatedLines", "acceptanceCriteria", "contractChanges", "stages", "questions"],
    additionalProperties: false,
  },
} as const;

export function scopeSystemPrompt(level: LearnerLevel = "intermediate"): string {
  return [
    "あなたはコードの理解と変更を支援するアシスタントの「要件確認担当」です。ユーザーの実装・修正の依頼と調査済みのコードを読み、要件を整理したうえで、",
    "このまま実装の計画に進んでよいか、先にユーザーへ要件を確認すべきかを判断します。",
    `1回の手順で、変更を追いながら理解できるのは${MAX_ITEMS}か所・約${LARGE_CHANGE_LINES}行程度までです。それより大きい依頼は段階に分け、1段階ずつ、依頼全体が完成するまで進めます。`,
    "要件があいまいなまま進めると、ユーザーの意図と違うコードを「このコードにする」と示してしまいます。",
    "出力は指定のJSONスキーマに厳密に従ってください。",
    "",
    "【先に確認する(decision=\"clarify\")場合】",
    `1. 変更が大きい: ${MAX_ITEMS}つより多いファイル・関数にまたがる、新しいファイル・クラス・画面・設定項目が必要、または変更行が合計でおよそ${LARGE_CHANGE_LINES}行を超える。`,
    "   → stages に、依頼全体を完成させるまでの段階を書く(下の【段階】)。ユーザーには段階の分け方を見せてから進める。",
    "2. 解釈や方針が複数ある: 仕様(入力・出力・境界条件・エラー時の扱い・既存の動作を変えるか)や実装の方針(どこに置くか、既存の仕組みを拡張するか新しく作るか)に",
    "   もっともらしい案が複数あり、どれを選ぶかで完成するコードが大きく変わる。",
    "   → 案ごとに選択肢を作る。",
    "",
    "【確認しない(decision=\"proceed\")場合】",
    "- 変更が小さく、要求からやるべきことが一つに決まる。",
    "- 迷う点が、新しい名前や細かな書き方など、既存コードの慣習に合わせて決められることだけ。",
    "- 調査済みのコードを読めば答えが決まること(既存の関数・型・手本の実装)は質問しない。",
    "",
    "【質問の作り方】",
    "- questions は、解釈や方針が複数あるときに1〜3問(変更が大きいだけで迷う点が無ければ空配列でよい)。proceed のときは空配列。ユーザーが選択肢を選ぶだけで答えられる形にし、重要な順に並べる。",
    "- 「今回どこまで実装するか」は質問しない(段階に分けて、依頼全体を最後まで実装する)。",
    "- options は各質問に2〜4個。label は短い案の名前。detail には、選ぶと何がどう変わるか(触るファイル・関数、動作の違い)を参照コードの名前を使って1〜2文で書く。",
    "- recommended は、既存コードの設計と最も整合する案1つだけを true にする(決められなければすべて false)。",
    "- why: その点を決めないと何があいまいなまま実装されるかを1文で。",
    "- understanding: 依頼をどう理解したかを1〜2文で。reason: 確認が必要な理由(clarify)または不要な理由(proceed)を1文で。",
    "- estimatedFiles / estimatedLines: 依頼を全部実装した場合に変更するファイル数と変更行数(追加+削除)の見積もり。decision に関わらず正直に書く。",
    "",
    "【段階】",
    ...stageRules(MAX_ITEMS, LARGE_CHANGE_LINES),
    "",
    "【要件の整理(decision に関わらず書く)】",
    "- acceptanceCriteria: 依頼全体の受け入れ条件を1〜5件。「〜のとき〜になる」のように、実装できたかを確かめられる振る舞いで書く(実装方法は書かない)。",
    "  clarify のときは、確認が必要な点を除いた、現時点で確かな条件だけを書く。",
    "- contractChanges: この依頼で変わる「約束」の見込み。kind は signature(関数の引数・戻り値)/ variant(種類の値・メッセージの種類の追加)/",
    "  data(型・保存するデータの形)/ behavior(振る舞い)/ dependency(新しい依存・設定)/ none。subject に対象(関数名・型名・キーなど)、description に変化を1文で。",
    "- " + levelStyle(level),
  ].join("\n");
}

interface RawScope {
  decision?: string;
  reason?: string;
  understanding?: string;
  estimatedFiles?: number;
  estimatedLines?: number;
  acceptanceCriteria?: string[];
  contractChanges?: Array<{ kind?: string; subject?: string; description?: string }>;
  stages?: RawStage[];
  questions?: Array<{
    question?: string;
    why?: string;
    options?: Array<{ label?: string; detail?: string; recommended?: boolean }>;
  }>;
}

/**
 * 要件確認の結果を判定する。
 * - 変更が大きい(LLM の見積もりが1回の手順の規模を超える)→ 段階に分ける。段階が2つ以上あれば Clarification(質問は無くてもよい)
 * - 解釈・方針が複数ある(LLM が clarify と判断した)→ 答えられる質問があれば Clarification
 * - 必要な段階・質問が欠けている → "missing"(作り直させる)
 * - 確認は不要 → undefined
 */
function estimates(raw: Pick<RawScope, "estimatedFiles" | "estimatedLines"> | undefined): { estimatedFiles: number; estimatedLines: number; large: boolean } {
  const count = (n: unknown) => Math.max(0, Math.round(Number(n) || 0));
  const estimatedFiles = count(raw?.estimatedFiles);
  const estimatedLines = count(raw?.estimatedLines);
  return { estimatedFiles, estimatedLines, large: estimatedFiles > MAX_ITEMS || estimatedLines > LARGE_CHANGE_LINES };
}

/** 見積もりが1回の手順で扱える規模を超えるか(超えるなら段階に分ける) */
export function isLargeEstimate(raw: Pick<RawScope, "estimatedFiles" | "estimatedLines"> | undefined): boolean {
  return estimates(raw).large;
}

export function decideClarification(raw: RawScope | undefined): Clarification | "missing" | undefined {
  const { estimatedFiles, estimatedLines, large } = estimates(raw);
  if (raw?.decision !== "clarify" && !large) {
    return undefined;
  }
  const questions: ClarifyQuestion[] = [];
  for (const q of raw?.questions ?? []) {
    const options: ClarifyOption[] = [];
    for (const o of q?.options ?? []) {
      const label = o?.label?.trim() ?? "";
      if (label && options.length < 4) {
        // おすすめは1つだけにする(複数あると選ぶ手がかりにならない)
        const recommended = o.recommended === true && !options.some((x) => x.recommended);
        options.push({ label, detail: o.detail?.trim() ?? "", recommended });
      }
    }
    const question = q?.question?.trim() ?? "";
    if (question && options.length >= 2 && questions.length < 3) {
      questions.push({ question, why: q.why?.trim() ?? "", options });
    }
  }
  const stages = large ? parseStages(raw?.stages) : [];
  if (large ? stages.length < 2 : questions.length === 0) {
    return "missing";
  }
  const reason =
    raw?.decision !== "clarify" || !raw.reason?.trim()
      ? `変更が大きくなる見込み(約${estimatedFiles}ファイル・約${estimatedLines}行)のため、${stages.length}段階に分けて1段階ずつ、依頼全体が完成するまで進めます。`
      : raw.reason.trim();
  const { criteria, contracts } = specParts(raw);
  return { understanding: raw?.understanding?.trim() ?? "", reason, estimatedFiles, estimatedLines, large, questions, stages, criteria, contracts };
}

const CONTRACT_KINDS: ContractKind[] = ["behavior", "signature", "variant", "data", "dependency", "none"];

/** LLM の出力から、受け入れ条件と「変わる約束」を取り出す */
function specParts(raw: Pick<RawScope, "acceptanceCriteria" | "contractChanges"> | undefined): { criteria: string[]; contracts: ContractChange[] } {
  const criteria = (raw?.acceptanceCriteria ?? [])
    .map((c) => (typeof c === "string" ? c.trim() : ""))
    .filter(Boolean)
    .slice(0, 6);
  const contracts: ContractChange[] = (raw?.contractChanges ?? [])
    .filter((c) => c && typeof c.subject === "string" && c.subject.trim())
    .slice(0, 8)
    .map((c) => ({
      kind: CONTRACT_KINDS.includes(c.kind as ContractKind) ? (c.kind as ContractKind) : "behavior",
      subject: c.subject!.trim(),
      description: (c.description ?? "").trim(),
    }));
  return { criteria, contracts };
}

/**
 * 要件の整理の結果を、確定した要件の形にする(受け入れ条件が無ければ依頼文そのものを条件にする)。
 * 段階が2つ以上あるときだけ stages を持たせる(1段階ずつ、依頼全体が完成するまで進める)。
 */
export function specFrom(
  query: string,
  raw: Pick<RawScope, "understanding" | "acceptanceCriteria" | "contractChanges" | "stages"> | undefined,
  answers: ClarifyAnswer[] = [],
): RequirementSpec {
  const { criteria, contracts } = specParts(raw);
  const stages = parseStages(raw?.stages);
  return {
    query,
    understanding: raw?.understanding?.trim() ?? "",
    criteria: criteria.length > 0 ? criteria : [query],
    contracts,
    answers,
    ...(stages.length >= 2 ? { stages } : {}),
  };
}

/** 確認画面での選択(選択肢の番号 / 補足の自由記述)を、出題に渡す回答の一覧にする。未回答の質問は含めない。 */
export function answersFrom(clarification: Clarification, picks: Array<{ option?: number; text?: string } | undefined>): ClarifyAnswer[] {
  const answers: ClarifyAnswer[] = [];
  clarification.questions.forEach((q, i) => {
    const pick = picks[i];
    const option = typeof pick?.option === "number" ? q.options[pick.option] : undefined;
    const text = (pick?.text ?? "").trim().slice(0, 300);
    const chosen = option ? (option.detail ? `${option.label}(${option.detail})` : option.label) : "";
    const answer = chosen && text ? `${chosen} / 補足: ${text}` : chosen || text;
    if (answer) {
      answers.push({ question: q.question, answer });
    }
  });
  return answers;
}

/** 出題に渡す要求文(確認した要件があれば添える) */
export function requirementText(query: string, answers: ClarifyAnswer[]): string {
  if (answers.length === 0) {
    return query;
  }
  return [
    query,
    "",
    "【ユーザーに確認した要件(これに従って仕様を決める)】",
    ...answers.map((a) => `- ${a.question} → ${a.answer}`),
  ].join("\n");
}

/** 回答を受けて要件を確定するときの出力 */
export const SPEC_SCHEMA = {
  name: "spec",
  schema: {
    type: "object",
    properties: {
      understanding: STRING,
      acceptanceCriteria: SCOPE_SCHEMA.schema.properties.acceptanceCriteria,
      contractChanges: SCOPE_SCHEMA.schema.properties.contractChanges,
      stages: STAGES_PROPERTY,
    },
    required: ["understanding", "acceptanceCriteria", "contractChanges", "stages"],
    additionalProperties: false,
  },
} as const;

export type QuizIntent = "change" | "read";

const CHANGE_WORDS =
  /追加|実装|作りたい|作って|作成|作る|修正|直し|直す|直せ|変更|変えたい|変えて|対応させ|対応したい|導入|組み込|改善|強化|改修|リファクタ|削除し|消したい|置き換|ようにしたい|ようにする|ようにして|にしたい|にして欲|にしてほし|できるようにし|欲しい|ほしい|書きたい|書いて|加えたい|入れたい|\b(add|implement|fix|create|build|support|refactor|change|remove|replace)\b/i;

/** 質問文が「実装・修正の依頼」か「仕組みの質問」かを判定する。 */
export function detectIntent(query: string): QuizIntent {
  return CHANGE_WORDS.test(query) ? "change" : "read";
}

/** 実装問題(change)を最低1問必須にするか */
export function requiresChange(mode: QuizMode, intent: QuizIntent): boolean {
  return mode === "change" || (mode === "auto" && intent === "change");
}

/** 選択肢(誤答)の作り方。読解・実装・手順の問題で共通 */
export function distractorRules(): string[] {
  return [
    "【選択肢 distractors(誤答を3つ)】",
    "- 目的は「コードベースを読んで根拠を確かめないと選べない」こと。勘や見た目で消去できる誤答は作らない。",
    "- 良い誤答: 実在する似た名前の別の関数・変数・フィールド(責務が違う)/ 引数の取り違え・順序違い / 境界条件の違い(< と <=)/ 条件の反転 /",
    "  同じファイルの別の箇所にある似た式 / 呼ぶ順序や呼ぶ相手を間違えたもの。どれもこのコードベースで実際に書かれうるもの。",
    "- 誤答には、参照コードに無い名前を使わない(存在しない名前は見ただけで誤りと分かる)。新しく作る名前(newNames)は使ってよい。",
    "- 正解と書き方が違うだけで同じ動作になるもの(等価な書き換え)は誤答にしない。",
    "- 正解と長さ・形をそろえる(正解だけが長い・具体的、などで見分けられないように)。各誤答は1行・60文字以内。",
    "- whyWrong(採点後に表示。ヒントで1つ消すときにも表示): なぜ誤りかを、根拠のファイル名:行と仕組みで1〜2文。正解のコードは書かない。",
  ];
}

/** 答え漏れを防ぐ決まり。visible は解答前に利用者に見える項目 */
export function leakRules(visible: string): string[] {
  return [
    "【答えを漏らさない(最重要)】",
    `解答前に見えるのは ${visible}。これらには、どの空欄の答えのコード片も、答えの識別子の組み合わせも書かない。`,
    "- hintConcept: どんな概念・仕組みが関わるか(例: 「非同期処理の完了を待つ必要がある」)。",
    "- hintApproach: どこを見て、どう考えれば選択肢を絞れるか(例: 「この関数の戻り値の型と、呼び出し元での使われ方を見比べる」)。",
    "- cluePath/clueLine/clueNote: 答えを導く根拠になる「別の場所」(呼び出す関数の定義・型定義・手本になる類似コードなど)。参照コードにある行を指定し、",
    "  その行自体に答えが書かれていてはいけない。適切な場所が無ければ cluePath は空文字、clueLine は0。",
  ];
}

export function quizSystemPrompt(mode: QuizMode, intent: QuizIntent = "read", level: LearnerLevel = "intermediate"): string {
  const modeLine =
    mode === "read"
      ? "今回はすべて kind=\"read\" にする。"
      : mode === "change"
        ? "今回はすべて kind=\"change\" にする。"
        : intent === "change"
          ? "今回の要求は実装・修正の依頼。利用者が穴埋めで実装を完成させる kind=\"change\" を必ず1問以上作る(これが主役)。" +
            "加えて、実装の前に理解しておくべき重要なコードや設計(変更が依存する既存の仕組み・手本になる実装・データ構造・独自の約束事)があれば、kind=\"read\" を最大2問含めてよい。理解の助けにならない読解は入れない。"
          : "今回の要求は仕組みについての質問。kind=\"read\" を中心にする。";
  return [
    "あなたはコードの理解を支援するアシスタントです。答えを直接教えるのではなく、調査済みのコードだけを根拠に、",
    "利用者が「どのファイルのどのコードが、どういう仕組みで動いているか」を自分で考えて理解できる穴埋めクイズを作ります。",
    "空欄は手入力ではなく選択式(正解1つ + 誤答3つ)。利用者は選択肢を比べながらコードベースを読み、根拠を持って選びます。",
    "出力は指定のJSONスキーマに厳密に従ってください。",
    "",
    "【問題の種類 kind】",
    "- \"read\": 既存コードの読解問題。対象範囲(path/startLine/endLine)を指定し、空欄にする部分を blanks で指定する。",
    "  firstLine/lastLine に範囲の最初と最後の行を逐語で入れる。コードを書き写す必要はない(システムが実ファイルから問題を組み立てる)。oldCode と newCode は空文字にする。",
    "- \"change\": 実装・修正の問題。oldCode に置き換える前のコード(参照コードの連続した行)を、newCode にそれを置き換える「変更後のコード」を空欄なしで全部書く。",
    "  oldCode は参照コードの行を、行番号(L数字|)を付けずに一字一句そのまま写す。表示されていない行を推測で書かない。",
    "  oldCode はファイルの中で1か所だけに一致するようにする(「}」だけのような行では複数に一致するので、前後の特徴のある行も含める)。",
    "  startLine には oldCode の最初の行の行番号を書く(endLine は oldCode の最後の行の行番号、firstLine/lastLine は空文字でよい)。",
    "  newCode では、oldCode のうち変更しない行も一字一句同じに含める。空欄のうち少なくとも1つは変更した行に置く。",
    "",
    "【新しい名前は先に決めて示す(理不尽な問題を作らない)】",
    "- change で新しく作るメソッド・関数・変数・引数・フィールド・クラスの名前は、あなたが決めて newNames に {name, role} で全部書く(role はその名前の役割を一言で)。これらは解答前に利用者へ表示される。",
    "- 新しい名前そのもの(例: 定義行の名前部分)は空欄にしない。空欄にするのは、その名前を使って何をするか(条件・呼び出し・引数・戻り値など)。",
    "- 既存コードに無い関数を呼ぶなら、その定義も newCode に含めて newNames に載せる。参照コードに無い既存関数を想像で呼ばない。",
    "- 名前はプロジェクトの既存の命名規則(大文字小文字・接頭辞・動詞の使い方)に合わせる。read では newNames は空配列。",
    modeLine,
    "",
    "【空欄 blanks の指定】",
    "- line: read はファイルの行番号(参照コードの L数字)、change は newCode の中での行番号(1始まり)。",
    "- target: その行に逐語で含まれる、空欄にする部分の文字列(1行以内・60文字以内)。行全体ではなく、条件式・呼び出し・引数・代入値・型など意味のある単位。",
    "- 個数と難しさは下の【利用者のレベル】に従う。周囲のコードと手がかりから一つに絞れる箇所を選ぶ(同じ意味の書き方が複数ありうる箇所や、根拠なく推測するしかない箇所は避ける)。",
    "",
    ...distractorRules(),
    "",
    ...leakRules("goal・task・refs・concept・2段階ヒント・clueNote"),
    "",
    "【利用者が導けるための説明】",
    "- task(解答前に表示): read なら「この範囲がシステムの中で何を担い、どこから呼ばれ、何を読み取ってほしいか」。",
    "  change なら「何を実現するために、どこを、どう変えるか」という仕様(入力・出力・満たすべき条件・使うべき既存の関数や手本)。答えのコードは書かない。",
    "- refs(解答前に表示, 0〜3件): 読むと理解が進む参照コードの場所(path, line, なぜ見るべきか)。",
    "- why(採点後に表示): その空欄がなぜそのコードになるか。根拠となる行(ファイル名:行)と、仕組み(データの流れ・型・呼び出し関係)を2〜3文で。",
    "- explanation(各item・採点後): この範囲の役割、処理の流れ、他のファイルとの関係(誰が呼び、何を呼ぶか)を具体的に。",
    "- overallExplanation(採点後): 要求に関わるシステム全体の流れを、ファイル名を挙げながら順に説明する。",
    "- goal: このクイズで何を理解してほしいかを1〜2文。答えは含めない。",
    "",
    "【共通ルール】",
    "- items は1〜3件。path/startLine/endLine は参照コードの表示どおり。",
    "- 範囲は空欄を含む関数・ブロックの必要最小限(目安15〜25行)。空欄と関係のない行は含めない(表示は空欄の前後数行に絞られる)。",
    "- concept は復習用の短いタグ(例: 非同期処理、条件分岐、配列操作、型注釈、状態管理)。答えの識別子は使わない。",
    "",
    levelGuide(level),
  ].join("\n");
}

function summarizeArgs(raw: string): string {
  try {
    const a = JSON.parse(raw) as Record<string, unknown>;
    const first = a.query ?? a.pattern ?? a.path ?? a.symbol ?? a.glob ?? "";
    const extra = a.startLine ? `:${a.startLine}-${a.endLine ?? ""}` : "";
    return `${String(first).slice(0, 60)}${extra}`;
  } catch {
    return "";
  }
}

/** 同じ呼び出しかどうかを比べるための引数の表記(キーの順序をそろえる) */
function canonicalArgs(raw: string): string {
  try {
    const a = JSON.parse(raw) as Record<string, unknown>;
    return JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]]));
  } catch {
    return raw.trim();
  }
}

function needList(needs: InfoNeed[]): string {
  const shown = needs.slice(0, 2).map((n) => n.need).join(" / ");
  return needs.length > 2 ? `${shown} ほか${needs.length - 2}件` : shown;
}

// ---------- 答え漏れの検出と修正 ----------

type LeakField = "goal" | "task" | "refNote" | "concept" | "hint0" | "hint1" | "clueNote";

interface Leak {
  id: string;
  field: LeakField;
  text: string;
  answers: string[];
  item?: number;
  blank?: number;
  ref?: number;
}

/** 解答前に見える文章のうち、答えを漏らしているものを列挙する。 */
export function findLeaks(goal: string, items: QuizItem[]): Leak[] {
  const leaks: Leak[] = [];
  const allAnswers = items.flatMap((it) => it.blanks.map((b) => b.answer));
  const shown = new Set(items.flatMap((it) => (it.newNames ?? []).map((n) => n.name)));
  const check = (leak: Omit<Leak, "answers">, answers: string[]): void => {
    const hit = answers.filter((a) => revealsAnswer(leak.text, a, shown));
    if (hit.length > 0) {
      leaks.push({ ...leak, answers: hit });
    }
  };
  check({ id: "goal", field: "goal", text: goal }, allAnswers);
  items.forEach((item, i) => {
    // 別の問題の答えも、同じ画面に並ぶので漏れになる
    const answers = allAnswers;
    check({ id: `${i}.task`, field: "task", text: item.task ?? "", item: i }, answers);
    (item.refs ?? []).forEach((r, k) => check({ id: `${i}.ref${k}`, field: "refNote", text: r.note, item: i, ref: k }, answers));
    item.blanks.forEach((b, k) => {
      check({ id: `${i}.${k}.concept`, field: "concept", text: b.concept, item: i, blank: k }, answers);
      b.hints.forEach((h, level) =>
        check({ id: `${i}.${k}.hint${level}`, field: `hint${level}` as LeakField, text: h, item: i, blank: k }, answers),
      );
      if (b.clue) {
        check({ id: `${i}.${k}.clue`, field: "clueNote", text: b.clue.note, item: i, blank: k }, answers);
      }
    });
  });
  return leaks;
}

function applyLeakFix(goal: { value: string }, items: QuizItem[], leak: Leak, text: string): void {
  const item = leak.item !== undefined ? items[leak.item] : undefined;
  const blank = item && leak.blank !== undefined ? item.blanks[leak.blank] : undefined;
  switch (leak.field) {
    case "goal":
      goal.value = text;
      break;
    case "task":
      if (item) {
        item.task = text;
      }
      break;
    case "refNote":
      if (item?.refs && leak.ref !== undefined && item.refs[leak.ref]) {
        item.refs[leak.ref]!.note = text;
      }
      break;
    case "concept":
      if (blank) {
        blank.concept = text;
      }
      break;
    case "clueNote":
      if (blank?.clue) {
        blank.clue.note = text;
      }
      break;
    default:
      if (blank) {
        blank.hints[Number(leak.field.slice(4))] = text;
      }
  }
}

/** LLM で書き直せなかった文章の最終手段(伏せ字・形だけのヒント・汎用タグ) */
function fallbackText(leak: Leak): string {
  if (leak.field === "concept") {
    return "コード理解";
  }
  return maskAnswers(leak.text, leak.answers);
}

const LEAK_FIX_SCHEMA = {
  name: "leak_fix",
  schema: {
    type: "object",
    properties: {
      fixes: {
        type: "array",
        items: {
          type: "object",
          properties: { id: STRING, text: STRING },
          required: ["id", "text"],
          additionalProperties: false,
        },
      },
    },
    required: ["fixes"],
    additionalProperties: false,
  },
} as const;

const FIELD_LABEL: Record<LeakField, string> = {
  goal: "クイズの目標",
  task: "課題文",
  refNote: "参考コードの説明",
  concept: "概念タグ(短い名詞)",
  hint0: "ヒント1(どんな概念・仕組みが関わるか)",
  hint1: "ヒント2(どこを見てどう考えるか)",
  clueNote: "手がかりの説明",
};

/**
 * 3段構えのエージェント。
 * 1) 調査: 要求に答えるために知る必要があることを決め、LLMがツール(検索・grep・読み取り・LSP)を自分で呼んで確かめる
 *    (エージェント型検索)。材料が足りたかを項目ごとに確かめ、足りれば上限を待たずに終える(investigation.ts)
 * 2) 要件の確認: 実装依頼で、変更が大きい・解釈や方針が複数ある場合は、出題せずにユーザーへ質問する
 * 3) 出題: 実際に読んだコードだけを根拠に構造化JSONでクイズを作り、実ファイルと突き合わせて検証する
 */
export class QuizAgent {
  constructor(private readonly deps: AgentDeps) {}

  /** 要件の確認を挟まずに、調査から出題までを行う。 */
  async run(query: string, mode: QuizMode, hooks: RunHooks = {}): Promise<AgentResult> {
    const inv = await this.investigate(query, mode, hooks);
    return this.compose(inv, [], hooks);
  }

  async investigate(query: string, mode: QuizMode, hooks: RunHooks = {}): Promise<Investigation> {
    const { index, config } = this.deps;
    const change = requiresChange(mode, detectIntent(query));
    const leads = await this.seedLeads(query, hooks);
    const inv: Investigation = {
      query,
      mode,
      messages: [
        { role: "system", content: exploreSystemPrompt(config.maxSteps, index.repoMap(config.repoMapChars)) },
        {
          role: "user",
          content: [
            change ? `${query}\n\n(これは実装・修正の依頼です。変更を入れる場所と、手本にすべき既存の実装を必ず特定してください)` : query,
            leads ? `\n【手がかり: 要求の文で検索して見つかった候補(まだ読んでいない)】\n${leads}` : "",
          ].join("\n"),
        },
      ],
      evidence: new EvidenceStore(),
      notes: "",
      steps: 0,
      needs: [],
      calls: new Map(),
    };
    hooks.onStatus?.("調べることを整理中...");
    await this.planNeeds(inv, change, config.maxSteps, hooks);
    await this.explore(inv, config.maxSteps, hooks);

    if (inv.evidence.isEmpty()) {
      // 何も読まずに終えた場合の保険: 質問そのもので検索して上位を読ませる
      await executeTool("search_code", JSON.stringify({ query, k: 4 }), this.toolContext(inv.evidence));
    }
    if (inv.evidence.isEmpty()) {
      throw new Error("関連するコードが見つかりませんでした。キーワードや関数名を含めて質問し直してください。");
    }
    return inv;
  }

  /**
   * 実装依頼の要件を整理する(受け入れ条件・変わる約束)。
   * 変更が大きい、または解釈・方針が複数あるなら、ユーザーへの質問(clarification)も返す(計画には進まない)。
   * 判定に失敗したときは、依頼文そのものを受け入れ条件として進める。
   */
  async organize(inv: Investigation, hooks: RunHooks = {}): Promise<{ spec: RequirementSpec; clarification?: Clarification }> {
    const { llm, config } = this.deps;
    if (!requiresChange(inv.mode, detectIntent(inv.query))) {
      return { spec: specFrom(inv.query, undefined) };
    }
    hooks.onStatus?.("要件を整理し、変更の規模と仕様の決め方が複数ないかを確認中...");
    const messages: ChatMessage[] = [
      { role: "system", content: scopeSystemPrompt(config.level) },
      {
        role: "user",
        content: [
          `【ユーザーの要求】\n${inv.query}`,
          inv.notes ? `\n【調査メモ】\n${inv.notes}` : "",
          `\n【参照コード(行番号 L数字| は表示用で、コードの一部ではない)】\n${inv.evidence.render(config.evidenceChars)}`,
        ].join("\n"),
      },
    ];
    let spec = specFrom(inv.query, undefined);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await llm.chat({ messages, jsonSchema: SCOPE_SCHEMA, signal: hooks.signal, purpose: "要件の整理" });
        const raw = parseJson<RawScope>(res.content);
        spec = specFrom(inv.query, raw);
        const verdict = decideClarification(raw);
        if (verdict !== "missing") {
          // 段階に分けるのは、1回の手順で扱える規模を超えるときだけ
          if (verdict?.large) {
            spec.stages = verdict.stages;
          } else {
            delete spec.stages;
          }
          return { spec, clarification: verdict };
        }
        messages.push(
          { role: "assistant", content: res.content ?? "" },
          {
            role: "user",
            content: isLargeEstimate(raw)
              ? "変更が大きい見込みですが、段階が2つ以上ありません。依頼全体を完成させるまでの段階を stages に2つ以上書いて、JSON全体を出し直してください。"
              : "確認が必要な依頼(案が複数ある)ですが、選択肢が2つ以上ある質問がありません。" +
                "decision=\"clarify\" とし、ユーザーが選ぶだけで答えられる質問(各2〜4個の選択肢)を1〜3問作って、JSON全体を出し直してください。",
          },
        );
      }
    } catch (error) {
      if (hooks.signal?.aborted) {
        throw error;
      }
      // 判定に失敗しても、計画そのものは止めない
    }
    delete spec.stages;
    return { spec };
  }

  /** 選んだ案に関係する、まだ読んでいないコードを調査の続きで確かめる */
  async followUp(inv: Investigation, answers: ClarifyAnswer[], hooks: RunHooks = {}): Promise<void> {
    if (answers.length === 0) {
      return;
    }
    hooks.onStatus?.("回答した要件をもとに、関連コードを追加で調査中...");
    inv.messages.push({
      role: "user",
      content: [
        "ユーザーに要件を確認し、次の回答を得ました。",
        ...answers.map((a) => `- ${a.question} → ${a.answer}`),
        "この要件で変更が入る場所と手本になる実装のうち、まだ読んでいないものがあれば追加で調べてください。",
        "調べ終えたら、ツールを呼ばずに、この要件に関係する重要な場所を前回と同じ形式の箇条書きでまとめ直してください(システムが、材料が足りているかをもう一度確かめます)。",
      ].join("\n"),
    });
    await this.explore(inv, FOLLOW_UP_STEPS, hooks);
  }

  /**
   * 段階に分けて進めているとき、次の段階の前に今のコードで調べ直す。
   * 前の段階の変更で内容が変わったファイルは今の内容で読み直し(focus: 変えた行の周り)、変わっていない行は前の調査の内容を使う。
   * 調査の会話は新しく始める(前の段階の古い行番号を引きずらないため)。
   */
  async investigateStage(
    base: Investigation,
    spec: RequirementSpec,
    focus: Array<{ path: string; lines: number[] }>,
    hooks: RunHooks = {},
  ): Promise<Investigation> {
    const { index, config } = this.deps;
    const which = spec.stage ? `${spec.stage.index + 1}段階目「${spec.stage.label}」` : "次の段階";
    hooks.onStatus?.(`今のコードで、${which}に関係する場所を調べ直しています...`);
    const evidence = await this.refreshEvidence(base.evidence, focus);
    const budget = Math.max(1, Math.min(config.maxSteps, STAGE_STEPS));
    const inv: Investigation = {
      query: base.query,
      mode: "change",
      messages: [
        { role: "system", content: exploreSystemPrompt(budget, index.repoMap(config.repoMapChars)) },
        {
          role: "user",
          content: [
            base.query,
            "",
            stageBrief(spec),
            `今回の段階の受け入れ条件:\n${spec.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
            focus.length > 0 ? `前の段階で変えたファイル(今の内容は読み込み済み): ${focus.map((f) => f.path).join(", ")}` : "",
            evidence.paths().length > 0 ? `これまでに読んだファイル: ${evidence.paths().join(", ")}` : "",
            "(これは実装・修正の依頼です。今回の段階で変更を入れる場所と、手本にすべき既存の実装を必ず特定してください。前の段階の変更で行番号が変わっているので、行番号は read_file で読み直して確かめてください)",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      evidence,
      notes: "",
      steps: 0,
      needs: [],
      calls: new Map(),
    };
    // 前の段階で読んだ行も根拠に使えるので、今回の段階に必要なことが既に読んだ範囲で分かれば、調べずに終えられる
    await this.planNeeds(inv, true, budget, hooks);
    await this.explore(inv, budget, hooks);
    inv.notes ||= base.notes;
    return inv;
  }

  /** 前の調査で読んだ行を、今の内容に合わせて作り直す(変わったファイルは読み直す) */
  private async refreshEvidence(base: EvidenceStore, focus: Array<{ path: string; lines: number[] }>): Promise<EvidenceStore> {
    const out = new EvidenceStore();
    const read = async (path: string): Promise<string[] | undefined> => {
      try {
        return splitLines(await this.deps.ws.readText(path));
      } catch {
        return undefined; // 消えたファイル
      }
    };
    // 小さいファイルは全体を、大きいファイルは手がかりの行の前後だけを入れる
    const addAround = (path: string, lines: string[], centers: number[]): void => {
      const keep: number[] = [];
      if (lines.length <= STAGE_FILE_LINES || centers.length === 0) {
        keep.push(...lines.slice(0, STAGE_FILE_LINES).map((_, i) => i + 1));
      } else {
        const set = new Set<number>();
        for (const c of [...centers].sort((a, b) => a - b)) {
          for (let n = Math.max(1, c - 20); n <= Math.min(lines.length, c + 20) && set.size < STAGE_FILE_LINES; n++) {
            set.add(n);
          }
        }
        keep.push(...set);
      }
      out.addAll(path, keep.map((n): [number, string] => [n, lines[n - 1]!]));
    };
    for (const { path, lines: seen } of base.entries()) {
      const now = await read(path);
      if (!now) {
        continue;
      }
      const same = [...seen].every(([n, text]) => now[n - 1] === text);
      if (same) {
        out.addAll(path, seen);
      } else {
        addAround(path, now, [...seen.keys()]);
      }
    }
    // 前の段階で変えたファイルは、変えた行の周りを最新として加える
    for (const f of focus) {
      const now = await read(f.path);
      if (now) {
        addAround(f.path, now, f.lines);
      }
    }
    return out;
  }

  /** 確認した内容で、受け入れ条件と変わる約束を確定する(失敗したら確認前の内容に回答を添えて使う) */
  async finalizeSpec(inv: Investigation, prior: RequirementSpec, answers: ClarifyAnswer[], hooks: RunHooks = {}): Promise<RequirementSpec> {
    if (answers.length === 0) {
      return { ...prior, answers };
    }
    const { llm, config } = this.deps;
    hooks.onStatus?.("回答をもとに要件を確定中...");
    try {
      const res = await llm.chat({
        messages: [
          {
            role: "system",
            content: [
              "あなたはコードの理解と変更を支援するアシスタントの「要件確認担当」です。ユーザーの依頼と、確認して得た回答から、実装の要件を確定します。",
              "質問はもうしません。出力は指定のJSONスキーマに厳密に従ってください。",
              "- understanding: 確定した要件(依頼全体)を1〜2文で。",
              "- acceptanceCriteria: 依頼全体の受け入れ条件を1〜5件。「〜のとき〜になる」のように、実装できたかを確かめられる振る舞いで書く。",
              "- contractChanges: 変わる約束の見込み(kind / subject / description)。",
              ...stageRules(MAX_ITEMS, LARGE_CHANGE_LINES),
              "  確認前の段階があれば、回答をふまえて見直す(回答で選んだ案に合わせて段階を足す・入れ替える)。",
              `- ${levelStyle(config.level ?? "intermediate")}`,
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              `【ユーザーの要求】\n${inv.query}`,
              `\n【確認した内容】\n${answers.map((a) => `- ${a.question} → ${a.answer}`).join("\n")}`,
              prior.criteria.length > 0 ? `\n【確認前の受け入れ条件】\n${prior.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}` : "",
              prior.stages ? `\n【確認前の段階】\n${prior.stages.map((st, i) => `${i + 1}. ${st.label}: ${st.goal}`).join("\n")}` : "",
              inv.notes ? `\n【調査メモ】\n${inv.notes}` : "",
            ].join("\n"),
          },
        ],
        jsonSchema: SPEC_SCHEMA,
        signal: hooks.signal,
        purpose: "要件の確定",
      });
      const spec = specFrom(inv.query, parseJson<RawScope>(res.content), answers);
      // 大きな依頼の段階を書き忘れたときは、確認前の段階で最後まで進める(1回に詰め込まない)
      if (!spec.stages && prior.stages) {
        spec.stages = prior.stages;
      }
      return spec;
    } catch (error) {
      if (hooks.signal?.aborted) {
        throw error;
      }
      return { ...prior, answers };
    }
  }

  /** 調査結果(と確認した要件)からクイズを作る。 */
  async compose(inv: Investigation, answers: ClarifyAnswer[] = [], hooks: RunHooks = {}): Promise<AgentResult> {
    await this.followUp(inv, answers, hooks);
    return this.composeQuiz(inv, requirementText(inv.query, answers), hooks);
  }

  /**
   * 調査結果からクイズを作る(追加の調査はしない)。
   * 実装の手順(変更計画)を作れなかったときの代わりにも使う。実装依頼なら実装問題を作り、作れなければ読解問題で出題する。
   */
  async composeQuiz(inv: Investigation, requirement: string, hooks: RunHooks = {}): Promise<AgentResult> {
    const status = hooks.onStatus ?? (() => undefined);
    status("コードの考えどころを整理中...");
    const quiz = await this.generateQuiz(inv, requirement, hooks);
    status("手がかりの文章を点検中...");
    await this.removeLeaks(quiz, hooks);
    return { quiz, evidencePaths: inv.evidence.paths(), notes: inv.notes, steps: inv.steps };
  }

  private toolContext(evidence: EvidenceStore) {
    const { ws, lsp, index, config } = this.deps;
    return { ws, lsp, index, evidence, minSimilarity: config.minSimilarity };
  }

  /** 要求の文そのもので検索した候補(場所と名前だけ。読んだことにはしない)。検索できなければ空文字 */
  private async seedLeads(query: string, hooks: RunHooks): Promise<string> {
    const { index, config } = this.deps;
    if (!index.hasChunks()) {
      return "";
    }
    try {
      const { hits } = await index.search(query, { k: SEED_LEADS, minSimilarity: config.minSimilarity });
      return hits
        .map(({ chunk: c }) => {
          const label = [c.kind, c.symbols.slice(0, 3).join(",")].filter(Boolean).join(" ");
          return `- ${c.file}:${c.startLine}-${c.endLine}${label ? `(${label})` : ""}`;
        })
        .join("\n");
    } catch (error) {
      if (hooks.signal?.aborted) {
        throw error;
      }
      return "";
    }
  }

  /** 調べることを決める(調査の会話の続きで、ツールを使わずに答えさせる)。決められなければ既定の項目で調べる */
  private async planNeeds(inv: Investigation, change: boolean, budget: number, hooks: RunHooks): Promise<void> {
    const request: ChatMessage = { role: "user", content: planRequest(change) };
    let needs: InfoNeed[] | undefined;
    try {
      const res = await this.deps.llm.chat({
        messages: [...inv.messages, request],
        jsonSchema: NEEDS_SCHEMA,
        signal: hooks.signal,
        purpose: "調べることの整理",
      });
      needs = parseNeeds(parseJson(res.content), change);
      inv.messages.push(request, { role: "assistant", content: res.content ?? "" });
    } catch (error) {
      if (hooks.signal?.aborted) {
        throw error;
      }
    }
    inv.needs = needs ?? defaultNeeds(change);
    hooks.onStatus?.(`調べること: ${inv.needs.map((n) => `${NEED_LABEL[n.kind]}(${n.need})`).join(" / ")}`);
    inv.messages.push({ role: "user", content: startMessage(inv.needs, budget) });
  }

  /**
   * 調査の会話を続ける。終えるのは次のとき:
   * - 調査担当がツールを呼ばずに終え、材料の確認で「足りた」と判断された
   * - 一定の回数を調べたところで材料を確認し、足りていた(上限まで使い切らない)
   * - ツール呼び出しが budget 回に達した / 材料の確認を MAX_REVIEWS 回した / 前の確認のあと何も調べずに終えた
   * 足りなければ、まだ分かっていない項目を伝えて続けさせる。
   */
  private async explore(inv: Investigation, budget: number, hooks: RunHooks): Promise<void> {
    const status = hooks.onStatus ?? (() => undefined);
    const change = requiresChange(inv.mode, detectIntent(inv.query));
    const limit = inv.steps + budget;
    let checkpoint = inv.steps + checkpointAfter(inv.needs.filter((n) => n.status === "open").length);
    let reviews = 0;
    let reviewedAt = -1;
    let assessed = inv.needs.some((n) => n.status !== "open");
    let lastText = "";
    let summary = "";
    // ツールを呼ばない・同じ呼び出しを繰り返すだけの応答が続いても必ず終わるよう、応答の回数にも上限を設ける
    for (let turn = 0; turn < budget + MAX_REVIEWS + 2; turn++) {
      let stopped = false;
      if (inv.steps < limit) {
        const res = await this.deps.llm.chat({
          messages: inv.messages,
          tools: TOOL_DEFS,
          signal: hooks.signal,
          purpose: `関連コードの調査(${inv.steps + 1}手目〜)`,
        });
        if (res.toolCalls.length === 0) {
          lastText = res.content?.trim() || lastText;
          inv.messages.push({ role: "assistant", content: res.content ?? "" });
          stopped = true;
        } else {
          inv.messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls });
          await this.runTools(inv, res.toolCalls, limit, status);
          if (inv.steps < limit && inv.steps < checkpoint) {
            continue;
          }
        }
      }
      // ここに来るのは: 調査担当が自分で終えた / 確認する回数まで調べた / 上限に達した
      if (stopped && inv.steps === reviewedAt) {
        break; // 足りないと伝えても何も調べずに終えた: これ以上続けても進まない
      }
      const final = inv.steps >= limit;
      reviews++;
      reviewedAt = inv.steps;
      status(final ? "集めた材料を整理中..." : "集めた材料で足りるかを確認中...");
      const outcome = await this.review(inv, { change, final, remaining: limit - inv.steps }, hooks);
      if (!outcome) {
        break; // 確認できなければ、調査担当の判断で終える
      }
      assessed = true;
      summary = outcome.summary || summary;
      if (outcome.sufficient || final || reviews >= MAX_REVIEWS) {
        if (!outcome.sufficient) {
          status(`材料の確認: 調べきれなかったこと — ${needList(outcome.open)}`);
        }
        break;
      }
      status(`材料の確認: まだ分からないこと — ${needList(outcome.open)}。追加で調査します`);
      inv.messages.push({ role: "user", content: continueMessage(outcome, limit - inv.steps) });
      checkpoint = inv.steps + checkpointAfter(outcome.open.length);
    }
    // 一度も確認できていなければ、項目の状態は分からないので、調査担当のまとめだけを使う
    inv.notes = assessed ? formatNotes(inv.needs, summary || lastText) : lastText || inv.notes;
    markKeyLocations(inv.needs, inv.evidence);
  }

  /**
   * ツールを実行する。上限を超える分は実行せず、同じ呼び出しの繰り返しは回数に数えずに知らせる。
   * 最後に残りの回数とまだ分かっていない項目を添えて、予算を意識させる。
   */
  private async runTools(inv: Investigation, calls: ToolCall[], limit: number, status: (s: string) => void): Promise<void> {
    const ctx = this.toolContext(inv.evidence);
    for (const call of calls) {
      const key = `${call.name}:${canonicalArgs(call.arguments)}`;
      const done = inv.calls.get(key);
      let result: string;
      if (done !== undefined) {
        result = `この呼び出しは調査 ${done} で実行済みです(結果はその応答にあります)。別の調べ方をするか、分かったならツールを呼ばずに終えてください。`;
      } else if (inv.steps >= limit) {
        result = "ツール呼び出しの上限に達したため、実行しませんでした。";
      } else {
        inv.steps++;
        inv.calls.set(key, inv.steps);
        status(`調査 ${inv.steps}: ${call.name}(${summarizeArgs(call.arguments)})`);
        result = await executeTool(call.name, call.arguments, ctx);
      }
      inv.messages.push({ role: "tool", toolCallId: call.id, content: result });
    }
    const open = inv.needs.filter((n) => n.status === "open").map((n) => n.id);
    const last = inv.messages[inv.messages.length - 1]!;
    last.content += `\n\n(残りのツール呼び出し: ${limit - inv.steps}回${open.length > 0 ? `。まだ確かめていない項目: ${open.join(", ")}` : ""})`;
  }

  /** 材料が足りたかを、項目ごとに判断させる(会話の続きで、ツールを使わずに答えさせる)。失敗したら undefined */
  private async review(
    inv: Investigation,
    opts: { change: boolean; final: boolean; remaining: number },
    hooks: RunHooks,
  ): Promise<ReviewOutcome | undefined> {
    const gaps = definitionGaps(inv.needs, inv.evidence, this.deps.index);
    const request: ChatMessage = { role: "user", content: reviewRequest(inv.needs, { ...opts, gaps }) };
    try {
      const res = await this.deps.llm.chat({
        messages: [...inv.messages, request],
        jsonSchema: REVIEW_SCHEMA,
        signal: hooks.signal,
        purpose: opts.final ? "調査のまとめ" : "集めた材料で足りるかの確認",
      });
      const outcome = applyReview(inv.needs, parseJson<RawReview>(res.content), inv.evidence, opts);
      inv.messages.push(request, { role: "assistant", content: res.content ?? "" });
      return outcome;
    } catch (error) {
      if (hooks.signal?.aborted) {
        throw error;
      }
      return undefined;
    }
  }

  private async generateQuiz(inv: Investigation, requirement: string, hooks: RunHooks): Promise<GeneratedQuiz> {
    const { llm, config } = this.deps;
    const { mode, notes, evidence } = inv;
    const intent = detectIntent(inv.query);
    const knownText = evidence.allText();
    const needChange = requiresChange(mode, intent);
    const messages: ChatMessage[] = [
      { role: "system", content: quizSystemPrompt(mode, intent, config.level) },
      {
        role: "user",
        content: [
          `【ユーザーの要求】\n${requirement}`,
          notes ? `\n【調査メモ】\n${notes}` : "",
          `\n【参照コード(行番号 L数字| は表示用で、コードの一部ではない)】\n${evidence.render(config.evidenceChars)}`,
        ].join("\n"),
      },
    ];

    const accepted: QuizItem[] = [];
    const rejected: string[] = [];
    let goal = "";
    let overall = "";
    for (let attempt = 0; attempt < MAX_QUIZ_ATTEMPTS && accepted.length < MAX_ITEMS; attempt++) {
      const res = await llm.chat({
        messages,
        jsonSchema: QUIZ_SCHEMA,
        signal: hooks.signal,
        purpose: attempt === 0 ? "クイズの作成" : "クイズの作り直し",
      });
      const content = res.content ?? "";
      let parsed: { goal?: string; overallExplanation?: string; items?: RawItem[] };
      try {
        parsed = parseJson(content);
      } catch {
        if (accepted.length > 0) {
          break;
        }
        throw new Error("生成結果を解釈できませんでした。もう一度お試しください。");
      }
      goal ||= parsed.goal ?? "";
      overall ||= parsed.overallExplanation ?? "";

      const reasons: string[] = [];
      const notesForFix: string[] = [];
      for (const raw of parsed.items ?? []) {
        if (accepted.length >= MAX_ITEMS) {
          break;
        }
        if (raw?.kind === "read" && mode === "change") {
          reasons.push(`${raw.path}:${raw.startLine}-${raw.endLine} 今回は実装問題(kind="change")だけを出題します`);
          continue;
        }
        if (raw?.kind === "read" && needChange && !accepted.some((a) => a.kind === "change") && accepted.length >= MAX_ITEMS - 1) {
          continue; // 実装依頼では、実装問題の枠を最低1つ残す
        }
        const verdict = await this.validate(raw, knownText);
        if (verdict.ok) {
          const { item } = verdict;
          if (accepted.some((a) => a.path === item.path && a.startLine === item.startLine && a.quizCode === item.quizCode)) {
            continue; // 作り直しで合格済みの問題がもう一度返ってきた
          }
          accepted.push(item);
          notesForFix.push(...verdict.warnings);
        } else {
          reasons.push(verdict.reason);
        }
      }
      rejected.push(...reasons);
      // 1問も無いとき、または初回で2問未満しか残らなかったときは、不合格の問題だけ作り直させる
      const missingChange = needChange && !accepted.some((a) => a.kind === "change");
      const retry =
        missingChange || (reasons.length > 0 && (accepted.length === 0 || (attempt === 0 && accepted.length < 2)));
      if (!retry) {
        break;
      }
      messages.push(
        { role: "assistant", content },
        {
          role: "user",
          content: [
            accepted.length === 0
              ? "検証で全問不合格でした。"
              : `検証で${accepted.length}問は合格し、${reasons.length}問が不合格でした。合格した問題は出し直さないでください。`,
            "不合格の理由:",
            ...reasons.map((r) => `- ${r}`),
            ...(notesForFix.length > 0 ? ["参考(合格問題で除外した空欄):", ...notesForFix.map((r) => `- ${r}`)] : []),
            "",
            ...(missingChange
              ? [
                  "これは実装・修正の依頼なので、利用者が穴埋めで実装する kind=\"change\" の問題が必要ですが、まだ1問もありません。",
                  "変更を入れる範囲を参照コードから選んで oldCode に逐語で写し、newCode に変更後のコードを全部書き、変更した行に空欄を置いた change 問題を必ず含めてください。",
                ]
              : []),
            "参照コードを見直し、ルールを守って不合格だった問題の修正版(または別の範囲の問題)だけを items に入れて、JSON全体を出し直してください。",
            "空欄の target は、その行に実際に書かれている文字列をそのまま写してください。",
          ].join("\n"),
        },
      );
    }
    if (accepted.length === 0) {
      throw new Error(`検証に通る内容を作れませんでした。\n${rejected.slice(0, 4).join("\n")}`);
    }
    // 実装問題を主役にする: 手本の読解 → 実装 の順に並べる
    accepted.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "read" ? -1 : 1));
    const notice =
      needChange && !accepted.some((a) => a.kind === "change")
        ? "変更の考えどころを検証に通る形で作れなかったため、今回は既存コードの読み解きだけです。変更したい場所(ファイル名や関数名)を含めて質問し直すと、変更まで扱いやすくなります。"
        : undefined;
    return { goal, overallExplanation: overall, items: accepted, rejected, notice };
  }

  /** 実ファイルと照合して問題を組み立て、構文・手がかりの場所を確認する。 */
  private async validate(raw: RawItem, knownText: string): Promise<Validation> {
    const rel = normalizeRelPath(raw?.path ?? "");
    if (!rel) {
      return { ok: false, reason: `${raw?.path} はワークスペース相対パスではありません` };
    }
    raw.path = rel;
    let fileText: string;
    try {
      fileText = await this.deps.ws.readText(rel);
    } catch {
      return { ok: false, reason: `${rel} を読み込めません` };
    }
    const verdict = validateRawItem(raw, fileText, { knownText });
    if (!verdict.ok) {
      return verdict;
    }
    const { item } = verdict;
    if (item.kind === "change" && this.deps.syntax) {
      const before = await this.deps.syntax.isValid(rel, fileText);
      if (before === true) {
        const after = await this.deps.syntax.isValid(rel, applyItemToText(fileText, item));
        if (after === false) {
          return { ok: false, reason: `${rel}:${item.startLine}-${item.endLine} 正解で埋めると構文エラーになります` };
        }
      }
    }
    await this.checkRefs(item, fileText);
    // 空欄と関係のない先頭・末尾の行は出題範囲から外す(反映結果は変わらない)
    return { ...verdict, item: compactItem(item) };
  }

  /** 手がかり・参考コードの場所が実在し、その行に答えが書かれていないことを確かめる(満たさないものは外す)。 */
  private checkRefs(item: QuizItem, ownText: string): Promise<void> {
    return checkItemRefs((path) => this.deps.ws.readText(path), item, ownText);
  }

  /** 解答前に見える文章の答え漏れを LLM に書き直させ、それでも残るものは伏せ字にする。 */
  private removeLeaks(quiz: GeneratedQuiz, hooks: RunHooks): Promise<void> {
    return removeAnswerLeaks(this.deps.llm, this.deps.config.level ?? "intermediate", quiz, hooks);
  }
}

/** 手がかり・参考コードの場所が実在し、その行に答えが書かれていないことを確かめる(満たさないものは外す)。 */
export async function checkItemRefs(read: (path: string) => Promise<string>, item: QuizItem, ownText: string): Promise<void> {
  const cache = new Map<string, string[] | undefined>([[item.path, splitLines(ownText)]]);
  const answers = item.blanks.map((b) => b.answer);
  const verify = async (ref: CodeRef | undefined): Promise<CodeRef | undefined> => {
    const rel = ref && normalizeRelPath(ref.path);
    if (!ref || !rel) {
      return undefined;
    }
    if (!cache.has(rel)) {
      cache.set(rel, await read(rel).then(splitLines, () => undefined));
    }
    const lines = cache.get(rel);
    const text = lines?.[ref.line - 1];
    if (text === undefined || text.trim() === "") {
      return undefined;
    }
    const squashed = text.replace(/\s+/g, "");
    if (answers.some((a) => a.replace(/\s+/g, "").length >= 2 && squashed.includes(a.replace(/\s+/g, "")))) {
      return undefined;
    }
    return { ...ref, path: rel };
  };
  for (const b of item.blanks) {
    b.clue = await verify(b.clue);
  }
  const refs: CodeRef[] = [];
  for (const r of (item.refs ?? []).slice(0, 3)) {
    const ok = await verify(r);
    if (ok) {
      refs.push(ok);
    }
  }
  item.refs = refs;
  for (const b of item.blanks) {
    if (!b.clue) {
      delete b.clue;
    }
  }
}

/** 解答前に見える文章の答え漏れを LLM に書き直させ、それでも残るものは伏せ字にする。 */
export async function removeAnswerLeaks(
  llm: ChatLlm,
  level: LearnerLevel,
  quiz: Pick<GeneratedQuiz, "goal" | "items">,
  hooks: RunHooks = {},
): Promise<void> {
  const goal = { value: quiz.goal };
  let leaks = findLeaks(goal.value, quiz.items);
  if (leaks.length > 0) {
    try {
      const res = await llm.chat({
        messages: [
          {
            role: "system",
            content: [
              "あなたはコードの理解を支援する文章の編集者です。以下の文章は、解答前に利用者へ見せるのに、答え(空欄に入るコード)を漏らしています。",
              "各 id について、答えのコード片も、答えに含まれる識別子の組み合わせも使わずに、同じ役割の文章へ書き直してください。",
              "答えを言う代わりに、関わる概念・見るべき場所・考え方・答えの形(言葉で)を示します。日本語で、元と同じくらいの長さにします。",
              levelStyle(level),
            ].join("\n"),
          },
          {
            role: "user",
            content: leaks
              .map((l) => {
                const item = l.item !== undefined ? quiz.items[l.item] : undefined;
                return [
                  `id: ${l.id}`,
                  `種類: ${FIELD_LABEL[l.field]}`,
                  `現在の文章: ${l.text}`,
                  `漏れている答え: ${l.answers.join(" / ")}`,
                  item ? `問題のコード(___BLANK___が空欄):\n${item.quizCode}` : "",
                ]
                  .filter(Boolean)
                  .join("\n");
              })
              .join("\n\n"),
          },
        ],
        jsonSchema: LEAK_FIX_SCHEMA,
        signal: hooks.signal,
        purpose: "答え漏れの書き直し",
      });
      const fixes = parseJson<{ fixes?: Array<{ id: string; text: string }> }>(res.content).fixes ?? [];
      for (const leak of leaks) {
        const fix = fixes.find((f) => f.id === leak.id)?.text?.trim();
        if (fix && !leak.answers.some((a) => revealsAnswer(fix, a))) {
          applyLeakFix(goal, quiz.items, leak, fix);
        }
      }
    } catch (error) {
      if (hooks.signal?.aborted) {
        throw error;
      }
      // 書き直しに失敗しても、下の伏せ字処理で必ず漏れは塞ぐ
    }
    leaks = findLeaks(goal.value, quiz.items);
    for (const leak of leaks) {
      applyLeakFix(goal, quiz.items, leak, fallbackText(leak));
    }
  }
  quiz.goal = goal.value;
}
