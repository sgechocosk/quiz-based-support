import type { ChatLlm, ChatMessage, LspPort, SyntaxChecker, WorkspacePort } from "./ports";
import { applyItemToText, validateRawItem, type RawItem, type SemanticJudge } from "./quiz";
import { EvidenceStore, executeTool, TOOL_DEFS, type CodeIndex } from "./tools";
import type { GeneratedQuiz, QuizItem } from "./types";

export type QuizMode = "auto" | "change" | "read";

export interface AgentConfig {
  maxSteps: number;
  minSimilarity: number;
  repoMapChars: number;
  evidenceChars: number;
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

const STRING = { type: "string" } as const;

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
            startLine: { type: "integer" },
            endLine: { type: "integer" },
            firstLine: STRING,
            lastLine: STRING,
            quizCode: STRING,
            blanks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  answer: STRING,
                  concept: STRING,
                  hintConcept: STRING,
                  hintApproach: STRING,
                  hintSyntax: STRING,
                },
                required: ["answer", "concept", "hintConcept", "hintApproach", "hintSyntax"],
                additionalProperties: false,
              },
            },
            explanation: STRING,
          },
          required: ["kind", "path", "startLine", "endLine", "firstLine", "lastLine", "quizCode", "blanks", "explanation"],
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
    `- ツール呼び出しは最大${maxSteps}回まで。必要十分に調べたら、ツールを呼ばずに「どのファイルの何行目付近が重要で、なぜか」を短い箇条書きで答えて終了する。`,
    "- 行番号は read_file の表示(L数字|)のとおりに引用する。推測で行番号を作らない。",
    "",
    "【リポジトリ概観(ファイル — 主なシンボル。他から参照される順)】",
    repoMap || "(インデックス未作成のため概観なし。list_files / grep を使ってください)",
  ].join("\n");
}

export function quizSystemPrompt(mode: QuizMode): string {
  const modeLine =
    mode === "read"
      ? "今回はすべて kind=\"read\" にする。"
      : mode === "change"
        ? "今回はすべて kind=\"change\" にする。"
        : "要求が質問(〜はどう動く/どこにある)なら read、実装・修正の依頼なら change を中心にする。迷えば read。";
  return [
    "あなたはプログラミング学習アシスタントです。調査済みのコードだけを根拠に、ユーザーが自分で考えて理解できる穴埋めクイズを作ります。",
    "出力は指定のJSONスキーマに厳密に従ってください。",
    "",
    "【問題の種類 kind】",
    "- \"read\": 既存コードの理解問題。quizCode は対象範囲の実コードをそのまま写し(インデント・空白の差は可)、重要な箇所だけを ___BLANK___ に置き換える。正解で埋めると実コードに戻ること(システムが自動検証し、戻らない問題は破棄される)。",
    "- \"change\": 実装・修正の問題。ユーザーの要求を満たす変更後のコードを quizCode に書き、変更の核心を ___BLANK___ にする。変更しない行はそのまま。正解で埋めると元コードと異なること。",
    modeLine,
    "",
    "【共通ルール】",
    "- items は1〜3件。各 item の範囲は連続した40行以内を目安にし、path/startLine/endLine は「参照コード」の表示どおり。firstLine/lastLine には範囲の最初と最後の行を逐語で入れる(行番号のずれを補正するために使う)。",
    "- ___BLANK___ は item あたり3〜6個。単語1〜2つ、または意味のある単位(条件式、メソッド呼び出し、型注釈、引数リスト、代入値)。blanks は quizCode での出現順。",
    "- answer は60文字以内で、周囲のコードから一つに絞れる箇所を選ぶ(同じ意味の書き方が複数ありうる箇所は避ける)。",
    "- hintConcept / hintApproach / hintSyntax は段階的ヒント。(1)どんな概念を使うか (2)どこを見てどう考えるか (3)答えの形(骨組み)。いずれも正解そのものは書かず、「〇〇するために、□□を使って、〜する」の形で書く。",
    "- concept は復習用の短いタグ(例: 非同期処理、条件分岐、配列操作、型注釈、状態管理)。",
    "- goal: このクイズで何を理解してほしいかを1〜2文。答えは含めない。",
    "- explanation(各item)と overallExplanation: 採点後に読まれる解説。なぜそのコードになるか、全体の流れ。答えを書いてよい。___BLANK___ は使わない。",
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

/**
 * 2段構えのエージェント。
 * 1) 調査: LLMがツール(検索・grep・読み取り・LSP)を自分で呼んで関連コードを探す(エージェント型検索)
 * 2) 出題: 実際に読んだコードだけを根拠に構造化JSONでクイズを作り、実ファイルと突き合わせて検証する
 */
export class QuizAgent {
  constructor(private readonly deps: AgentDeps) {}

  async run(query: string, mode: QuizMode, hooks: RunHooks = {}): Promise<AgentResult> {
    const { llm, ws, lsp, index, config } = this.deps;
    const status = hooks.onStatus ?? (() => undefined);
    const evidence = new EvidenceStore();
    const ctx = { ws, lsp, index, evidence, minSimilarity: config.minSimilarity };

    const messages: ChatMessage[] = [
      { role: "system", content: exploreSystemPrompt(config.maxSteps, index.repoMap(config.repoMapChars)) },
      { role: "user", content: query },
    ];

    let notes = "";
    let steps = 0;
    status("関連コードを調査中...");
    for (let turn = 0; turn <= config.maxSteps; turn++) {
      const exhausted = steps >= config.maxSteps;
      const res = await llm.chat({ messages, tools: exhausted ? undefined : TOOL_DEFS, signal: hooks.signal });
      if (res.toolCalls.length === 0 || exhausted) {
        notes = res.content ?? "";
        break;
      }
      messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        steps++;
        status(`調査 ${steps}: ${call.name}(${summarizeArgs(call.arguments)})`);
        const result = await executeTool(call.name, call.arguments, ctx);
        messages.push({ role: "tool", toolCallId: call.id, content: result });
      }
    }

    if (evidence.isEmpty()) {
      // 何も読まずに終えた場合の保険: 質問そのもので検索して上位を読ませる
      await executeTool("search_code", JSON.stringify({ query, k: 4 }), ctx);
    }
    if (evidence.isEmpty()) {
      throw new Error("関連するコードが見つかりませんでした。キーワードや関数名を含めて質問し直してください。");
    }

    status("クイズを作成中...");
    const quiz = await this.generateQuiz(query, mode, notes, evidence, hooks);
    return { quiz, evidencePaths: evidence.paths(), notes, steps };
  }

  private async generateQuiz(
    query: string,
    mode: QuizMode,
    notes: string,
    evidence: EvidenceStore,
    hooks: RunHooks,
  ): Promise<GeneratedQuiz> {
    const { llm, config } = this.deps;
    const messages: ChatMessage[] = [
      { role: "system", content: quizSystemPrompt(mode) },
      {
        role: "user",
        content: [
          `【ユーザーの要求】\n${query}`,
          notes ? `\n【調査メモ】\n${notes}` : "",
          `\n【参照コード(行番号 L数字| は表示用で、コードの一部ではない)】\n${evidence.render(config.evidenceChars)}`,
        ].join("\n"),
      },
    ];

    const rejected: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await llm.chat({ messages, jsonSchema: QUIZ_SCHEMA, signal: hooks.signal });
      const content = res.content ?? "";
      let parsed: { goal?: string; overallExplanation?: string; items?: RawItem[] };
      try {
        parsed = JSON.parse(content.replace(/^```json\s*|```\s*$/g, "").trim());
      } catch {
        throw new Error("クイズのJSONを解釈できませんでした。もう一度お試しください。");
      }
      const accepted: QuizItem[] = [];
      const reasons: string[] = [];
      for (const raw of (parsed.items ?? []).slice(0, 3)) {
        const verdict = await this.validate(raw);
        if (verdict.ok) {
          accepted.push(verdict.item);
        } else {
          reasons.push(verdict.reason);
        }
      }
      rejected.push(...reasons);
      if (accepted.length > 0) {
        return {
          goal: parsed.goal ?? "",
          overallExplanation: parsed.overallExplanation ?? "",
          items: accepted,
          rejected,
        };
      }
      messages.push(
        { role: "assistant", content },
        {
          role: "user",
          content: `検証で全問不合格でした。理由:\n${reasons.map((r) => `- ${r}`).join("\n")}\n\nルールを守って、JSON全体を出し直してください。`,
        },
      );
    }
    throw new Error(`検証に通るクイズを作れませんでした。\n${rejected.slice(0, 4).join("\n")}`);
  }

  private async validate(raw: RawItem): Promise<ReturnType<typeof validateRawItem>> {
    let fileText: string;
    try {
      fileText = await this.deps.ws.readText(raw.path);
    } catch {
      return { ok: false, reason: `${raw.path} を読み込めません` };
    }
    const verdict = validateRawItem(raw, fileText);
    if (!verdict.ok || verdict.item.kind !== "change" || !this.deps.syntax) {
      return verdict;
    }
    const before = await this.deps.syntax.isValid(raw.path, fileText);
    if (before === true) {
      const after = await this.deps.syntax.isValid(raw.path, applyItemToText(fileText, verdict.item));
      if (after === false) {
        return { ok: false, reason: `${raw.path}:${verdict.item.startLine}-${verdict.item.endLine} 正解で埋めると構文エラーになります` };
      }
    }
    return verdict;
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
