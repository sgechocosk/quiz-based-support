import type { RunHooks } from "./agent";
import { changedCurrentLines } from "./diff";
import { levelStyle, type LearnerLevel } from "./level";
import type { PlannedFile, RequirementSpec, StageContext, StagePlan } from "./planTypes";
import type { ChatLlm } from "./ports";
import { parseJson } from "./text";

/**
 * 大きな依頼を段階に分けて、依頼全体が完成するまで1段階ずつ進める。
 * 段階ごとに「今のコードで調べ直す → 変更計画 → ステップごとにたどる → 反映」を回し、
 * 次の段階へ進む前に、依頼全体の受け入れ条件と済んだ段階を見比べて残りの段階を見直す(足りなければ足す)。
 */

/** 1つの依頼で進める段階の上限(見直しで段階が増え続けないように) */
export const MAX_STAGES = 8;
/** 1回の見積もり・見直しで示す段階の上限 */
const MAX_PLANNED_STAGES = 6;

const STRING = { type: "string" } as const;

/** 段階の JSON スキーマ(要件の整理・確定・見直しで共通) */
export const STAGES_PROPERTY = {
  type: "array",
  items: {
    type: "object",
    properties: { label: STRING, goal: STRING, acceptanceCriteria: { type: "array", items: STRING } },
    required: ["label", "goal", "acceptanceCriteria"],
    additionalProperties: false,
  },
} as const;

export interface RawStage {
  label?: string;
  goal?: string;
  acceptanceCriteria?: string[];
}

/** LLM の出力から段階を取り出す(名前の無いものは捨てる) */
export function parseStages(raw: RawStage[] | undefined, limit = MAX_PLANNED_STAGES): StagePlan[] {
  const out: StagePlan[] = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    const label = typeof s?.label === "string" ? s.label.trim() : "";
    if (!label || out.length >= limit) {
      continue;
    }
    const goal = typeof s.goal === "string" ? s.goal.trim() : "";
    const criteria = (Array.isArray(s.acceptanceCriteria) ? s.acceptanceCriteria : [])
      .map((c) => (typeof c === "string" ? c.trim() : ""))
      .filter(Boolean)
      .slice(0, 5);
    out.push({ label, goal, criteria });
  }
  return out;
}

/** 段階の決め方(要件の整理・確定のプロンプトで共通) */
export function stageRules(maxPlaces: number, maxLines: number): string[] {
  return [
    `- stages: 依頼全体を完成させるまでの段階(2〜${MAX_PLANNED_STAGES}個)。1回で扱える規模(${maxPlaces}か所・約${maxLines}行)に収まる依頼なら空配列。`,
    "  段階は1つずつ順に実装し、最後の段階まで進めて依頼全体を完成させる(途中の段階で終わらせない)。",
    `  各段階は、それだけで動作が完結し(途中の段階でもビルド・既存の動作が壊れない)、${maxPlaces}か所・約${maxLines}行以内に収める。依存される側(データ・型・中核の処理)から順に並べる。`,
    "  label は段階の名前を短く、goal はその段階を終えると何ができるようになるかを1文で、acceptanceCriteria はその段階の受け入れ条件を1〜3件。",
  ];
}

/** 済んだ段階の記録 */
export interface StageResult {
  label: string;
  goal: string;
  /** applied: 計画した変更を反映した / unapplied: 反映せずに進んだ(自分で書いた等) / skipped: 計画できずに飛ばした */
  status: "applied" | "unapplied" | "skipped";
  /** 何をどう変えたか(手順の要約) */
  summary: string;
  /** 変えたファイル */
  files: string[];
  /** 変えた行(変更後の行番号)。次の段階で、今の内容を調べ直す手がかりにする */
  focus: Array<{ path: string; lines: number[] }>;
}

const STATUS_LABEL: Record<StageResult["status"], string> = {
  applied: "反映済み",
  unapplied: "計画した変更は反映せずに進めた(利用者が自分で書いた可能性がある)",
  skipped: "計画できずに飛ばした",
};

export function statusLabel(status: StageResult["status"]): string {
  return STATUS_LABEL[status];
}

/** 計画したファイルのうち、変えた行(変更後の行番号) */
export function changedFocus(files: PlannedFile[]): Array<{ path: string; lines: number[] }> {
  return files.map((f) => ({ path: f.path, lines: [...changedCurrentLines(f.original ?? "", f.final)] }));
}

/** index 番目の段階を実装するときの要件(依頼全体の要件に、今回の段階の位置づけを添える) */
export function stageSpec(overall: RequirementSpec, stages: StagePlan[], index: number, done: StageResult[]): RequirementSpec {
  const stage = stages[index]!;
  const context: StageContext = {
    index,
    total: stages.length,
    label: stage.label,
    overall: overall.understanding || overall.query,
    overallCriteria: overall.criteria,
    done: done.map((d) => `${d.label}(${STATUS_LABEL[d.status]})`),
    later: stages.slice(index + 1).map((s) => (s.goal ? `${s.label}: ${s.goal}` : s.label)),
  };
  return {
    query: overall.query,
    understanding: stage.goal || stage.label,
    criteria: stage.criteria.length > 0 ? stage.criteria : [stage.goal || stage.label],
    contracts: [],
    answers: overall.answers,
    stage: context,
  };
}

/** 計画・調査のプロンプトに入れる、今回の段階の位置づけ(段階に分けていなければ空文字) */
export function stageBrief(spec: Pick<RequirementSpec, "stage">): string {
  const s = spec.stage;
  if (!s) {
    return "";
  }
  return [
    `【段階】依頼全体を${s.total}段階に分けて1段階ずつ完成させている。今回は${s.index + 1}段階目「${s.label}」だけを実装する。`,
    `依頼全体: ${s.overall}`,
    s.done.length > 0 ? `済んだ段階(変更はファイルに入っている): ${s.done.join(" / ")}` : "",
    s.later.length > 0 ? `後の段階でやること(今回は手を付けない。確認事項がこれに当たるなら「後の段階で対応」として変更不要にする):\n${s.later.map((l) => `- ${l}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------- 進み具合の見直し ----------

export const PROGRESS_SCHEMA = {
  name: "progress",
  schema: {
    type: "object",
    properties: { complete: { type: "boolean" }, reason: STRING, remaining: STAGES_PROPERTY },
    required: ["complete", "reason", "remaining"],
    additionalProperties: false,
  },
} as const;

export interface ProgressReview {
  /** 依頼全体が完成した */
  complete: boolean;
  reason: string;
  /** 残りの段階(見直し後) */
  remaining: StagePlan[];
}

export function progressSystemPrompt(level: LearnerLevel, maxPlaces: number, maxLines: number): string {
  return [
    "あなたはコードの変更を支援するアシスタントの「進み具合の確認担当」です。大きな依頼を段階に分けて、1段階ずつ実装しています。",
    "依頼全体が完成するまで進めるために、依頼全体の受け入れ条件と済んだ段階を見比べて、残りの段階を見直します。出力は指定のJSONスキーマに厳密に従ってください。",
    "",
    "- complete: 依頼全体の受け入れ条件が、済んだ段階ですべて満たされたなら true(remaining は空配列)。1つでも残っていれば false。",
    "- remaining: まだ満たされていない受け入れ条件を満たすための段階を、依存される側から順に書く。",
    "  予定していた残りの段階を基本にし、済んだ段階で先に対応したものは除き、足りないものは足す。",
    "  「計画できずに飛ばした」段階があれば、その内容も、より小さく分けるなどして残りに含める。",
    "  「反映せずに進めた」段階は、利用者が自分で書いた可能性があるので、変更の要約から判断し、不確かなら残りに確認の段階を入れてよい。",
    `  各段階は、それだけで動作が完結し、${maxPlaces}か所・約${maxLines}行以内。最大${MAX_PLANNED_STAGES}個。`,
    "- reason: 完成したと判断した理由、または残りがある理由を1文で。",
    `- ${levelStyle(level)}`,
  ].join("\n");
}

export function progressUserPrompt(overall: RequirementSpec, done: StageResult[], remaining: StagePlan[]): string {
  return [
    `【依頼】\n${overall.query}`,
    overall.understanding ? `\n【依頼全体の理解】\n${overall.understanding}` : "",
    overall.answers.length > 0 ? `\n【確認した要件】\n${overall.answers.map((a) => `- ${a.question} → ${a.answer}`).join("\n")}` : "",
    `\n【依頼全体の受け入れ条件】\n${overall.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
    `\n【済んだ段階】\n${done
      .map((d, i) =>
        [
          `### ${i + 1}. ${d.label}(${STATUS_LABEL[d.status]})`,
          d.goal ? `ねらい: ${d.goal}` : "",
          d.files.length > 0 ? `変えたファイル: ${d.files.join(", ")}` : "",
          d.summary,
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n\n")}`,
    `\n【予定していた残りの段階】\n${remaining.length > 0 ? remaining.map((s, i) => `${i + 1}. ${s.label}: ${s.goal}`).join("\n") : "(なし)"}`,
  ].join("\n");
}

/**
 * 済んだ段階と依頼全体の受け入れ条件を見比べて、残りの段階を見直す。
 * 判定に失敗したときは、予定していた残りの段階のまま進める(中止されたときだけ例外)。
 */
export async function reviewProgress(
  llm: ChatLlm,
  options: { level: LearnerLevel; maxPlaces: number; maxLines: number },
  overall: RequirementSpec,
  done: StageResult[],
  remaining: StagePlan[],
  hooks: RunHooks = {},
): Promise<ProgressReview> {
  hooks.onStatus?.("済んだ段階と依頼全体の受け入れ条件を見比べて、残りを見直しています...");
  try {
    const res = await llm.chat({
      messages: [
        { role: "system", content: progressSystemPrompt(options.level, options.maxPlaces, options.maxLines) },
        { role: "user", content: progressUserPrompt(overall, done, remaining) },
      ],
      jsonSchema: PROGRESS_SCHEMA,
      signal: hooks.signal,
      purpose: "進み具合の見直し",
    });
    const raw = parseJson<{ complete?: boolean; reason?: string; remaining?: RawStage[] }>(res.content);
    const next = raw.complete === true ? [] : parseStages(raw.remaining);
    return { complete: next.length === 0, reason: (raw.reason ?? "").trim(), remaining: next };
  } catch (error) {
    if (hooks.signal?.aborted) {
      throw error;
    }
    return { complete: remaining.length === 0, reason: "", remaining };
  }
}
