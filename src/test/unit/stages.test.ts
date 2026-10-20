import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { QuizAgent, type Investigation } from "../../core/agent";
import { lessonGoal } from "../../core/lesson";
import { ChangePlanner } from "../../core/planner";
import type { RequirementSpec, StagePlan } from "../../core/planTypes";
import type { ChatLlm, ChatRequest } from "../../core/ports";
import { applyReview, changedFocus, reviewProgress, stageBrief, stageSpec, type StageResult } from "../../core/stages";
import { EvidenceStore } from "../../core/tools";
import { makeTempDir, NodeWorkspace, writeFiles } from "./helpers/nodeWorkspace";

const STAGES: StagePlan[] = [
  { label: "データ", goal: "設定を保存できる", criteria: ["設定が保存される"] },
  { label: "処理", goal: "保存した設定で判定する", criteria: ["設定した最低文字数で判定する"] },
  { label: "画面", goal: "画面から設定できる", criteria: [] },
];

const OVERALL: RequirementSpec = {
  query: "パスワードの最低文字数を設定で変えられるようにしたい",
  understanding: "最低文字数を設定から変えられるようにする",
  criteria: ["設定した最低文字数でログインを判定する", "画面から最低文字数を変えられる"],
  contracts: [],
  answers: [{ question: "保存先は?", answer: "設定ファイル" }],
  stages: STAGES,
};

const result = (label: string, status: StageResult["status"]): StageResult => ({
  label,
  goal: `${label}のねらい`,
  status,
  summary: `${label}の手順の要約`,
  files: status === "skipped" ? [] : ["src/auth.ts"],
  focus: [],
});

/** 決まった応答を返し、受け取ったリクエストを記録する偽の LLM */
function fakeLlm(respond: (req: ChatRequest) => string | Error): ChatLlm & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat: async (req) => {
      requests.push(req);
      const out = respond(req);
      if (out instanceof Error) {
        throw out;
      }
      return { content: out, toolCalls: [] };
    },
  };
}

test("段階: 今回の段階の要件は、その段階の受け入れ条件に依頼全体の位置づけ(済んだ段階・後の段階)を添える", () => {
  const spec = stageSpec(OVERALL, STAGES, 1, [result("データ", "applied")]);
  assert.equal(spec.query, OVERALL.query);
  assert.equal(spec.understanding, "保存した設定で判定する");
  assert.deepEqual(spec.criteria, ["設定した最低文字数で判定する"]);
  assert.deepEqual(spec.answers, OVERALL.answers, "確認した要件はどの段階でも使う");
  assert.equal(spec.stages, undefined, "段階の中でさらに段階には分けない");
  assert.deepEqual(spec.stage?.done, ["データ(反映済み)"]);
  assert.deepEqual(spec.stage?.later, ["画面: 画面から設定できる"]);
  const brief = stageBrief(spec);
  assert.match(brief, /3段階に分けて1段階ずつ完成させている。今回は2段階目「処理」だけを実装する/);
  assert.match(brief, /済んだ段階\(変更はファイルに入っている\): データ\(反映済み\)/);
  assert.match(brief, /後の段階でやること\(今回は手を付けない/);
  assert.equal(stageBrief({}), "", "段階に分けていなければ何も足さない");
  // 受け入れ条件の無い段階は、ねらいを条件にする
  assert.deepEqual(stageSpec(OVERALL, STAGES, 2, []).criteria, ["画面から設定できる"]);
});

test("段階: 変えた行(変更後の行番号)を、次の段階で今の内容を読み直す手がかりにする", () => {
  assert.deepEqual(changedFocus([{ path: "a.ts", original: "a\nb\nc", final: "a\nB\nc\nd" }]), [{ path: "a.ts", lines: [2, 4] }]);
  assert.deepEqual(changedFocus([{ path: "new.ts", original: null, final: "x\ny" }]), [{ path: "new.ts", lines: [1, 2] }]);
});

test("進み具合の見直し: 依頼全体の受け入れ条件と済んだ段階を見比べ、残りの段階を足し引きする / 完成なら残りは空", async () => {
  const llm = fakeLlm(() =>
    JSON.stringify({
      complete: false,
      reason: "画面と、飛ばした処理が残っている",
      remaining: [
        { label: "処理(小さく分けた)", goal: "判定だけ変える", acceptanceCriteria: ["判定に設定を使う"] },
        { label: "画面", goal: "画面から設定できる", acceptanceCriteria: [] },
      ],
    }),
  );
  const opts = { level: "intermediate" as const, maxPlaces: 3, maxLines: 60 };
  const review = await reviewProgress(llm, opts, OVERALL, [result("データ", "applied"), result("処理", "skipped")], STAGES.slice(2));
  assert.equal(review.complete, false);
  assert.deepEqual(review.remaining.map((s) => s.label), ["処理(小さく分けた)", "画面"]);
  assert.equal(review.reason, "画面と、飛ばした処理が残っている");
  const [system, user] = llm.requests[0]!.messages;
  assert.match(system!.content!, /依頼全体が完成するまで進める/);
  assert.match(system!.content!, /計画できずに飛ばした」段階があれば/);
  assert.match(user!.content!, /【依頼全体の受け入れ条件】\n1\. 設定した最低文字数でログインを判定する/);
  assert.match(user!.content!, /### 2\. 処理\(計画できずに飛ばした\)/);
  assert.match(user!.content!, /【予定していた残りの段階】\n1\. 画面: 画面から設定できる/);

  // 完成と判断したら、残りがあっても終える
  const done = await reviewProgress(fakeLlm(() => JSON.stringify({ complete: true, reason: "すべて満たした", remaining: [{ label: "x", goal: "", acceptanceCriteria: [] }] })), opts, OVERALL, [], []);
  assert.deepEqual([done.complete, done.remaining], [true, []]);

  // 見直しに失敗しても、予定していた残りの段階で続ける
  const failed = await reviewProgress(fakeLlm(() => new Error("api down")), opts, OVERALL, [], STAGES.slice(1));
  assert.deepEqual([failed.complete, failed.remaining.map((s) => s.label)], [false, ["処理", "画面"]]);

  // 中止されたら止める
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(reviewProgress(fakeLlm(() => new Error("aborted")), opts, OVERALL, [], STAGES, { signal: abort.signal }));
});

const AUTH = ["export function login(user: string, password: string): boolean {", "  return password.length > 3;", "}", ""].join("\n");
const UTIL = ["export function clamp(n: number): number {", "  return Math.min(n, 10);", "}", ""].join("\n");

test("段階: 次の段階の前に今のコードで調べ直し(変わったファイルは読み直す)、計画に段階の位置づけを渡す", async () => {
  const root = await makeTempDir();
  await writeFiles(root, { "src/auth.ts": AUTH, "src/util.ts": UTIL });
  const ws = new NodeWorkspace(root);
  // 前の段階の調査で読んだ内容
  const evidence = new EvidenceStore();
  evidence.add("src/auth.ts", 1, AUTH.split("\n").slice(0, 3));
  evidence.add("src/util.ts", 1, UTIL.split("\n").slice(0, 3));
  const base: Investigation = { query: OVERALL.query, mode: "change", messages: [], evidence, notes: "- 前の段階のメモ", steps: 3, needs: [], calls: new Map() };
  // 前の段階で auth.ts を書き換えて反映した
  const applied = ["const MIN = 8;", "", ...AUTH.split("\n")].join("\n").replace("password.length > 3", "password.length > MIN");
  await fs.writeFile(path.join(root, "src/auth.ts"), applied);

  let planUser = "";
  const llm = fakeLlm((req) => {
    if (!req.jsonSchema) {
      return "- src/util.ts の clamp に設定を渡す";
    }
    if (req.jsonSchema.name === "investigation_plan") {
      return JSON.stringify({ needs: [{ need: "上限を決めている関数はどこか", kind: "change_site", why: "w", hints: "clamp" }] });
    }
    if (req.jsonSchema.name === "sufficiency") {
      // 前の段階で読んだ範囲(変わっていない util.ts)だけで分かる
      return JSON.stringify({
        needs: [{ id: "n1", status: "found", locations: [{ path: "src/util.ts", startLine: 1, endLine: 3 }], note: "clamp が上限を決めている" }],
        newNeeds: [],
        summary: "",
      });
    }
    if (req.jsonSchema.name === "change_plan") {
      planUser = req.messages[1]!.content!;
      return JSON.stringify({
        steps: [
          {
            id: "a1",
            dependsOn: [],
            requirements: [1],
            label: "上限を広げる",
            kind: "core",
            why: "設定の値を受け入れるため",
            contract: "外から見た約束は変わらない",
            mechanical: false,
            edits: [{ path: "src/util.ts", create: false, startLine: 2, oldCode: "  return Math.min(n, 10);", newCode: "  return Math.min(n, 20);" }],
          },
        ],
      });
    }
    return JSON.stringify({ resolutions: [] });
  });
  const index = { hasChunks: () => false, search: async () => ({ hits: [], semantic: false }), fileChunks: () => [], findSymbols: () => [], repoMap: () => "" };
  const agent = new QuizAgent({ llm, ws, index, config: { maxSteps: 6, minSimilarity: 0.1, repoMapChars: 1000, evidenceChars: 8000 } });
  const spec = stageSpec(OVERALL, STAGES, 1, [result("データ", "applied")]);
  const inv = await agent.investigateStage(base, spec, [{ path: "src/auth.ts", lines: [1] }], {});

  // 調べ直しの会話は新しく始め、今回の段階の位置づけを伝える
  const first = llm.requests[0]!;
  assert.deepEqual(
    first.messages.slice(0, 2).map((m) => m.role),
    ["system", "user"],
  );
  assert.ok(!first.messages.some((m) => m.role === "tool"), "前の段階の古いツール結果は持ち込まない");
  assert.match(first.messages[1]!.content!, /今回は2段階目「処理」だけを実装する/);
  assert.match(first.messages[1]!.content!, /前の段階で変えたファイル\(今の内容は読み込み済み\): src\/auth\.ts/);
  assert.equal(inv.notes, "- src/util.ts の clamp に設定を渡す\n\n【調査で確かめた場所】\n- [変更する場所] src/util.ts:1-3 — clamp が上限を決めている");
  assert.equal(inv.steps, 0, "前の段階で読んだ範囲で分かれば、新しく調べずに終える");
  assert.ok(
    llm.requests.some((r) => r.messages.some((m) => m.role === "user" && /最大6回\(目安ではなく上限\)/.test(m.content ?? ""))),
    "段階の上限(設定の6回と段階の8回の小さい方)を伝える",
  );
  // 変わったファイルは今の内容、変わっていないファイルは前に読んだ内容のまま
  const rendered = inv.evidence.render(8000);
  assert.match(rendered, /L1\| const MIN = 8;/);
  assert.match(rendered, /L4\|\s+return password\.length > MIN;/);
  assert.ok(!rendered.includes("password.length > 3"), "古い内容は残さない");
  assert.match(rendered, /L2\|\s+return Math\.min\(n, 10\);/);

  const plan = await new ChangePlanner({ llm, ws, config: { evidenceChars: 8000 } }).plan(inv, spec);
  assert.match(planUser, /【段階】依頼全体を3段階に分けて1段階ずつ完成させている。今回は2段階目「処理」だけを実装する/);
  assert.match(planUser, /【受け入れ条件\(今回の段階\)】\n1\. 設定した最低文字数で判定する/);
  assert.match(planUser, /L1\| const MIN = 8;/, "計画にも今の内容を渡す");
  assert.match(lessonGoal(plan), /^依頼全体を3段階に分けたうちの2段階目「処理」です。/);
});

test("applyReview: 直近の段階は変えず、後ろの追加・変更・削除に印を付ける", () => {
  const st = (label: string, goal = ""): StagePlan => ({ label, goal, criteria: [] });
  const before = [st("A", "a"), st("B", "b"), st("C", "c")];
  const { remaining, changes } = applyReview(before, [st("A2", "x"), st("B", "b2"), st("D", "d")]);
  assert.deepEqual(remaining.map((s) => s.label), ["A", "A2", "B", "D"]);
  assert.deepEqual(changes.marks, { A2: "new", B: "changed", D: "new" });
  assert.deepEqual(changes.removed.map((s) => s.label), ["C"]);
  // 完成(残りなし)のときは削除扱いにしない
  assert.deepEqual(applyReview(before, []).changes, { marks: {}, removed: [] });
});
