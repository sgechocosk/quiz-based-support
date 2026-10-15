import { checkItemRefs, distractorRules, leakRules, QUIZ_SCHEMA, removeAnswerLeaks, type RunHooks } from "./agent";
import { eliminationHint } from "./choices";
import { declarationsOf } from "./declarations";
import { diffStat } from "./diff";
import { maskAnswers, revealsAnswer } from "./leak";
import type { BlankResult } from "./learnerLog";
import { levelGuide, type LearnerLevel } from "./level";
import { PATTERNS } from "./patterns";
import { STEP_KIND_LABEL, type ChangePlan, type Obligation, type PlanStep, type Site } from "./planTypes";
import type { ChatLlm, ChatMessage, WorkspacePort } from "./ports";
import {
  compactDiff,
  compactItem,
  foldRanges,
  gradeBlanks,
  isolateBlank,
  validateRawItem,
  windowAround,
  type BlankGrade,
  type RawItem,
} from "./quiz";
import { makeRng, numberLines, parseJson, sha1, shuffle, splitLines } from "./text";
import type { McqQuestion, QuizItem } from "./types";

/**
 * 変更計画を、順を追って学べる「手順」にする。
 * 各ステップで、なぜその場所を変えるのか(理由)・何の約束が変わるのか・変更の考えどころ(穴埋め)を示し、
 * 最後に「この変更のあと、確認が必要になる場所はどこか」を予想させる。答え合わせの後に、
 * その場所をどう見つけ(パターン・探し方)、どう判断したか(変更した/不要だった理由)を見せる。
 */

/** 穴埋めにするステップの上限(多すぎると負荷が高い) */
const MAX_QUIZ_STEPS = 6;

const STRING = { type: "string" } as const;
const INTEGER = { type: "integer" } as const;
const ITEM_PROPS = QUIZ_SCHEMA.schema.properties.items.items.properties;

export const STEP_QUIZ_SCHEMA = {
  name: "step_quiz",
  schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            step: STRING,
            edit: INTEGER,
            task: STRING,
            explanation: STRING,
            newNames: ITEM_PROPS.newNames,
            refs: ITEM_PROPS.refs,
            blanks: ITEM_PROPS.blanks,
          },
          required: ["step", "edit", "task", "explanation", "newNames", "refs", "blanks"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
} as const;

export function stepQuizSystemPrompt(level: LearnerLevel = "intermediate"): string {
  return [
    "あなたはコードの理解を支援するアシスタントです。実装の手順(ステップ)ごとに、変更後のコードの「考えどころ」を穴埋めにした問題を作ります。",
    "変更後のコードは確定済みです。書き換えずに、空欄にする場所だけを指定します。空欄は選択式(正解1つ + 誤答3つ)。",
    "出力は指定のJSONスキーマに厳密に従ってください。",
    "",
    "【items】",
    "- 示したステップのうち、考えどころがあるものについて1件ずつ。step にステップの id、edit に編集の番号(0始まり)を入れる。",
    "- task(解答前に表示): このステップで、何を実現するために、どこを、どう変えるか(仕様)を1〜2文。答えのコードは書かない。",
    "- explanation(採点後に表示): この変更の役割と、ほかのファイル・処理との関係を具体的に。",
    "- newNames: このステップで新しく作るメソッド・関数・変数・引数・フィールドなどの名前と役割(解答前に表示)。名前そのものは空欄にしない。",
    "- refs(解答前に表示, 0〜2件): 読むと考えやすくなる既存コードの場所(手本になる似た実装・使う関数の定義など)。",
    "",
    "【空欄 blanks の指定】",
    "- line: 変更後のコード(行番号付きで示す)の中での行番号(1始まり)。",
    "- target: その行に逐語で含まれる、空欄にする部分(1行以内・60文字以内)。行全体ではなく、条件式・呼び出し・引数・代入値など意味のある単位。",
    "- 少なくとも1つは、変更・追加した行(差分の + の行)に置く。「なぜその場所をそう変えるのか」「何に合わせるのか」が問われる箇所を選ぶ。",
    "- 個数と難しさは下の【利用者のレベル】に従う(ただし1ステップあたり最大4個)。",
    "",
    ...distractorRules(),
    "",
    ...leakRules("task・refs・concept・2段階ヒント・clueNote"),
    "",
    levelGuide(level),
  ].join("\n");
}

/** 変更行がいちばん多い編集(穴埋めにする編集の既定) */
export function mainEditIndex(step: PlanStep): number {
  let best = 0;
  let size = -1;
  step.edits.forEach((e, i) => {
    const { added, removed } = diffStat(e.before, e.after);
    if (added + removed > size) {
      size = added + removed;
      best = i;
    }
  });
  return best;
}

export interface LessonStep {
  step: PlanStep;
  /** 穴埋めにした編集の番号 */
  editIndex?: number;
  item?: QuizItem;
  /** 次に確認すべき場所の予想 */
  question?: McqQuestion & { hint: string };
  /** 解答前に見せる文章(答えが出ていたら伏せたもの) */
  display: { label: string; why: string; contract: string };
}

export interface Lesson {
  goal: string;
  overall: string;
  plan: ChangePlan;
  steps: LessonStep[];
}

export interface LessonDeps {
  llm: ChatLlm;
  /** 変更前のワークスペース(参考コードの場所の確認に使う) */
  ws: WorkspacePort;
  level: LearnerLevel;
  evidence: { render(maxChars: number): string; allText(): string; paths(): string[] };
  evidenceChars: number;
}

/** ステップの「なぜ」: 引きずられた元のステップ(または受け入れ条件)+ 理由 */
export function whyText(step: PlanStep, plan: ChangePlan): string {
  const lines: string[] = [];
  if (step.causedBy) {
    const cause = plan.steps.find((s) => s.id === step.causedBy!.step);
    const pattern = PATTERNS[step.causedBy.pattern];
    const obligation = plan.obligations.find((o) => o.id === step.causedBy!.obligation);
    if (cause) {
      lines.push(
        `ステップ${cause.number}「${cause.label}」で${(cause.contract || "変更した").replace(/。$/, "")}ため、` +
          `「${obligation?.ruleName ?? pattern.name}」の確認でこの場所が見つかりました。`,
      );
    } else {
      lines.push(`「${obligation?.ruleName ?? pattern.name}」の確認でこの場所が見つかりました。`);
    }
  } else if (step.requirements.length > 0) {
    lines.push(
      `受け入れ条件 ${step.requirements.map((n) => `${n}「${plan.spec.criteria[n - 1] ?? ""}」`).join("・")} を満たすため。`,
    );
  }
  if (step.why) {
    lines.push(step.why);
  }
  return lines.join("\n");
}

export function lessonGoal(plan: ChangePlan): string {
  const what = plan.spec.understanding || plan.spec.query;
  const stage = plan.spec.stage;
  const head = stage ? `依頼全体を${stage.total}段階に分けたうちの${stage.index + 1}段階目「${stage.label}」です。` : "";
  return `${head}「${what}」を${plan.steps.length}ステップで実装します。各ステップで「なぜその場所を変えるのか」と「変えたら次にどこを確認するのか」を考えます。`;
}

export function overallText(plan: ChangePlan): string {
  const lines: string[] = [];
  if (plan.spec.understanding) {
    lines.push(`要件: ${plan.spec.understanding}`);
  }
  lines.push("手順:");
  for (const s of plan.steps) {
    const files = [...new Set(s.edits.map((e) => e.path))].join(", ");
    const cause = s.causedBy ? plan.steps.find((x) => x.id === s.causedBy!.step) : undefined;
    const origin = s.causedBy
      ? `${cause ? `ステップ${cause.number}の変更に合わせる` : "影響の確認で見つかった"}(${PATTERNS[s.causedBy.pattern].name})`
      : "要件を満たす起点の変更";
    lines.push(`${s.number}. ${s.label} — ${files}(${origin})`);
  }
  const judged = plan.obligations.flatMap((o) => o.verdicts.filter((v) => !v.auto));
  if (plan.obligations.length > 0) {
    lines.push(
      `影響の確認: ${plan.obligations.length}件の確認事項で${judged.length}か所を確認し、` +
        `${judged.filter((v) => v.changed).length}か所を変更、${judged.filter((v) => !v.changed && !v.needsAction).length}か所は変更不要と判断しました。`,
    );
  }
  return lines.join("\n");
}

/** 場所の表示名(関数の中なら関数名まで) */
export function placeLabel(site: Pick<Site, "path" | "symbol">): string {
  return site.symbol ? `${site.path} の ${site.symbol}` : site.path;
}

/**
 * 予想問題の誤答に使う場所の候補: 計画・調査で出てきたファイルの関数・メソッド(と、関数の無いファイル)。
 * 利用者が今のコードベースで探せる場所にするため、変更前の内容から作る(これから作る関数は含めない)。
 */
async function placePool(plan: ChangePlan, deps: LessonDeps): Promise<string[]> {
  const paths = new Set<string>([
    ...plan.files.map((f) => f.path),
    ...deps.evidence.paths(),
    ...plan.obligations.flatMap((o) => [...o.sites, ...o.verdicts].map((s) => s.path)),
  ]);
  const out: string[] = [];
  for (const path of paths) {
    const planned = plan.files.find((f) => f.path === path);
    const text = planned ? (planned.original ?? undefined) : await deps.ws.readText(path).catch(() => undefined);
    if (text === undefined) {
      continue;
    }
    const names = declarationsOf(splitLines(text))
      .filter((d) => d.kind === "function" || d.kind === "method")
      .map((d) => d.name)
      .filter((n) => n !== "constructor");
    if (names.length === 0) {
      out.push(path);
    }
    for (const name of new Set(names)) {
      out.push(`${path} の ${name}`);
    }
  }
  return out;
}

/** 「この変更のあと、確認が必要になる場所はどこか」の予想問題 */
export function nextCheckQuestion(
  step: PlanStep,
  plan: ChangePlan,
  pool: string[],
  rng: () => number,
): (McqQuestion & { hint: string }) | undefined {
  const obligations = plan.obligations.filter((o) => step.obligations.includes(o.id) && o.pattern !== "co-change");
  const places = new Map<string, boolean>();
  const every = new Set<string>();
  for (const o of obligations) {
    for (const v of o.verdicts) {
      every.add(placeLabel(v));
      if (!v.auto) {
        places.set(placeLabel(v), (places.get(placeLabel(v)) ?? false) || v.changed);
      }
    }
    for (const s of o.sites) {
      every.add(placeLabel(s));
      if (o.status !== "done" && !places.has(placeLabel(s))) {
        places.set(placeLabel(s), false);
      }
    }
  }
  if (places.size === 0) {
    return undefined;
  }
  // 自分が変えた場所そのものは選択肢にしない(「確認が必要な場所」ではないため)
  const own = new Set<string>();
  for (const e of step.edits) {
    own.add(e.path);
    for (const d of declarationsOf(splitLines(e.after))) {
      own.add(`${e.path} の ${d.name}`);
    }
  }
  const correct = [...places]
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([label]) => label)
    .filter((label) => !own.has(label))
    .slice(0, 2);
  if (correct.length === 0) {
    return undefined;
  }
  const distractors = shuffle(
    [...new Set(pool)].filter((l) => !every.has(l) && !own.has(l) && !correct.includes(l)),
    rng,
  ).slice(0, 4 - correct.length);
  if (distractors.length < 2) {
    return undefined;
  }
  const options = shuffle([...correct, ...distractors], rng);
  const patterns = [...new Set(obligations.map((o) => o.ruleName ?? PATTERNS[o.pattern].name))];
  return {
    id: `next:${step.id}`,
    prompt:
      correct.length > 1
        ? `この変更のあと、確認が必要になる場所をすべて選んでください(該当は${correct.length}か所)。`
        : "この変更のあと、確認が必要になる場所はどこですか?",
    options,
    correct: correct.map((c) => options.indexOf(c)).sort((a, b) => a - b),
    explanation: "",
    concept: patterns[0] ?? "影響範囲の確認",
    hint: [
      ...new Set(obligations.map((o) => `${o.ruleName ?? PATTERNS[o.pattern].name}: ${o.ruleName ? o.query : PATTERNS[o.pattern].howToFind}`)),
    ].join("\n"),
  };
}

function stepQuizUserPrompt(plan: ChangePlan, targets: PlanStep[], deps: LessonDeps): string {
  const sections = targets.map((s) => {
    const edits = s.edits.map((e, i) => {
      const before = e.created
        ? "(新しいファイル)"
        : numberLines(splitLines(e.before), e.startLine);
      return [
        `編集 ${i}: ${e.path}(${e.created ? "新規作成" : `${e.startLine}〜${e.endLine}行目を置き換え`})`,
        `変更前:\n${before}`,
        `変更後(blanks の line はこの番号):\n${numberLines(splitLines(e.after), 1)}`,
        `差分:\n${compactDiff(e.before, e.after)}`,
      ].join("\n");
    });
    return [
      `### ${s.id} ステップ${s.number}「${s.label}」(${STEP_KIND_LABEL[s.kind]})`,
      `なぜ: ${whyText(s, plan).replace(/\n/g, " ")}`,
      `約束の変化: ${s.contract || "(なし)"}`,
      ...edits,
    ].join("\n");
  });
  return [
    `【要件】\n${plan.spec.query}`,
    `\n【受け入れ条件】\n${plan.spec.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
    `\n【ステップ(穴埋めにするもの)】\n${sections.join("\n\n")}`,
    `\n【参照コード(変更前。行番号 L数字| は表示用で、コードの一部ではない)】\n${deps.evidence.render(Math.floor(deps.evidenceChars / 2))}`,
  ].join("\n");
}

interface RawStepItem extends Pick<RawItem, "task" | "explanation" | "newNames" | "refs" | "blanks"> {
  step?: string;
  edit?: number;
}

/** 変更計画から手順(ステップごとの穴埋め・予想問題)を作る */
export async function buildLesson(plan: ChangePlan, deps: LessonDeps, hooks: RunHooks = {}): Promise<Lesson> {
  const targets = plan.steps.filter((s) => !s.mechanical && s.edits.length > 0).slice(0, MAX_QUIZ_STEPS);
  const items = new Map<string, { item: QuizItem; editIndex: number }>();
  const knownText = [deps.evidence.allText(), ...plan.files.map((f) => f.final)].join("\n");

  if (targets.length > 0) {
    hooks.onStatus?.("ステップごとの考えどころを整理中...");
    const messages: ChatMessage[] = [
      { role: "system", content: stepQuizSystemPrompt(deps.level) },
      { role: "user", content: stepQuizUserPrompt(plan, targets, deps) },
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await deps.llm.chat({
        messages,
        jsonSchema: STEP_QUIZ_SCHEMA,
        signal: hooks.signal,
        purpose: attempt === 0 ? "手順ごとの問題の作成" : "手順ごとの問題の作り直し",
      });
      let raws: RawStepItem[] = [];
      try {
        raws = parseJson<{ items?: RawStepItem[] }>(res.content).items ?? [];
      } catch {
        raws = [];
      }
      const reasons: string[] = [];
      for (const raw of raws) {
        const step = targets.find((s) => s.id === raw.step);
        if (!step || items.has(step.id)) {
          continue;
        }
        const editIndex =
          Number.isInteger(raw.edit) && raw.edit! >= 0 && raw.edit! < step.edits.length ? raw.edit! : mainEditIndex(step);
        const edit = step.edits[editIndex]!;
        const beforeLines = splitLines(edit.before);
        const rawItem: RawItem = {
          kind: "change",
          path: edit.path,
          startLine: edit.startLine,
          endLine: edit.created ? 1 : edit.endLine,
          firstLine: edit.created ? "" : (beforeLines[0] ?? ""),
          lastLine: edit.created ? "" : (beforeLines[beforeLines.length - 1] ?? ""),
          task: raw.task ?? "",
          newCode: edit.after,
          blanks: Array.isArray(raw.blanks) ? raw.blanks : [],
          refs: Array.isArray(raw.refs) ? raw.refs : [],
          newNames: Array.isArray(raw.newNames) ? raw.newNames : [],
          explanation: raw.explanation ?? "",
        };
        const verdict = validateRawItem(rawItem, edit.fileBefore, { knownText, allowLong: true });
        if (!verdict.ok) {
          reasons.push(`${step.id}: ${verdict.reason}`);
          continue;
        }
        await checkItemRefs((p) => deps.ws.readText(p), verdict.item, edit.fileBefore);
        items.set(step.id, { item: compactItem(verdict.item), editIndex });
      }
      const missing = targets.filter((s) => !items.has(s.id));
      if (missing.length === 0 || attempt === 1 || reasons.length === 0) {
        break;
      }
      messages.push(
        { role: "assistant", content: res.content ?? "" },
        {
          role: "user",
          content: [
            "次のステップの問題が検証で不合格でした。不合格のステップだけを items に入れて、JSON全体を出し直してください。",
            ...reasons.map((r) => `- ${r}`),
            "空欄の target は、その行に実際に書かれている文字列をそのまま写してください。",
          ].join("\n"),
        },
      );
    }
  }

  // 目標の文章も解答前に見えるので、答え漏れを直した結果(書き直し・伏せ字)を使う
  const visible = { goal: lessonGoal(plan), items: [...items.values()].map((v) => v.item) };
  if (visible.items.length > 0) {
    hooks.onStatus?.("手がかりの文章を点検中...");
    await removeAnswerLeaks(deps.llm, deps.level, visible, hooks);
  }
  const { goal } = visible;

  const pool = await placePool(plan, deps);
  const rng = makeRng(parseInt(sha1(plan.spec.query + plan.steps.map((s) => s.id).join()).slice(0, 8), 16));
  const steps: LessonStep[] = plan.steps.map((step) => {
    const entry = items.get(step.id);
    const display = { label: step.label, why: whyText(step, plan), contract: step.contract };
    if (entry) {
      // 計画で決まった文章(見出し・理由・約束の変化)に、このステップの答えが出ていれば解答前は伏せる
      const answers = entry.item.blanks.map((b) => b.answer);
      const shown = new Set((entry.item.newNames ?? []).map((n) => n.name));
      for (const field of ["label", "why", "contract"] as const) {
        const hit = answers.filter((a) => revealsAnswer(display[field], a, shown));
        if (hit.length > 0) {
          display[field] = maskAnswers(display[field], hit);
        }
      }
    }
    return { step, item: entry?.item, editIndex: entry?.editIndex, question: nextCheckQuestion(step, plan, pool, rng), display };
  });
  return { goal, overall: overallText(plan), plan, steps };
}

// ---------- 画面に渡す形 ----------

/** 穴埋め問題(正解・解説を含まない形) */
export function itemPayload(item: QuizItem, index: number): Record<string, unknown> {
  return {
    index,
    kind: item.kind,
    path: item.path,
    startLine: item.startLine,
    endLine: item.endLine,
    code: item.quizCode,
    // 空欄・変更行から離れた行は折りたたんで表示する(クリックで展開)
    folds: foldRanges(item),
    task: item.task ?? "",
    refs: item.refs ?? [],
    newNames: item.newNames ?? [],
    // 選択肢は表示順のコードだけを渡す(どれが正解か・解説は採点まで渡さない)
    blanks: item.blanks.map((b) => ({
      concept: b.concept,
      hints: b.hints,
      clue: b.clue,
      options: (b.choices ?? []).map((c) => c.code),
      eliminate: eliminationHint(b.choices ?? [], b.answer),
    })),
  };
}

/** 場所(リンク用に、その行の内容も渡す。行番号は計画の途中の位置なので、開くときに内容で探し直す) */
function placeView(site: Site): Record<string, unknown> {
  return { path: site.path, line: site.line, text: site.text, symbol: site.symbol, label: placeLabel(site), note: site.note };
}

/** 解答前に見せるステップ */
export function stepPayload(lesson: Lesson, index: number): Record<string, unknown> {
  const ls = lesson.steps[index]!;
  const s = ls.step;
  const answers = ls.item?.blanks.map((b) => b.answer) ?? [];
  const hides = (text: string): boolean => answers.some((a) => revealsAnswer(text, a));
  // 穴埋めにしなかった編集は差分のまま見せる(穴埋めの答えが見えてしまうものは答え合わせの後に回す)
  const diffs = s.edits
    .filter((_, i) => !ls.item || i !== ls.editIndex)
    .filter((e) => !hides(e.after))
    .map((e) => ({ path: e.path, created: e.created, diff: compactDiff(e.before, e.after) }));
  return {
    index,
    number: s.number,
    total: lesson.steps.length,
    label: ls.display.label,
    kind: STEP_KIND_LABEL[s.kind],
    mechanical: s.mechanical,
    why: ls.display.why,
    contract: ls.display.contract,
    files: s.edits.map((e) => ({
      path: e.path,
      created: e.created,
      line: e.startLine,
      text: e.created ? "" : (splitLines(e.before)[0] ?? "").trim(),
    })),
    item: ls.item ? itemPayload(ls.item, 0) : undefined,
    diffs,
    question: ls.question
      ? { prompt: ls.question.prompt, options: ls.question.options, multi: ls.question.correct.length > 1, hint: ls.question.hint }
      : undefined,
  };
}

function checkView(o: Obligation, lesson: Lesson): Record<string, unknown> {
  const info = PATTERNS[o.pattern];
  const numberOf = (id?: string): number | undefined => lesson.plan.steps.find((s) => s.id === id)?.number;
  return {
    pattern: o.ruleName ?? info.name,
    trigger: info.trigger,
    query: o.query,
    criterion: o.criterion || info.criterion,
    status: o.status,
    results: o.verdicts.map((v) => ({
      ...placeView(v),
      changed: v.changed,
      auto: v.auto === true,
      needsAction: v.needsAction === true,
      reason: v.reason,
      step: numberOf(v.step),
    })),
    pending: o.status === "done" ? [] : o.sites.map(placeView),
    more: o.more,
    error: o.lastError,
  };
}

/** 答え合わせの後に見せる: 理由の全文・差分・確認事項(探し方と判断) */
export function revealPayload(lesson: Lesson, index: number): Record<string, unknown> {
  const ls = lesson.steps[index]!;
  const s = ls.step;
  return {
    label: s.label,
    why: whyText(s, lesson.plan),
    contract: s.contract,
    explanation: ls.item?.explanation ?? "",
    diffs: s.edits.map((e) => ({ path: e.path, created: e.created, diff: compactDiff(e.before, e.after) })),
    checks: lesson.plan.obligations.filter((o) => s.obligations.includes(o.id)).map((o) => checkView(o, lesson)),
  };
}

/** 最後のまとめ(反映前の確認材料) */
export function finalPayload(lesson: Lesson): Record<string, unknown> {
  const { plan } = lesson;
  const unresolved = [
    ...plan.obligations
      .filter((o) => o.status !== "done")
      .map((o) => `${o.ruleName ?? PATTERNS[o.pattern].name}: ${o.subject}${o.lastError ? `(${o.lastError})` : ""}`),
    ...plan.obligations.flatMap((o) =>
      o.verdicts.filter((v) => v.needsAction).map((v) => `${v.path}:${v.line} ${v.reason}(自動で直せなかったため、手で確認してください)`),
    ),
  ];
  return {
    overall: lesson.overall,
    files: plan.files.map((f) => ({ path: f.path, created: f.original === null, ...diffStat(f.original ?? "", f.final) })),
    typecheck: {
      available: plan.typecheck.available,
      note: plan.typecheck.note,
      remaining: plan.typecheck.remaining.slice(0, 10).map((d) => `${d.path}:${d.line} ${d.message}`),
    },
    unresolved,
    warnings: plan.warnings,
  };
}

// ---------- 採点 ----------

export interface GradedBlank extends BlankGrade {
  why?: string;
  chosen: number;
  correctIndex: number;
  notes: string[];
}

/** 穴埋めの採点(選んだ選択肢の番号。未選択は -1)と、判断の記録に残す内容 */
export function gradeItem(
  item: QuizItem,
  chosen: number[],
  hintsUsed: number[] = [],
): { grades: GradedBlank[]; records: BlankResult[] } {
  const picks = item.blanks.map((_, k) => chosen[k] ?? -1);
  const answers = item.blanks.map((b, k) => b.choices?.[picks[k]!]?.code ?? "");
  const grades = gradeBlanks(item, answers);
  const answerList = item.blanks.map((b) => b.answer);
  return {
    grades: grades.map((g, k) => {
      const b = item.blanks[k]!;
      return {
        ...g,
        note: picks[k]! < 0 ? "未選択" : g.note,
        why: b.why,
        chosen: picks[k]!,
        correctIndex: (b.choices ?? []).findIndex((c) => c.code === b.answer),
        notes: (b.choices ?? []).map((c) => c.note),
      };
    }),
    records: item.blanks.map((b, k) => ({
      path: item.path,
      startLine: item.startLine,
      endLine: item.endLine,
      concept: b.concept,
      snippet: windowAround(isolateBlank(item.quizCode, answerList, k)),
      answer: b.answer,
      hints: b.hints,
      why: b.why,
      choices: b.choices,
      correct: grades[k]?.correct ?? false,
      hintsUsed: hintsUsed[k] ?? 0,
    })),
  };
}

/** 選択式(複数選択あり)の採点 */
export function gradeQuestion(question: McqQuestion, chosen: number[]): { correct: boolean; correctIndexes: number[]; chosen: number[] } {
  const picked = [...new Set(chosen)].filter((i) => Number.isInteger(i) && i >= 0 && i < question.options.length).sort((a, b) => a - b);
  const ok = picked.length === question.correct.length && picked.every((c, k) => c === question.correct[k]);
  return { correct: ok, correctIndexes: question.correct, chosen: picked };
}
