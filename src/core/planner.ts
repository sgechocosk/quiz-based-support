import type { Investigation, RunHooks } from "./agent";
import { coChangeSuggestions, keyLiteralsOf, quotedLiteralPattern } from "./coupling";
import { declarationsOf } from "./declarations";
import { diffStat, lineMapper } from "./diff";
import { impactOfStep, MAX_SITES, siteAt, type ImpactContext } from "./impact";
import { levelStyle, type LearnerLevel } from "./level";
import { applyEdits, toWorkspacePath, VirtualWorkspace, type RawEdit } from "./overlay";
import { describeRules, PATTERNS, type PatternId, type ProjectRule } from "./patterns";
import {
  STEP_KINDS,
  type ChangePlan,
  type Obligation,
  type PlanStep,
  type RequirementSpec,
  type Site,
  type StepKind,
} from "./planTypes";
import type { ChatLlm, ChatMessage, HistoryPort, LspPort, SyntaxChecker, TypeChecker, TypeDiagnostic, WorkspacePort } from "./ports";
import { compactDiff } from "./quiz";
import { stageBrief } from "./stages";
import { numberLines, parseJson, splitLines, truncate } from "./text";

/**
 * 変更計画を作る。
 * 1) 起点の変更: 要件を直接満たす変更を LLM に書かせ、仮想ワークスペースに重ねる
 * 2) 影響の閉包: 変更の種類ごとの伝播ルール(参照・文字列キー・変更履歴・プロジェクトの約束)と型検査で確認事項を作り、
 *    確認事項が無くなるまで(または上限まで)、1か所ずつ「変更が必要か」を判断させて直す
 * 3) 並べ替え: 依存される側から説明できる順にステップを並べる
 * 途中の判断(どの変更に引きずられたか・変更しなかった理由)はすべて記録し、説明の材料にする。
 */

export interface PlannerDeps {
  llm: ChatLlm;
  ws: WorkspacePort;
  lsp?: LspPort;
  syntax?: SyntaxChecker;
  typeChecker?: TypeChecker;
  history?: HistoryPort;
  rules?: ProjectRule[];
  config: { level?: LearnerLevel; evidenceChars: number };
}

export const PLAN_LIMITS = {
  /** 起点のステップの上限 */
  initialSteps: 6,
  /** 確認事項を判断する回数の上限 */
  rounds: 4,
  /** 1回に判断させる確認事項の数 */
  batch: 6,
  /** ステップの上限 */
  steps: 12,
  /** 変更行数(追加+削除)の上限 */
  changedLines: 400,
};

const STRING = { type: "string" } as const;
const INTEGER = { type: "integer" } as const;
const BOOLEAN = { type: "boolean" } as const;

const EDIT_ITEM = {
  type: "object",
  properties: { path: STRING, create: BOOLEAN, startLine: INTEGER, oldCode: STRING, newCode: STRING },
  required: ["path", "create", "startLine", "oldCode", "newCode"],
  additionalProperties: false,
} as const;

const STEP_FIELDS = {
  label: STRING,
  kind: { type: "string", enum: STEP_KINDS },
  why: STRING,
  contract: STRING,
  mechanical: BOOLEAN,
  edits: { type: "array", items: EDIT_ITEM },
} as const;

export const PLAN_SCHEMA = {
  name: "change_plan",
  schema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: { id: STRING, dependsOn: { type: "array", items: STRING }, requirements: { type: "array", items: INTEGER }, ...STEP_FIELDS },
          required: ["id", "dependsOn", "requirements", "label", "kind", "why", "contract", "mechanical", "edits"],
          additionalProperties: false,
        },
      },
    },
    required: ["steps"],
    additionalProperties: false,
  },
} as const;

export const RESOLVE_SCHEMA = {
  name: "resolve",
  schema: {
    type: "object",
    properties: {
      resolutions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            obligation: STRING,
            decisions: {
              type: "array",
              items: {
                type: "object",
                properties: { site: INTEGER, change: BOOLEAN, reason: STRING },
                required: ["site", "change", "reason"],
                additionalProperties: false,
              },
            },
            step: {
              type: "object",
              properties: STEP_FIELDS,
              required: ["label", "kind", "why", "contract", "mechanical", "edits"],
              additionalProperties: false,
            },
          },
          required: ["obligation", "decisions", "step"],
          additionalProperties: false,
        },
      },
    },
    required: ["resolutions"],
    additionalProperties: false,
  },
} as const;

interface RawStep {
  id?: string;
  label?: string;
  kind?: string;
  why?: string;
  contract?: string;
  mechanical?: boolean;
  dependsOn?: string[];
  requirements?: number[];
  edits?: RawEdit[];
}

interface RawResolution {
  obligation?: string;
  decisions?: Array<{ site?: number; change?: boolean; reason?: string }>;
  step?: RawStep;
}

const EDIT_RULES = [
  "【編集 edits の書き方】(置き換える前のコードを内容で探して置き換える)",
  "- 既存ファイル: path と、oldCode(置き換える前の連続した行)・newCode(置き換えた後の行)を書く。create は false。",
  "  oldCode は、示したコードの行を、行番号(L数字|)を付けずに一字一句そのまま写す。示されていない行を推測で書かない。",
  "  oldCode はファイルの中で1か所だけに一致するようにする(「}」や「return;」だけでは複数に一致するので、前後の特徴のある行も含める)。",
  "  newCode は oldCode を置き換える変更後のコード全体。oldCode のうち変えない行も一字一句同じに含める。",
  "  startLine には oldCode の最初の行の行番号を書く(同じコードが複数あるときの手がかりにだけ使う)。",
  "- 行を足すだけのときも、足す位置の前後の既存の行を1行以上 oldCode に含め、newCode にもその行を残す(oldCode を空にはできない)。",
  "- 新しいファイル: create を true、startLine を 1、oldCode を空文字にし、newCode にファイル全体を書く。",
  "- 1つの編集で変える行は40行以内。1つのステップの中で同じ行を2つの編集で触らない。",
  "- 出力が長くなりすぎないよう、oldCode は変える行とその前後数行だけにする(関数全体やファイル全体を書き直さない)。",
  "- 構文はステップの編集をすべて入れた後で確かめる。ブロックの開き括弧と閉じ括弧を別の編集に分けてもよいが、どちらも入れ忘れない。",
  "- 示したコードに無い関数・フィールド・ファイルを想像で使わない。新しく作る名前は同じ計画の中で定義し、既存の命名規則に合わせる。",
  "- インデント・引用符・セミコロンなどの書き方は周りのコードに合わせる。",
];

export function planSystemPrompt(level: LearnerLevel = "intermediate"): string {
  return [
    "あなたはコードの理解と変更を支援するアシスタントの「変更計画担当」です。確定した要件と調査済みのコードをもとに、要件を直接満たす「起点の変更」を、利用者が順に理解できるステップに分けて作ります。",
    "変更が波及する場所(呼び出し元・分岐・文字列キーの相手側・データの読み書き・型エラー・テスト・説明文など)は、このあとシステムが依存関係・文字列キー・変更履歴・型検査で機械的に洗い出し、1か所ずつ判断を求めます。",
    "ここでは、要件を満たすために必ず必要な変更だけを書いてください(波及先を推測で先回りして直さない)。",
    "依頼を段階に分けて進めているときは、今回の段階の受け入れ条件を満たす変更だけを書き、後の段階でやることには手を付けない(途中の段階でもビルド・既存の動作が壊れないようにする)。",
    "出力は指定のJSONスキーマに厳密に従ってください。",
    "",
    "【ステップの作り方】",
    `- 1ステップは1つの関心事(例: データの形を変える / 中核の処理を足す / 画面に表示する)。最大${PLAN_LIMITS.initialSteps}ステップ。`,
    "- 依存される側(データ・型 → 中核の処理 → 呼び出し元 → 画面 → テスト)から順に並べる。id は \"a1\" \"a2\" のように付け、先に済んでいる必要があるステップの id を dependsOn に書く。",
    "- label: そのステップのサブゴール名を短く(例:「メッセージの種類を追加する」)。ファイル名・関数名・答えのコードは書かない。",
    "- kind: data(データ・型)/ core(中核の処理)/ caller(呼び出し元)/ ui(画面)/ test(テスト)/ config(設定)/ doc(説明文)",
    "- requirements: そのステップが満たす受け入れ条件の番号(1始まり)。",
    "- why: なぜこの場所を変えるのかを1〜2文(どの受け入れ条件のためか、既存のどの仕組み・手本に合わせるのか)。",
    "- contract: この変更で外から見た約束(関数の引数・戻り値、型のフィールド、メッセージの種類、振る舞い)がどう変わるかを1文。変わらなければ「外から見た約束は変わらない」。",
    "- mechanical: import の追加や決まった形の転記など、考えどころが無い変更なら true。",
    "",
    ...EDIT_RULES,
    "",
    `- ${levelStyle(level)}`,
  ].join("\n");
}

export function resolveSystemPrompt(level: LearnerLevel = "intermediate"): string {
  return [
    "あなたはコードの理解と変更を支援するアシスタントの「影響確認担当」です。計画に入れた変更によって確認が必要になった場所(確認事項)について、",
    "変更が必要かどうかを1か所ずつ判断し、必要なら編集を書きます。出力は指定のJSONスキーマに厳密に従ってください。",
    "",
    "【判断のしかた】",
    "- 確認事項ごとに、見つけ方(パターン)と判断基準、見つかった場所(番号付き)と、その周りの現在のコードを示します。行番号は、計画の変更を重ねた現在のコードのものです。",
    "- decisions には、見つかった場所の番号(site)ごとに、変更が必要か(change)と理由(reason)を書く。",
    "  理由は「この行は〜を〜しているので〜」のように、その行のコードを根拠に1文で。変更不要の理由も具体的に書く。",
    "- 変更が必要な場所があれば、step に1つのステップとしてまとめ、edits に編集を書く。",
    "  不要なら step.edits は空配列にし、label・why・contract は空文字、kind は \"caller\"、mechanical は false にする。",
    "- step.label はサブゴール名(ファイル名・関数名は書かない)。step.why には、なぜこの場所も変える必要があるのか(どの変更に引きずられたか)を、",
    "  step.contract には、この変更で約束がどう変わるかを書く。",
    "- 型エラーは、エラーの原因になった追従漏れを直す。元の変更を取り消したり、型を any にしたりして直さない。",
    "- 要件に関係しない改善・リファクタリングはしない。",
    "",
    ...EDIT_RULES,
    "",
    `- ${levelStyle(level)}`,
  ].join("\n");
}

const PRIORITY: Record<PatternId, number> = {
  "type-error": 0,
  "caller-follow": 1,
  "data-shape": 1,
  "branch-cover": 1,
  "protocol-pair": 2,
  "project-rule": 2,
  "behavior-callers": 3,
  "test-follow": 4,
  "co-change": 5,
};

/** 起点の変更を作らせる回数(初回 + 作り直し2回) */
const PLAN_ATTEMPTS = 3;
/** 作り直しのとき、ファイル全体を見せる行数の上限(これより長ければ失敗した場所の前後だけ) */
const RETRY_FULL_FILE_LINES = 300;

interface PlanFailure {
  reason: string;
  path?: string;
  line?: number;
}

/** 起点の変更を1つも作れなかった(reasons: 各回の失敗の理由) */
export class PlanError extends Error {
  constructor(readonly reasons: string[]) {
    super(
      [
        "要件を満たす変更計画を作れませんでした。",
        ...reasons.slice(-4).map((r) => `- ${r}`),
      ].join("\n"),
    );
    this.name = "PlanError";
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 理由の1行目(作り直し用に添えた今のコードは、画面の警告には出さない) */
function firstLine(reason: string): string {
  return reason.split("\n")[0]!;
}

function coerceKind(kind: unknown): StepKind {
  return STEP_KINDS.includes(kind as StepKind) ? (kind as StepKind) : "core";
}

/** 型エラーの同一性(行番号は変わりうるので含めない) */
function diagnosticKey(d: TypeDiagnostic): string {
  return `${d.path}|${d.code}|${d.message}`;
}

/** after にあって before に無い型エラー(同じエラーが複数あれば、増えた分だけ) */
export function newDiagnostics(before: TypeDiagnostic[], after: TypeDiagnostic[]): TypeDiagnostic[] {
  const counts = new Map<string, number>();
  for (const d of before) {
    counts.set(diagnosticKey(d), (counts.get(diagnosticKey(d)) ?? 0) + 1);
  }
  const out: TypeDiagnostic[] = [];
  for (const d of after) {
    const left = counts.get(diagnosticKey(d)) ?? 0;
    if (left > 0) {
      counts.set(diagnosticKey(d), left - 1);
    } else {
      out.push(d);
    }
  }
  return out;
}

/**
 * 説明できる順にステップを並べる(依存される側が先)。
 * 先に済んでいる必要があるもの(dependsOn・引きずられた元のステップ)を先にし、同時に置けるものは種類の順
 * (データ・型 → 中核 → 呼び出し元 → 画面 → テスト → 設定 → 説明文)、同じなら作った順。
 */
export function orderSteps(steps: PlanStep[]): PlanStep[] {
  const created = new Map(steps.map((s, i) => [s.id, i]));
  const needs = new Map<string, Set<string>>();
  for (const s of steps) {
    const set = new Set<string>();
    for (const d of s.dependsOn) {
      if (created.has(d) && d !== s.id) {
        set.add(d);
      }
    }
    if (s.causedBy?.step && created.has(s.causedBy.step) && s.causedBy.step !== s.id) {
      set.add(s.causedBy.step);
    }
    needs.set(s.id, set);
  }
  const rank = (s: PlanStep): number => STEP_KINDS.indexOf(s.kind) * 1000 + created.get(s.id)!;
  const done = new Set<string>();
  const out: PlanStep[] = [];
  while (out.length < steps.length) {
    const left = steps.filter((s) => !done.has(s.id));
    const ready = left.filter((s) => [...needs.get(s.id)!].every((d) => done.has(d)));
    // 依存が循環していたら(LLM の dependsOn の誤り)、種類の順で1つ取り出して先へ進む
    const pick = (ready.length > 0 ? ready : left).sort((a, b) => rank(a) - rank(b))[0]!;
    done.add(pick.id);
    out.push(pick);
  }
  out.forEach((s, i) => (s.number = i + 1));
  return out;
}

/** 確認事項の場所の同一性(行番号はずれるので、内容で見る) */
function siteKey(subject: string, site: Site): string {
  return `${subject}|${site.path}|${site.text.trim()}`;
}

export class ChangePlanner {
  private readonly vws: VirtualWorkspace;
  private readonly steps: PlanStep[] = [];
  private readonly obligations: Obligation[] = [];
  private readonly warnings: string[] = [];
  private readonly judged = new Set<string>();
  private readonly typeAttempts = new Map<string, number>();
  private readonly coChanged = new Set<string>();
  /** いま判断している確認事項(途中で場所を書き換えない) */
  private resolving = new Set<string>();
  /** 起点の変更を作るときに起きた問題(作れなかったときの説明に使う) */
  private readonly planProblems: string[] = [];
  private typecheck: ChangePlan["typecheck"] = { available: false, remaining: [] };
  /** 前回の型検査より後に作ったステップ(型エラーの原因の推定に使う) */
  private recent: PlanStep[] = [];
  private stepSeq = 0;
  private obligationSeq = 0;
  private criteriaCount = 0;

  constructor(private readonly deps: PlannerDeps) {
    this.vws = new VirtualWorkspace(deps.ws);
  }

  private impactContext(): ImpactContext {
    return { vws: this.vws, lsp: this.deps.lsp, rules: this.deps.rules ?? [], newId: () => `o${++this.obligationSeq}` };
  }

  async plan(inv: Investigation, spec: RequirementSpec, hooks: RunHooks = {}): Promise<ChangePlan> {
    const status = hooks.onStatus ?? (() => undefined);
    this.criteriaCount = spec.criteria.length;

    status("変更計画(起点の変更)を作成中...");
    await this.initialSteps(inv, spec, hooks);
    if (this.steps.length === 0) {
      throw new PlanError([...new Set(this.planProblems)]);
    }
    await this.addCoChanges(hooks);
    await this.typeCheck(hooks);

    for (let round = 1; round <= PLAN_LIMITS.rounds; round++) {
      const open = this.openObligations();
      if (open.length === 0) {
        break;
      }
      if (await this.overLimit()) {
        this.warnings.push(
          `変更の規模が上限(${PLAN_LIMITS.steps}ステップ・${PLAN_LIMITS.changedLines}行)に達したため、残りの確認事項${open.length}件は判断していません。範囲を絞って依頼し直してください。`,
        );
        break;
      }
      const batch = open.slice(0, PLAN_LIMITS.batch);
      status(`変更の影響を確認中(${round}回目: ${batch.length}件 / 残り${open.length}件)...`);
      const changed = await this.resolveRound(batch, spec, round, hooks);
      if (changed) {
        await this.addCoChanges(hooks);
        await this.typeCheck(hooks);
      }
    }
    const left = this.openObligations();
    if (left.length > 0 && !this.warnings.some((w) => w.includes("上限"))) {
      this.warnings.push(`判断しきれなかった確認事項が${left.length}件あります(${left.map((o) => o.subject).slice(0, 3).join("、")})。`);
    }
    return this.finish(spec);
  }

  // ---------- 起点の変更 ----------

  private async initialSteps(inv: Investigation, spec: RequirementSpec, hooks: RunHooks): Promise<void> {
    const { llm, config } = this.deps;
    const messages: ChatMessage[] = [
      { role: "system", content: planSystemPrompt(config.level) },
      { role: "user", content: await this.planUserPrompt(inv, spec) },
    ];
    const rawIds = new Map<string, string>();
    for (let attempt = 0; attempt < PLAN_ATTEMPTS; attempt++) {
      const res = await llm.chat({
        messages,
        jsonSchema: PLAN_SCHEMA,
        signal: hooks.signal,
        purpose: attempt === 0 ? "変更計画の作成" : `変更計画の作り直し(${attempt}回目)`,
      });
      // 出力を読めない・ステップが無い・編集を適用できない、のどれでも理由を添えて作り直させる
      let raws: RawStep[] | undefined;
      try {
        raws = parseJson<{ steps?: RawStep[] }>(res.content).steps ?? [];
      } catch {
        raws = undefined;
      }
      const problems: string[] = [];
      const failures: PlanFailure[] = [];
      if (raws === undefined) {
        problems.push(
          res.finishReason === "length"
            ? "出力が長すぎて途中で切れたため、JSONとして読めませんでした"
            : `出力をJSONとして読めませんでした(${res.content ? `先頭: ${truncate(res.content.trim(), 80)}` : "空の応答"})`,
        );
      } else if (raws.length === 0) {
        problems.push("steps が空でした");
      }
      for (const raw of (raws ?? []).slice(0, PLAN_LIMITS.initialSteps)) {
        if (this.steps.some((s) => s.label === (raw.label ?? "").trim())) {
          continue; // 作り直しで、適用済みのステップがもう一度返ってきた
        }
        const result = await this.applyStep(raw);
        if (result.ok) {
          if (raw.id) {
            rawIds.set(raw.id, result.step.id);
          }
          result.step.dependsOn = raw.dependsOn ?? [];
        } else if (!result.alreadyApplied) {
          failures.push({ reason: `ステップ「${raw.label ?? ""}」: ${result.reason}`, path: result.path, line: result.line });
        }
      }
      this.planProblems.push(...problems, ...failures.map((f) => f.reason));
      const done = this.steps.length > 0 && failures.length === 0;
      if (done || attempt === PLAN_ATTEMPTS - 1) {
        this.warnings.push(...failures.map((f) => `適用できなかった変更: ${firstLine(f.reason)}`));
        break;
      }
      messages.push(
        // 途中で切れた長い出力をそのまま戻すと次も切れやすいので、短くして戻す
        { role: "assistant", content: truncate(res.content ?? "", 6000) },
        { role: "user", content: await this.retryPrompt(failures, problems, inv) },
      );
    }
    // LLM が付けた id を、このシステムの id に読み替える
    for (const step of this.steps) {
      step.dependsOn = step.dependsOn.map((d) => rawIds.get(d) ?? "").filter(Boolean);
    }
  }

  private async planUserPrompt(inv: Investigation, spec: RequirementSpec): Promise<string> {
    const rules = this.deps.rules ?? [];
    const hints = await this.historyHints(inv.evidence.paths());
    return [
      `【ユーザーの要求】\n${spec.query}`,
      spec.stage ? `\n${stageBrief(spec)}` : "",
      spec.answers.length > 0 ? `\n【確認した要件】\n${spec.answers.map((a) => `- ${a.question} → ${a.answer}`).join("\n")}` : "",
      `\n【受け入れ条件${spec.stage ? "(今回の段階)" : ""}】\n${spec.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
      spec.contracts.length > 0
        ? `\n【変わる約束(見込み)】\n${spec.contracts.map((c) => `- ${c.subject}(${c.kind}): ${c.description}`).join("\n")}`
        : "",
      inv.notes ? `\n【調査メモ】\n${inv.notes}` : "",
      hints ? `\n【変更履歴の手がかり(一緒に変更されてきたファイル)】\n${hints}` : "",
      rules.length > 0 ? `\n【このプロジェクトの約束】\n${describeRules(rules)}` : "",
      `\n【参照コード(行番号 L数字| は表示用で、コードの一部ではない)】\n${inv.evidence.render(this.deps.config.evidenceChars)}`,
    ].join("\n");
  }

  /**
   * 作り直しの依頼。失敗の理由に加えて、失敗した編集の対象ファイルの今のコードを(短いファイルは全体を)見せる。
   * 行番号が大きくずれていても、正しい行を写せるようにするため。
   */
  private async retryPrompt(failures: PlanFailure[], problems: string[], inv: Investigation): Promise<string> {
    const budget = this.deps.config.evidenceChars;
    const excerpts: string[] = [];
    let used = 0;
    const missing: string[] = [];
    for (const f of failures) {
      if (!f.path || excerpts.some((e) => e.startsWith(`### ${f.path}\n`)) || missing.includes(f.path)) {
        continue;
      }
      let text: string;
      try {
        text = await this.vws.readText(f.path);
      } catch {
        missing.push(f.path);
        continue;
      }
      const lines = splitLines(text);
      let block: string;
      if (lines.length <= RETRY_FULL_FILE_LINES) {
        block = numberLines(lines, 1);
      } else {
        const center = Math.min(Math.max((f.line ?? 1) - 1, 0), lines.length - 1);
        const from = Math.max(0, center - 60);
        block = numberLines(lines.slice(from, center + 61), from + 1);
      }
      const section = `### ${f.path}\n${block}`;
      if (used + section.length > budget && excerpts.length > 0) {
        break;
      }
      excerpts.push(truncate(section, Math.max(budget - used, 3000)));
      used += section.length;
    }
    const known = inv.evidence.paths();
    return [
      problems.length > 0 || this.steps.length === 0
        ? "変更計画を出し直してください。適用できたステップがあればそれは出し直さず、残りのステップだけを steps に入れて、JSON全体を出し直してください。"
        : "次のステップは適用できませんでした。適用できたステップは出し直さず、失敗したステップの修正版だけを steps に入れて、JSON全体を出し直してください(失敗したステップの編集は1つも入っていません)。",
      ...problems.map((p) => `- ${p}`),
      ...failures.map((f) => `- ${f.reason}`),
      problems.length > 0
        ? "要件を満たす最小限の変更を、少なくとも1ステップ書いてください。出力が長くならないよう、ステップは3つまで、各編集の範囲は変える行とその前後数行だけにしてください。"
        : "",
      "oldCode は、下の今のコードの行を、行番号(L数字|)を付けずに逐語で写してください(先に適用したステップで内容や行番号が変わっている場合があります)。",
      missing.length > 0
        ? `次のファイルはありません: ${missing.join(", ")}。既存のファイルを書き換えるなら参照コードにあるパスを使い、新しく作るなら create を true にしてください。参照コードにあるファイル: ${known.join(", ")}`
        : "",
      excerpts.length > 0 ? `\n【今のコード(行番号 L数字| は表示用で、コードの一部ではない)】\n${excerpts.join("\n\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /**
   * ステップの編集をすべて適用する(1つでも失敗したら、そのステップの編集はどれも入れない)。
   * alreadyApplied: 編集がすべて既に反映済みだった(作り直しで同じ編集がもう一度返ってきたなど。失敗ではない)
   */
  private async applyStep(
    raw: RawStep,
    causedBy?: PlanStep["causedBy"],
  ): Promise<{ ok: true; step: PlanStep } | { ok: false; reason: string; path?: string; line?: number; alreadyApplied?: boolean }> {
    const edits = (raw.edits ?? []).filter((e) => e && typeof e === "object");
    if (edits.length === 0) {
      return { ok: false, reason: "編集がありません" };
    }
    const pre = new Map<string, string | null>();
    for (const edit of edits) {
      const path = toWorkspacePath(edit.path ?? "", this.vws.id);
      if (path && !pre.has(path)) {
        pre.set(path, await this.vws.readText(path).catch(() => null));
      }
    }
    const result = await applyEdits(this.vws, edits, this.deps.syntax);
    if (!result.ok) {
      return result;
    }
    const applied = result.edits;
    const step: PlanStep = {
      id: `s${++this.stepSeq}`,
      number: 0,
      label: (raw.label ?? "").trim() || "変更",
      kind: coerceKind(raw.kind),
      why: (raw.why ?? "").trim(),
      contract: (raw.contract ?? "").trim(),
      mechanical: raw.mechanical === true,
      requirements: (raw.requirements ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= this.criteriaCount),
      dependsOn: [],
      causedBy,
      edits: applied,
      obligations: [],
    };
    this.steps.push(step);
    this.recent.push(step);
    await this.refreshOpen(step, pre, causedBy?.obligation);
    for (const o of await impactOfStep(step, pre, this.impactContext())) {
      this.addObligation(o, step);
    }
    return { ok: true, step };
  }

  /**
   * ステップを適用したあと、判断待ちの確認事項の場所を今の内容に合わせる(except: いま判断中の確認事項)。
   * - 行がずれただけなら行番号を直す
   * - その行が書き換わり、書き換えた後も同じ対象(シンボル・キー)を使っていれば、計画内で対応済みとして判断済みにする
   *   (型エラーの行は、残っていれば次の型検査でもう一度見つかるので、書き換わったら対応済みとする)
   * - 書き換わって対象が見えなくなった行は、今の内容で判断し直してもらう
   */
  private async refreshOpen(step: PlanStep, pre: ReadonlyMap<string, string | null>, except?: string): Promise<void> {
    for (const o of this.obligations) {
      if (o.status !== "open" || o.id === except || this.resolving.has(o.id) || !o.sites.some((s) => typeof pre.get(s.path) === "string")) {
        continue;
      }
      const kept: Site[] = [];
      for (const site of o.sites) {
        const before = pre.get(site.path);
        if (typeof before !== "string" || site.note?.includes("ファイル全体")) {
          kept.push(site);
          continue;
        }
        const now = await this.vws.readText(site.path).catch(() => "");
        const mapper = lineMapper(before, now);
        const moved = mapper.toCurrent(site.line);
        if (moved !== undefined) {
          kept.push({ ...site, line: moved });
          continue;
        }
        // 書き換わった行: 近くの変わっていない行から、今の位置を見積もる
        const nowLines = splitLines(now);
        let at = site.line;
        for (let k = 1; k <= 50; k++) {
          const above = mapper.toCurrent(site.line - k);
          if (above !== undefined) {
            at = above + k;
            break;
          }
        }
        at = Math.min(Math.max(at, 1), Math.max(nowLines.length, 1));
        const text = truncate((nowLines[at - 1] ?? "").trim(), 200);
        const key = /^"(.*)"$/.exec(o.subject)?.[1];
        const stillRefers =
          o.pattern === "type-error" ||
          (key !== undefined ? text.includes(key) : new RegExp(`(?<![\\w$])${escapeRegExp(o.subject)}(?![\\w$])`).test(text));
        if (stillRefers) {
          o.verdicts.push({ ...site, changed: true, auto: true, step: step.id, reason: "計画内の別のステップで、この行は既に書き換えています" });
          this.judged.add(siteKey(o.subject, site));
        } else {
          kept.push({ ...site, line: at, text, note: [site.note, "計画内の別の変更で書き換わった行(今の内容で判断してください)"].filter(Boolean).join(" / ") });
        }
      }
      o.sites = kept;
      if (kept.length === 0) {
        o.status = "done";
      }
    }
  }

  private addObligation(o: Obligation, step?: PlanStep): void {
    o.sites = o.sites.filter((s) => !this.judged.has(siteKey(o.subject, s)));
    if (o.sites.length === 0 && o.verdicts.length === 0) {
      return;
    }
    // まだ判断していない、同じパターン・対象の確認事項があればまとめる
    const same = this.obligations.find((x) => x.status === "open" && x.pattern === o.pattern && x.subject === o.subject);
    if (same && o.sites.length > 0) {
      for (const site of o.sites) {
        if (same.sites.some((x) => x.path === site.path && x.line === site.line)) {
          continue;
        }
        if (same.sites.length >= MAX_SITES) {
          same.more++;
        } else {
          same.sites.push(site);
        }
      }
      same.verdicts.push(...o.verdicts);
      return;
    }
    if (o.sites.length === 0) {
      o.status = "done";
    }
    this.obligations.push(o);
    step?.obligations.push(o.id);
  }

  private openObligations(): Obligation[] {
    return this.obligations
      .filter((o) => o.status === "open")
      .sort((a, b) => PRIORITY[a.pattern] - PRIORITY[b.pattern] || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  }

  private changedLineCount(): Promise<number> {
    return Promise.all(
      this.vws.changedPaths().map(async (p) => {
        const { added, removed } = diffStat((await this.vws.original(p)) ?? "", await this.vws.readText(p));
        return added + removed;
      }),
    ).then((counts) => counts.reduce((a, b) => a + b, 0));
  }

  private async overLimit(): Promise<boolean> {
    return this.steps.length >= PLAN_LIMITS.steps || (await this.changedLineCount()) > PLAN_LIMITS.changedLines;
  }

  // ---------- 確認事項の判断 ----------

  private async resolveRound(batch: Obligation[], spec: RequirementSpec, round: number, hooks: RunHooks): Promise<boolean> {
    const { llm, config } = this.deps;
    const res = await llm.chat({
      messages: [
        { role: "system", content: resolveSystemPrompt(config.level) },
        { role: "user", content: await this.resolvePrompt(batch, spec) },
      ],
      jsonSchema: RESOLVE_SCHEMA,
      signal: hooks.signal,
      purpose: `変更の影響の判断(${round}回目・${batch.length}件)`,
    });
    let resolutions: RawResolution[] = [];
    try {
      resolutions = parseJson<{ resolutions?: RawResolution[] }>(res.content).resolutions ?? [];
    } catch {
      resolutions = [];
    }

    let changed = false;
    // この回で判断する確認事項の場所は、プロンプトで示した番号のまま扱う(途中のステップで書き換えない)
    this.resolving = new Set(batch.map((o) => o.id));
    try {
      for (const o of batch) {
        o.attempts++;
        const r = resolutions.find((x) => x.obligation === o.id);
        if (!r) {
          if (o.attempts >= 2) {
            o.status = "gave-up";
            o.lastError = "判断が返ってきませんでした";
          }
          continue;
        }
        const decisions = new Map<number, { change: boolean; reason: string }>();
        for (const d of r.decisions ?? []) {
          if (Number.isInteger(d?.site) && d.site! >= 1 && d.site! <= o.sites.length) {
            decisions.set(d.site!, { change: d.change === true, reason: (d.reason ?? "").trim() });
          }
        }
        let step: PlanStep | undefined;
        if ((r.step?.edits ?? []).length > 0) {
          const result = await this.applyStep(r.step!, { obligation: o.id, step: o.fromStep, pattern: o.pattern });
          if (!result.ok && result.alreadyApplied) {
            // 必要な変更は、計画内の別のステップで既に入っている
            for (const [i, site] of o.sites.entries()) {
              const d = decisions.get(i + 1);
              o.verdicts.push({ ...site, changed: d?.change === true, auto: true, reason: d?.reason || "計画内の別のステップで既に反映済み" });
              this.judged.add(siteKey(o.subject, site));
            }
            o.status = "done";
            continue;
          }
          if (!result.ok) {
            o.lastError = result.reason;
            if (o.attempts >= 2) {
              o.status = "gave-up";
              this.warnings.push(`「${o.subject}」の確認事項を自動で直せませんでした: ${firstLine(result.reason)}`);
            }
            continue;
          }
          step = result.step;
          changed = true;
        }
        for (const [i, site] of o.sites.entries()) {
          const d = decisions.get(i + 1);
          const wantsChange = d?.change === true;
          o.verdicts.push({
            ...site,
            changed: wantsChange && !!step,
            needsAction: wantsChange && !step,
            reason: d?.reason || (step ? "このステップで合わせて変更" : "判断の理由が返されませんでした"),
            step: wantsChange && step ? step.id : undefined,
          });
          this.judged.add(siteKey(o.subject, site));
        }
        o.status = "done";
        if ([...decisions.values()].some((d) => d.change) && !step) {
          this.warnings.push(`「${o.subject}」: 変更が必要と判断された場所がありますが、編集を作れませんでした。手で確認してください。`);
        }
      }
    } finally {
      this.resolving.clear();
    }
    // 判断が残った確認事項は、この回の変更で行がずれているかもしれないので、内容で探し直す
    for (const o of batch.filter((x) => x.status === "open")) {
      await this.relocate(o);
    }
    return changed;
  }

  /** 場所の行番号を、行の内容で探し直す(見つからなければそのまま) */
  private async relocate(o: Obligation): Promise<void> {
    const next: Site[] = [];
    for (const site of o.sites) {
      const lines = splitLines(await this.vws.readText(site.path).catch(() => ""));
      const want = site.text.trim();
      let best = -1;
      lines.forEach((l, i) => {
        if (want && truncate(l.trim(), 200) === want && (best < 0 || Math.abs(i + 1 - site.line) < Math.abs(best + 1 - site.line))) {
          best = i;
        }
      });
      next.push(best >= 0 ? { ...site, line: best + 1 } : site);
    }
    o.sites = next;
  }

  private async resolvePrompt(batch: Obligation[], spec: RequirementSpec): Promise<string> {
    const budget = this.deps.config.evidenceChars;
    const stepsDone = this.steps.map((s) => `- ${s.id}「${s.label}」: ${s.contract || "(約束の変化なし)"}(${[...new Set(s.edits.map((e) => e.path))].join(", ")})`);
    const shownSteps = new Set<string>();
    const sections: string[] = [];
    for (const o of batch) {
      const info = PATTERNS[o.pattern];
      const from = this.steps.find((s) => s.id === o.fromStep);
      const head = [
        `### 確認事項 ${o.id} — ${o.ruleName ?? info.name}`,
        `判断基準: ${o.criterion || info.criterion}`,
        `探し方: ${o.query}`,
        from ? `きっかけ: ${from.id}「${from.label}」— ${from.contract || "(約束の変化の説明なし)"}` : "",
        o.lastError ? `前回の編集は適用できませんでした: ${o.lastError}` : "",
      ].filter(Boolean);
      if (from && !shownSteps.has(from.id)) {
        shownSteps.add(from.id);
        head.push(`${from.id} の変更内容:\n${from.edits.map((e) => `${e.path}\n${compactDiff(e.before, e.after)}`).join("\n")}`);
      }
      const body: string[] = [];
      o.sites.forEach((site, i) => {
        body.push(
          `[${i + 1}] ${site.path}:${site.line}${site.symbol ? `(${site.symbol} の中)` : ""}${site.note ? ` — ${site.note}` : ""}`,
        );
      });
      if (o.more > 0) {
        body.push(`(ほかに ${o.more} か所。同じ判断になるなら step の編集にまとめてよい)`);
      }
      body.push(await this.excerpts(o.sites));
      sections.push(truncate([...head, "見つかった場所:", ...body].join("\n"), Math.max(2500, Math.floor(budget / batch.length))));
    }
    return [
      `【要件】\n${spec.query}`,
      spec.stage ? `\n${stageBrief(spec)}` : "",
      `\n【受け入れ条件${spec.stage ? "(今回の段階)" : ""}】\n${spec.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
      `\n【計画に入れたステップ】\n${stepsDone.join("\n")}`,
      `\n【確認事項(行番号 L数字| は現在のコード。表示用で、コードの一部ではない)】\n${sections.join("\n\n")}`,
      "\nすべての確認事項について、resolutions に1件ずつ答えてください(obligation には確認事項の id を入れる)。",
    ].join("\n");
  }

  /** 場所の周りの現在のコード(同じファイルの近い場所はまとめる) */
  private async excerpts(sites: Site[], radius = 5): Promise<string> {
    const byPath = new Map<string, Array<[number, number]>>();
    for (const s of sites) {
      const whole = s.note === "ファイル全体を確認" || s.note?.includes("ファイル全体");
      const range: [number, number] = whole ? [1, 40] : [Math.max(1, s.line - radius), s.line + radius];
      const list = byPath.get(s.path) ?? [];
      list.push(range);
      byPath.set(s.path, list);
    }
    const out: string[] = [];
    for (const [path, ranges] of byPath) {
      const lines = splitLines(await this.vws.readText(path).catch(() => ""));
      ranges.sort((a, b) => a[0] - b[0]);
      const merged: Array<[number, number]> = [];
      for (const r of ranges) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1] + 1) {
          last[1] = Math.max(last[1], r[1]);
        } else {
          merged.push([r[0], r[1]]);
        }
      }
      const blocks = merged.map(([a, b]) => numberLines(lines.slice(a - 1, Math.min(b, lines.length)), a));
      out.push(`#### ${path}\n${blocks.join("\n…\n")}`);
    }
    return out.join("\n");
  }

  // ---------- 変更履歴・型検査 ----------

  private commitsCache?: Promise<string[][]>;

  private commits(): Promise<string[][]> {
    this.commitsCache ??= this.deps.history ? this.deps.history.commits().catch(() => []) : Promise.resolve([]);
    return this.commitsCache;
  }

  /** 計画を作る前に LLM へ渡す手がかり: 調査で読んだファイルと一緒に変わってきたファイル */
  private async historyHints(paths: string[]): Promise<string> {
    const commits = await this.commits();
    if (commits.length === 0 || paths.length === 0) {
      return "";
    }
    return coChangeSuggestions(commits, paths.slice(-6), { limit: 5 })
      .map((c) => `- ${c.path}(${c.with} を変えたコミットの${Math.round(c.confidence * 100)}%・${c.support}回で一緒に変更)`)
      .join("\n");
  }

  /** 今回変えたファイルと一緒に変わってきたファイルを、確認事項にする */
  private async addCoChanges(hooks: RunHooks): Promise<void> {
    const commits = await this.commits();
    if (commits.length === 0) {
      return;
    }
    const changed = this.vws.changedPaths();
    for (const c of coChangeSuggestions(commits, changed, { limit: 3 })) {
      if (this.coChanged.has(c.path) || hooks.signal?.aborted) {
        continue;
      }
      this.coChanged.add(c.path);
      let text: string;
      try {
        text = await this.vws.readText(c.path);
      } catch {
        continue; // 今は無いファイル
      }
      const from = [...this.steps].reverse().find((s) => s.edits.some((e) => e.path === c.with));
      const sites = await this.coChangeSites(c.path, text, from);
      this.addObligation(
        {
          id: `o${++this.obligationSeq}`,
          pattern: "co-change",
          fromStep: from?.id,
          subject: c.path,
          query: `変更履歴で、${c.with} を変えたコミットの${Math.round(c.confidence * 100)}%(${c.support}回)で一緒に変更されている`,
          sites,
          more: 0,
          status: "open",
          verdicts: [],
          attempts: 0,
        },
        from,
      );
    }
  }

  /** 一緒に変わってきたファイルの中で、今回の変更に関係しそうな行(なければ先頭) */
  private async coChangeSites(path: string, text: string, from: PlanStep | undefined): Promise<Site[]> {
    const words = new Set<string>();
    for (const e of from?.edits ?? []) {
      const after = splitLines(e.after);
      declarationsOf(after).forEach((d) => words.add(d.name));
      keyLiteralsOf(after).forEach((k) => words.add(k.literal));
    }
    const lines = splitLines(text);
    const sites: Site[] = [];
    for (const word of words) {
      const re = quotedLiteralPattern(word);
      const at = lines.findIndex((l) => l.includes(word) || re.test(l));
      if (at >= 0 && !sites.some((s) => s.line === at + 1)) {
        sites.push(await siteAt(this.vws, path, at + 1));
      }
      if (sites.length >= 3) {
        break;
      }
    }
    return sites.length > 0 ? sites : [await siteAt(this.vws, path, 1, "ファイル全体を確認(一緒に変更されてきた履歴があるため)")];
  }

  private async typeCheck(hooks: RunHooks): Promise<void> {
    const checker = this.deps.typeChecker;
    const recent = this.recent;
    this.recent = [];
    if (!checker) {
      this.typecheck.note = "型検査は行っていません(TypeScript の設定が見つからないか、対応していない言語です)。";
      return;
    }
    const overlay = this.vws.overlay();
    if (overlay.size === 0) {
      return;
    }
    hooks.onStatus?.("型検査で、変更の影響を確認中...");
    let result: { before: TypeDiagnostic[]; after: TypeDiagnostic[] } | undefined;
    try {
      result = await checker.check(overlay, hooks.signal);
    } catch (error) {
      if (hooks.signal?.aborted) {
        throw error;
      }
      result = undefined;
    }
    if (!result) {
      this.typecheck = { available: false, remaining: [], note: "型検査を実行できませんでした(TypeScript の設定を読めない可能性があります)。" };
      return;
    }
    const fresh = newDiagnostics(result.before, result.after);
    this.typecheck = { available: true, remaining: fresh };
    const byPath = new Map<string, TypeDiagnostic[]>();
    for (const d of fresh) {
      const tries = this.typeAttempts.get(diagnosticKey(d)) ?? 0;
      if (tries >= 2) {
        continue; // 2回直させても残ったものは、最後に「残った型エラー」として示す
      }
      this.typeAttempts.set(diagnosticKey(d), tries + 1);
      // 既に判断待ちの確認事項が同じ場所を指していれば、そこにエラーの内容を添える
      const host = this.obligations.find(
        (o) => o.status === "open" && o.sites.some((s) => s.path === d.path && Math.abs(s.line - d.line) <= 1),
      );
      if (host) {
        const site = host.sites.find((s) => s.path === d.path && Math.abs(s.line - d.line) <= 1)!;
        site.note = [site.note, `型エラー: ${d.message}`].filter(Boolean).join(" / ");
        continue;
      }
      byPath.set(d.path, [...(byPath.get(d.path) ?? []), d]);
    }
    for (const [path, diags] of byPath) {
      const sites: Site[] = [];
      for (const d of diags.slice(0, MAX_SITES)) {
        sites.push(await siteAt(this.vws, d.path, d.line, `型エラー(TS${d.code}): ${d.message}`));
      }
      const from = this.attribute(diags[0]!, recent);
      this.addObligation(
        {
          id: `o${++this.obligationSeq}`,
          pattern: "type-error",
          fromStep: from?.id,
          subject: path,
          query: "変更を重ねたコードを型検査し、変更前には無かったエラーを集めた",
          sites,
          more: Math.max(0, diags.length - MAX_SITES),
          status: "open",
          verdicts: [],
          attempts: 0,
        },
        from,
      );
    }
  }

  /** 型エラーの原因と思われるステップ(直前に作ったステップのうち、エラーのファイル・名前に関係するもの) */
  private attribute(d: TypeDiagnostic, recent: PlanStep[]): PlanStep | undefined {
    const candidates = recent.length > 0 ? recent : this.steps;
    const named = candidates.filter((s) =>
      s.edits.some((e) => declarationsOf(splitLines(e.after)).some((decl) => d.message.includes(`'${decl.name}'`))),
    );
    return (
      [...named].reverse()[0] ??
      [...candidates].reverse().find((s) => s.edits.some((e) => e.path === d.path)) ??
      candidates[candidates.length - 1]
    );
  }

  // ---------- 仕上げ ----------

  private async finish(spec: RequirementSpec): Promise<ChangePlan> {
    const files = [];
    for (const path of this.vws.changedPaths()) {
      files.push({ path, original: await this.vws.original(path), final: await this.vws.readText(path) });
    }
    return {
      spec,
      steps: orderSteps(this.steps),
      obligations: this.obligations,
      files,
      typecheck: this.typecheck,
      warnings: this.warnings,
    };
  }
}
