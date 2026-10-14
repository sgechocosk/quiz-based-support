import { maskAnswers, revealsAnswer } from "./leak";
import { levelGuide, levelStyle, type LearnerLevel } from "./level";
import type { ChatLlm, ChatMessage, LspPort, SyntaxChecker, WorkspacePort } from "./ports";
import { applyItemToText, compactItem, validateRawItem, type RawItem, type SemanticJudge, type Validation } from "./quiz";
import { splitLines } from "./text";
import { EvidenceStore, executeTool, normalizeRelPath, TOOL_DEFS, type CodeIndex } from "./tools";
import type { CodeRef, GeneratedQuiz, QuizItem } from "./types";

export type QuizMode = "auto" | "change" | "read";

export interface AgentConfig {
  maxSteps: number;
  minSimilarity: number;
  repoMapChars: number;
  evidenceChars: number;
  /** 学習者のレベル(解説の細かさ・用語・空欄の難しさ) */
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
  /** 1回のクイズで扱える規模を超える見込みか */
  large: boolean;
  questions: ClarifyQuestion[];
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
/** 1回のクイズで扱える変更行数の目安(実装問題は最大 MAX_ITEMS か所・各25行程度) */
export const LARGE_CHANGE_LINES = 60;
/** 要件の回答を受けて行う追加調査のツール呼び出し上限 */
const FOLLOW_UP_STEPS = 3;

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
            "kind", "path", "startLine", "endLine", "firstLine", "lastLine", "task", "newCode", "blanks", "refs", "newNames", "explanation",
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
    "あなたはコードベース理解を支援する学習アシスタントの「調査担当」です。",
    "ユーザーの要求に関係するコードをツールで調べて特定してください。この段階ではクイズも回答コードも作りません。",
    "",
    "【進め方】",
    "- まず下の「リポジトリ概観」で当たりを付け、search_code(識別子や英語のキーワードを含めると精度が上がる)で探す。名前や文字列を厳密に探すなら grep。",
    "- 候補が見つかったら read_file で実際のコードを読む。構造や呼び出し関係は outline / find_references / find_definition で確かめる。",
    "- 要求が「〜を追加・修正したい」なら、変更が入る場所と、手本にすべき既存の実装を見つける。「〜はどう動く/どこ?」なら、中心となる処理と呼び出し関係を見つける。",
    "- 中心のコードが呼んでいる関数・使っている型の定義も read_file で読んでおく(学習者が答えを自力で導くための手がかりとして使う)。",
    `- ツール呼び出しは最大${maxSteps}回まで。必要十分に調べたら、ツールを呼ばずに「どのファイルの何行目付近が重要で、なぜか(何を受け取り、何を返し、誰から呼ばれるか)」を短い箇条書きで答えて終了する。`,
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
    required: ["decision", "reason", "understanding", "estimatedFiles", "estimatedLines", "questions"],
    additionalProperties: false,
  },
} as const;

export function scopeSystemPrompt(level: LearnerLevel = "intermediate"): string {
  return [
    "あなたはプログラミング学習アシスタントの「要件確認担当」です。ユーザーの実装・修正の依頼と調査済みのコードを読み、",
    "このまま実装問題(学習者が穴埋めで実装を完成させるクイズ)を作ってよいか、先にユーザーへ要件を確認すべきかを判断します。",
    `1回のクイズで実装できるのは、最大${MAX_ITEMS}か所・各25行程度の変更までです。要件があいまいなまま作ると、ユーザーの意図と違うコードを「正解」として教えてしまいます。`,
    "出力は指定のJSONスキーマに厳密に従ってください。",
    "",
    "【先に確認する(decision=\"clarify\")場合】",
    `1. 変更が大きい: ${MAX_ITEMS}つより多いファイル・関数にまたがる、新しいファイル・クラス・画面・設定項目が必要、または変更行が合計でおよそ${LARGE_CHANGE_LINES}行を超える。`,
    "   → 「今回どの段階から実装するか」を必ず1問含める。選択肢は、それだけで動作が完結する小さな段階にし、依存される側(データ・型・中核の処理)から順に並べる。",
    "2. 解釈や方針が複数ある: 仕様(入力・出力・境界条件・エラー時の扱い・既存の動作を変えるか)や実装の方針(どこに置くか、既存の仕組みを拡張するか新しく作るか)に",
    "   もっともらしい案が複数あり、どれを選ぶかで完成するコードが大きく変わる。",
    "   → 案ごとに選択肢を作る。",
    "",
    "【確認しない(decision=\"proceed\")場合】",
    "- 変更が小さく、要求からやるべきことが一つに決まる。",
    "- 迷う点が、新しい名前や細かな書き方など、既存コードの慣習に合わせて出題側で決められることだけ。",
    "- 調査済みのコードを読めば答えが決まること(既存の関数・型・手本の実装)は質問しない。",
    "",
    "【質問の作り方】",
    "- questions は clarify のとき1〜3問、proceed のときは空配列。ユーザーが選択肢を選ぶだけで答えられる形にし、重要な順に並べる。",
    "- options は各質問に2〜4個。label は短い案の名前。detail には、選ぶと何がどう変わるか(触るファイル・関数、動作の違い)を参照コードの名前を使って1〜2文で書く。",
    "- recommended は、既存コードの設計と最も整合する案1つだけを true にする(決められなければすべて false)。",
    "- why: その点を決めないと何があいまいなまま実装されるかを1文で。",
    "- understanding: 依頼をどう理解したかを1〜2文で。reason: 確認が必要な理由(clarify)または不要な理由(proceed)を1文で。",
    "- estimatedFiles / estimatedLines: 依頼を全部実装した場合に変更するファイル数と変更行数(追加+削除)の見積もり。decision に関わらず正直に書く。",
    "- " + levelStyle(level),
  ].join("\n");
}

interface RawScope {
  decision?: string;
  reason?: string;
  understanding?: string;
  estimatedFiles?: number;
  estimatedLines?: number;
  questions?: Array<{
    question?: string;
    why?: string;
    options?: Array<{ label?: string; detail?: string; recommended?: boolean }>;
  }>;
}

/**
 * 要件確認の結果を判定する。
 * - 確認が必要(LLM が clarify と判断した、または見積もりが1回のクイズの規模を超える)で、答えられる質問がある → Clarification
 * - 確認が必要なのに答えられる質問が無い → "missing"(質問を作り直させる)
 * - 確認は不要 → undefined
 */
export function decideClarification(raw: RawScope | undefined): Clarification | "missing" | undefined {
  const count = (n: unknown) => Math.max(0, Math.round(Number(n) || 0));
  const estimatedFiles = count(raw?.estimatedFiles);
  const estimatedLines = count(raw?.estimatedLines);
  const large = estimatedFiles > MAX_ITEMS || estimatedLines > LARGE_CHANGE_LINES;
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
  if (questions.length === 0) {
    return "missing";
  }
  const reason =
    raw?.decision !== "clarify"
      ? `変更が大きくなる見込み(約${estimatedFiles}ファイル・約${estimatedLines}行)のため、実装する範囲を先に決めます。`
      : raw.reason?.trim() ?? "";
  return { understanding: raw?.understanding?.trim() ?? "", reason, estimatedFiles, estimatedLines, large, questions };
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
    "【ユーザーに確認した要件(これに従って、実装する範囲と仕様を決める。範囲を絞った場合は、その範囲だけを実装問題にする)】",
    ...answers.map((a) => `- ${a.question} → ${a.answer}`),
  ].join("\n");
}

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

export function quizSystemPrompt(mode: QuizMode, intent: QuizIntent = "read", level: LearnerLevel = "intermediate"): string {
  const modeLine =
    mode === "read"
      ? "今回はすべて kind=\"read\" にする。"
      : mode === "change"
        ? "今回はすべて kind=\"change\" にする。"
        : intent === "change"
          ? "今回の要求は実装・修正の依頼。学習者が穴埋めで実装を完成させる kind=\"change\" を必ず1問以上作る(これが主役)。" +
            "加えて、実装の前に理解しておくべき重要なコードや設計(変更が依存する既存の仕組み・手本になる実装・データ構造・独自の約束事)があれば、kind=\"read\" を最大2問含めてよい。理解の助けにならない読解は入れない。"
          : "今回の要求は仕組みについての質問。kind=\"read\" を中心にする。";
  return [
    "あなたはプログラミング学習アシスタントです。答えを直接教えるのではなく、調査済みのコードだけを根拠に、",
    "学習者が「どのファイルのどのコードが、どういう仕組みで動いているか」を自分で考えて理解できる穴埋めクイズを作ります。",
    "空欄は手入力ではなく選択式(正解1つ + 誤答3つ)。学習者は選択肢を比べながらコードベースを読み、根拠を持って選びます。",
    "出力は指定のJSONスキーマに厳密に従ってください。",
    "",
    "【問題の種類 kind】",
    "- \"read\": 既存コードの読解問題。対象範囲(path/startLine/endLine)を指定し、空欄にする部分を blanks で指定する。",
    "  コードを書き写す必要はない(システムが実ファイルから問題を組み立てる)。newCode は空文字にする。",
    "- \"change\": 実装・修正の問題。newCode に、対象範囲を置き換える「変更後のコード」を空欄なしで全部書く。",
    "  変更しない行は参照コードと一字一句同じにする。空欄のうち少なくとも1つは変更した行に置く。",
    "",
    "【新しい名前は先に決めて示す(理不尽な問題を作らない)】",
    "- change で新しく作るメソッド・関数・変数・引数・フィールド・クラスの名前は、あなたが決めて newNames に {name, role} で全部書く(role はその名前の役割を一言で)。これらは解答前に学習者へ表示される。",
    "- 新しい名前そのもの(例: 定義行の名前部分)は空欄にしない。空欄にするのは、その名前を使って何をするか(条件・呼び出し・引数・戻り値など)。",
    "- 既存コードに無い関数を呼ぶなら、その定義も newCode に含めて newNames に載せる。参照コードに無い既存関数を想像で呼ばない。",
    "- 名前はプロジェクトの既存の命名規則(大文字小文字・接頭辞・動詞の使い方)に合わせる。read では newNames は空配列。",
    modeLine,
    "",
    "【空欄 blanks の指定】",
    "- line: read はファイルの行番号(参照コードの L数字)、change は newCode の中での行番号(1始まり)。",
    "- target: その行に逐語で含まれる、空欄にする部分の文字列(1行以内・60文字以内)。行全体ではなく、条件式・呼び出し・引数・代入値・型など意味のある単位。",
    "- 個数と難しさは下の【学習者のレベル】に従う。周囲のコードと手がかりから一つに絞れる箇所を選ぶ(同じ意味の書き方が複数ありうる箇所や、根拠なく推測するしかない箇所は避ける)。",
    "",
    "【選択肢 distractors(誤答を3つ)】",
    "- 目的は「コードベースを読んで根拠を確かめないと選べない」こと。勘や見た目で消去できる誤答は作らない。",
    "- 良い誤答: 実在する似た名前の別の関数・変数・フィールド(責務が違う)/ 引数の取り違え・順序違い / 境界条件の違い(< と <=)/ 条件の反転 /",
    "  同じファイルの別の箇所にある似た式 / 呼ぶ順序や呼ぶ相手を間違えたもの。どれもこのコードベースで実際に書かれうるもの。",
    "- 誤答には、参照コードに無い名前を使わない(存在しない名前は見ただけで誤りと分かる)。新しく作る名前(newNames)は使ってよい。",
    "- 正解と書き方が違うだけで同じ動作になるもの(等価な書き換え)は誤答にしない。",
    "- 正解と長さ・形をそろえる(正解だけが長い・具体的、などで見分けられないように)。各誤答は1行・60文字以内。",
    "- whyWrong(採点後に表示。ヒントで1つ消すときにも表示): なぜ誤りかを、根拠のファイル名:行と仕組みで1〜2文。正解のコードは書かない。",
    "",
    "【答えを漏らさない(最重要)】",
    "解答前に見えるのは goal・task・refs・concept・2段階ヒント・clueNote。これらには、どの空欄の答えのコード片も、答えの識別子の組み合わせも書かない。",
    "- hintConcept: どんな概念・仕組みが関わるか(例: 「非同期処理の完了を待つ必要がある」)。",
    "- hintApproach: どこを見て、どう考えれば選択肢を絞れるか(例: 「この関数の戻り値の型と、呼び出し元での使われ方を見比べる」)。",
    "- cluePath/clueLine/clueNote: 答えを導く根拠になる「別の場所」(呼び出す関数の定義・型定義・手本になる類似コードなど)。参照コードにある行を指定し、",
    "  その行自体に答えが書かれていてはいけない。適切な場所が無ければ cluePath は空文字、clueLine は0。",
    "",
    "【学習者が導けるための説明】",
    "- task(解答前に表示): read なら「この範囲がシステムの中で何を担い、どこから呼ばれ、何を読み取ってほしいか」。",
    "  change なら「何を実現するために、どこを、どう変えるか」という仕様(入力・出力・満たすべき条件・使うべき既存の関数や手本)。答えのコードは書かない。",
    "- refs(解答前に表示, 0〜3件): 読むと理解が進む参照コードの場所(path, line, なぜ見るべきか)。",
    "- why(採点後に表示): その空欄がなぜそのコードになるか。根拠となる行(ファイル名:行)と、仕組み(データの流れ・型・呼び出し関係)を2〜3文で。",
    "- explanation(各item・採点後): この範囲の役割、処理の流れ、他のファイルとの関係(誰が呼び、何を呼ぶか)を具体的に。",
    "- overallExplanation(採点後): 要求に関わるシステム全体の流れを、ファイル名を挙げながら順に説明する。",
    "- goal: このクイズで何を理解してほしいかを1〜2文。答えは含めない。",
    "",
    "【共通ルール】",
    "- items は1〜3件。path/startLine/endLine は参照コードの表示どおり。firstLine/lastLine には範囲の最初と最後の行を逐語で入れる。",
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

function parseJson<T>(content: string | null | undefined): T {
  return JSON.parse((content ?? "").replace(/^```json\s*|```\s*$/g, "").trim()) as T;
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
function fallbackText(leak: Leak, items: QuizItem[]): string {
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
 * 1) 調査: LLMがツール(検索・grep・読み取り・LSP)を自分で呼んで関連コードを探す(エージェント型検索)
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
    const inv: Investigation = {
      query,
      mode,
      messages: [
        { role: "system", content: exploreSystemPrompt(config.maxSteps, index.repoMap(config.repoMapChars)) },
        {
          role: "user",
          content: requiresChange(mode, detectIntent(query))
            ? `${query}\n\n(これは実装・修正の依頼です。変更を入れる場所と、手本にすべき既存の実装を必ず特定してください)`
            : query,
        },
      ],
      evidence: new EvidenceStore(),
      notes: "",
      steps: 0,
    };
    hooks.onStatus?.("関連コードを調査中...");
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
   * 実装依頼のとき、変更が大きい、または解釈・方針が複数あるなら、ユーザーへの質問を返す(出題には進まない)。
   * 確認が不要なとき・確認できなかったときは undefined(そのまま出題してよい)。
   */
  async clarify(inv: Investigation, hooks: RunHooks = {}): Promise<Clarification | undefined> {
    const { llm, config } = this.deps;
    if (!requiresChange(inv.mode, detectIntent(inv.query))) {
      return undefined;
    }
    hooks.onStatus?.("変更の規模と、仕様の決め方が複数ないかを確認中...");
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
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await llm.chat({ messages, jsonSchema: SCOPE_SCHEMA, signal: hooks.signal });
        const verdict = decideClarification(parseJson<RawScope>(res.content));
        if (verdict !== "missing") {
          return verdict;
        }
        messages.push(
          { role: "assistant", content: res.content ?? "" },
          {
            role: "user",
            content:
              "確認が必要な依頼(変更が大きい、または案が複数ある)ですが、選択肢が2つ以上ある質問がありません。" +
              "decision=\"clarify\" とし、ユーザーが選ぶだけで答えられる質問(各2〜4個の選択肢)を1〜3問作って、JSON全体を出し直してください。",
          },
        );
      }
    } catch (error) {
      if (hooks.signal?.aborted) {
        throw error;
      }
      // 確認の判定に失敗しても、出題そのものは止めない
    }
    return undefined;
  }

  /** 調査結果(と確認した要件)からクイズを作る。 */
  async compose(inv: Investigation, answers: ClarifyAnswer[] = [], hooks: RunHooks = {}): Promise<AgentResult> {
    const status = hooks.onStatus ?? (() => undefined);
    if (answers.length > 0) {
      // 選んだ案によっては、まだ読んでいない場所に変更が入るので、調査の続きで確かめさせる
      status("回答した要件をもとに、関連コードを追加で調査中...");
      inv.messages.push({
        role: "user",
        content: [
          "ユーザーに要件を確認し、次の回答を得ました。",
          ...answers.map((a) => `- ${a.question} → ${a.answer}`),
          "この要件で変更が入る場所と手本になる実装のうち、まだ読んでいないものがあれば追加で調べてください。",
          "最後に、この要件に関係する重要な場所を、前回と同じ形式の箇条書きでまとめ直してください。",
        ].join("\n"),
      });
      await this.explore(inv, FOLLOW_UP_STEPS, hooks);
    }
    status("クイズを作成中...");
    const quiz = await this.generateQuiz(inv, requirementText(inv.query, answers), hooks);
    status("ヒントが答えを漏らしていないか確認中...");
    await this.removeLeaks(quiz, hooks);
    return { quiz, evidencePaths: inv.evidence.paths(), notes: inv.notes, steps: inv.steps };
  }

  private toolContext(evidence: EvidenceStore) {
    const { ws, lsp, index, config } = this.deps;
    return { ws, lsp, index, evidence, minSimilarity: config.minSimilarity };
  }

  /** 調査の会話を続け、ツール呼び出しが budget 回に達するか LLM がまとめを返したら終える。 */
  private async explore(inv: Investigation, budget: number, hooks: RunHooks): Promise<void> {
    const { llm } = this.deps;
    const status = hooks.onStatus ?? (() => undefined);
    const ctx = this.toolContext(inv.evidence);
    const limit = inv.steps + budget;
    for (let turn = 0; turn <= budget; turn++) {
      const exhausted = inv.steps >= limit;
      const res = await llm.chat({ messages: inv.messages, tools: exhausted ? undefined : TOOL_DEFS, signal: hooks.signal });
      if (res.toolCalls.length === 0 || exhausted) {
        inv.notes = res.content?.trim() ? res.content : inv.notes;
        inv.messages.push({ role: "assistant", content: res.content ?? "" });
        return;
      }
      inv.messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        inv.steps++;
        status(`調査 ${inv.steps}: ${call.name}(${summarizeArgs(call.arguments)})`);
        const result = await executeTool(call.name, call.arguments, ctx);
        inv.messages.push({ role: "tool", toolCallId: call.id, content: result });
      }
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
      const res = await llm.chat({ messages, jsonSchema: QUIZ_SCHEMA, signal: hooks.signal });
      const content = res.content ?? "";
      let parsed: { goal?: string; overallExplanation?: string; items?: RawItem[] };
      try {
        parsed = parseJson(content);
      } catch {
        if (accepted.length > 0) {
          break;
        }
        throw new Error("クイズのJSONを解釈できませんでした。もう一度お試しください。");
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
                  "これは実装・修正の依頼なので、学習者が穴埋めで実装する kind=\"change\" の問題が必要ですが、まだ1問もありません。",
                  "変更を入れる範囲を参照コードから選び、newCode に変更後のコードを全部書き、変更した行に空欄を置いた change 問題を必ず含めてください。",
                ]
              : []),
            "参照コードを見直し、ルールを守って不合格だった問題の修正版(または別の範囲の問題)だけを items に入れて、JSON全体を出し直してください。",
            "空欄の target は、その行に実際に書かれている文字列をそのまま写してください。",
          ].join("\n"),
        },
      );
    }
    if (accepted.length === 0) {
      throw new Error(`検証に通るクイズを作れませんでした。\n${rejected.slice(0, 4).join("\n")}`);
    }
    // 実装問題を主役にする: 手本の読解 → 実装 の順に並べる
    accepted.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "read" ? -1 : 1));
    const notice =
      needChange && !accepted.some((a) => a.kind === "change")
        ? "実装問題を検証に通る形で作れなかったため、今回は読解問題のみです。変更したい場所(ファイル名や関数名)を含めて質問し直すと、実装問題を作りやすくなります。"
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
  private async checkRefs(item: QuizItem, ownText: string): Promise<void> {
    const cache = new Map<string, string[] | undefined>([[item.path, splitLines(ownText)]]);
    const answers = item.blanks.map((b) => b.answer);
    const verify = async (ref: CodeRef | undefined): Promise<CodeRef | undefined> => {
      const rel = ref && normalizeRelPath(ref.path);
      if (!ref || !rel) {
        return undefined;
      }
      if (!cache.has(rel)) {
        cache.set(rel, await this.deps.ws.readText(rel).then(splitLines, () => undefined));
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
  private async removeLeaks(quiz: GeneratedQuiz, hooks: RunHooks): Promise<void> {
    const goal = { value: quiz.goal };
    let leaks = findLeaks(goal.value, quiz.items);
    if (leaks.length > 0) {
      try {
        const res = await this.deps.llm.chat({
          messages: [
            {
              role: "system",
              content: [
                "あなたはプログラミング学習クイズの編集者です。以下の文章は、解答前に学習者へ見せるのに、答え(空欄に入るコード)を漏らしています。",
                "各 id について、答えのコード片も、答えに含まれる識別子の組み合わせも使わずに、同じ役割の文章へ書き直してください。",
                "答えを言う代わりに、関わる概念・見るべき場所・考え方・答えの形(言葉で)を示します。日本語で、元と同じくらいの長さにします。",
                levelStyle(this.deps.config.level ?? "intermediate"),
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
        applyLeakFix(goal, quiz.items, leak, fallbackText(leak, quiz.items));
      }
    }
    quiz.goal = goal.value;
  }
}

const JUDGE_SCHEMA = {
  name: "judge",
  schema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: { index: { type: "integer" }, equivalent: { type: "boolean" }, reason: STRING },
          required: ["index", "equivalent", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  },
} as const;

/** 厳密一致しなかった回答が「文脈上、同じ動作になるか」をLLMに判定させる(任意機能)。 */
export function makeSemanticJudge(llm: ChatLlm): SemanticJudge {
  return async (cases) => {
    const res = await llm.chat({
      messages: [
        {
          role: "system",
          content:
            "あなたはプログラミング課題の採点者です。穴埋めの回答が、模範解答と『その文脈で同じ動作・同じ意味になるか』を判定します。変数名だけの違いや等価な書き換えは equivalent=true。動作が変わる、または別の意味になるなら false。迷ったら false。reason は日本語で1文。",
        },
        {
          role: "user",
          content: cases
            .map((c, i) => `#${i}\n文脈(___BLANK___が穴):\n${c.context}\n模範解答: ${c.expected}\n回答: ${c.given}`)
            .join("\n\n"),
        },
      ],
      jsonSchema: JUDGE_SCHEMA,
    });
    const parsed = JSON.parse(res.content ?? "{}") as { results?: Array<{ index: number; equivalent: boolean; reason: string }> };
    return cases.map((_, i) => {
      const r = parsed.results?.find((x) => x.index === i);
      return { equivalent: r?.equivalent === true, reason: r?.reason ?? "" };
    });
  };
}
