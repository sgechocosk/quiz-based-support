import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { QuizAgent, type AgentConfig } from "../../core/agent";
import { IndexManager } from "../../core/indexer";
import { applyReview, definitionGaps, formatNotes, parseNeeds, usedNames } from "../../core/investigation";
import { OpenAiClient } from "../../core/llm";
import { EvidenceStore } from "../../core/tools";
import type { ChunkRecord } from "../../core/types";
import { msg, startFakeOpenAi } from "./helpers/fakeOpenAi";
import { makeTempDir, NodeWorkspace, writeFiles } from "./helpers/nodeWorkspace";
import { TsCompilerParser } from "./helpers/tsAst";

const FILES = {
  "src/auth.ts": [
    "export function login(user: string, password: string): boolean {",
    '  return password.length > 3 && user !== "";',
    "}",
    "",
    "export function logout(user: string): void {",
    '  console.log("bye", user);',
    "}",
    "",
  ].join("\n"),
  "src/app.ts": [
    "import { login } from './auth';",
    "",
    "export function handleSubmit(u: string, p: string): boolean {",
    "  return login(u, p);",
    "}",
    "",
    "export function onEnter(): void {",
    "  handleSubmit('a', 'b');",
    "}",
    "",
  ].join("\n"),
  "src/util.ts": ["export function clamp(n: number): number {", "  return Math.min(n, 10);", "}", ""].join("\n"),
};

const CONFIG: AgentConfig = { maxSteps: 20, minSimilarity: 0.05, repoMapChars: 1500, evidenceChars: 12000 };

const read = (p: string, startLine?: number, endLine?: number) => ({ name: "read_file", args: { path: p, startLine, endLine } });
const need = (need: string, kind: string) => ({ need, kind, why: "w", hints: "" });
const found = (id: string, p: string, startLine: number, endLine: number, note = "分かった") => ({
  id,
  status: "found",
  locations: [{ path: p, startLine, endLine }],
  note,
});
const review = (needs: unknown[], newNeeds: unknown[] = [], summary = "- 要点") => ({ needs, newNeeds, summary });

/**
 * 調査の会話を台本どおりに進める偽 LLM。
 * plan: 調べることの整理の応答 / explore: 調査担当の応答(順に使い、尽きたら最後を繰り返す) / reviews: 材料の確認の応答(順に使う)
 */
async function setup(
  t: TestContext,
  script: { plan: unknown; explore: Array<(b: any) => unknown>; reviews: unknown[] },
) {
  const root = await makeTempDir();
  await writeFiles(root, FILES);
  const ws = new NodeWorkspace(root);
  const calls = { plan: [] as any[], explore: [] as any[], review: [] as any[] };
  const server = await startFakeOpenAi((req) => {
    const b = req.body;
    const name = b.response_format?.json_schema?.name;
    if (name === "investigation_plan") {
      calls.plan.push(b);
      return { json: msg(typeof script.plan === "string" ? script.plan : JSON.stringify(script.plan)) };
    }
    if (name === "sufficiency") {
      calls.review.push(b);
      const next = script.reviews[calls.review.length - 1];
      if (next === undefined) {
        throw new Error("想定外の材料の確認");
      }
      return { json: msg(JSON.stringify(next)) };
    }
    if (b.tools) {
      calls.explore.push(b);
      const turn = script.explore[Math.min(calls.explore.length, script.explore.length) - 1]!;
      return { json: turn(b) };
    }
    throw new Error(`想定外のリクエスト: ${name}`);
  });
  t.after(() => server.close());
  const client = new OpenAiClient({
    apiKey: async () => "sk-test",
    baseUrl: () => server.baseUrl,
    model: () => "test-model",
    embeddingModel: () => "test-embed",
    sleep: async () => undefined,
  });
  const index = new IndexManager({
    dir: path.join(root, ".idx"),
    workspace: ws,
    parser: new TsCompilerParser(),
    embedder: () => client,
    embeddingModel: () => "test-embed",
  });
  await index.load();
  await index.commit(await index.prepare(), { embed: false });
  return { ws, client, index, calls };
}

const lastUser = (b: any): string => {
  const users = b.messages.filter((m: any) => m.role === "user");
  return users[users.length - 1].content;
};
const toolResults = (b: any): string[] => b.messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);

test("調査: 調べることを決めてから調べ、材料が足りたと確認できたら上限を待たずに終える", async (t) => {
  const { ws, client, index, calls } = await setup(t, {
    plan: { needs: [need("パスワードを判定している関数はどこか", "change_site"), need("判定する関数はどこから呼ばれるか", "caller")] },
    explore: [
      () => msg(null, [read("src/auth.ts", 1, 3), read("src/app.ts")]),
      () => msg("- src/auth.ts:1-3 の login が判定している"),
    ],
    reviews: [review([found("n1", "src/auth.ts", 1, 3, "login が長さで判定する"), found("n2", "src/app.ts", 3, 5, "handleSubmit から呼ばれる")])],
  });
  const statuses: string[] = [];
  const agent = new QuizAgent({ llm: client, ws, index, config: CONFIG });
  const inv = await agent.investigate("login の password 判定を強化したい", "auto", { onStatus: (s) => statuses.push(s) });

  // 調べることを、手がかり(要求の文で検索した候補)を見ながら決める
  const planUser = calls.plan[0].messages[1].content as string;
  assert.match(planUser, /【手がかり: 要求の文で検索して見つかった候補\(まだ読んでいない\)】\n- src\/auth\.ts:1-7\(function login,logout\)/);
  assert.match(lastUser(calls.plan[0]), /調べ始める前に/);
  // 上限は目安ではないことと、調べる項目を伝える
  const start = lastUser(calls.explore[0]);
  assert.match(start, /- n1 \[変更する場所\] パスワードを判定している関数はどこか/);
  assert.match(start, /- n2 \[呼び出し元・入口\]/);
  assert.match(start, /最大20回\(目安ではなく上限\)/);
  assert.ok(statuses.some((s) => s.startsWith("調べること: 変更する場所(パスワードを判定している関数はどこか)")));
  // 同時に呼んだ2つを実行し、残りの回数と、まだ確かめていない項目を添える
  assert.match(toolResults(calls.explore[1])[1]!, /\(残りのツール呼び出し: 18回。まだ確かめていない項目: n1, n2\)$/);
  assert.match(lastUser(calls.review[0]), /【項目】\n- n1 \[変更する場所\]/);
  assert.match(lastUser(calls.review[0]), /\(残りのツール呼び出し: 18回\)$/);

  assert.equal(inv.steps, 2, "足りたので、上限(20回)まで使わずに終える");
  assert.equal(calls.explore.length, 2);
  assert.equal(calls.review.length, 1);
  assert.deepEqual(
    inv.needs.map((n) => [n.id, n.status]),
    [
      ["n1", "found"],
      ["n2", "found"],
    ],
  );
  assert.equal(
    inv.notes,
    [
      "- 要点",
      "",
      "【調査で確かめた場所】",
      "- [変更する場所] src/auth.ts:1-3 — login が長さで判定する",
      "- [呼び出し元・入口] src/app.ts:3-5 — handleSubmit から呼ばれる",
    ].join("\n"),
  );
  // 後から読んだファイルより、変更する場所のあるファイルを先に渡す
  assert.match(inv.evidence.render(5000), /^### src\/auth\.ts/);
});

test("調査: 足りない項目・読んでいない根拠・新しく分かった項目を伝えて調査を続けさせる", async (t) => {
  const { ws, client, index, calls } = await setup(t, {
    plan: { needs: [need("判定する関数はどこか", "change_site"), need("手本になる呼び出しはどれか", "example")] },
    explore: [
      () => msg(null, [read("src/auth.ts")]),
      () => msg("- login が判定する"),
      () => msg(null, [read("src/app.ts")]),
      () => msg("- handleSubmit が login を呼ぶ"),
    ],
    reviews: [
      review(
        [found("n1", "src/auth.ts", 1, 3), found("n2", "src/app.ts", 3, 5)], // n2 はまだ読んでいない
        [need("画面の操作はどこから始まるか", "caller")],
      ),
      review([found("n1", "src/auth.ts", 1, 3), found("n2", "src/app.ts", 3, 5), found("n3", "src/app.ts", 7, 9)], [], "- まとめ"),
    ],
  });
  const statuses: string[] = [];
  const agent = new QuizAgent({ llm: client, ws, index, config: CONFIG });
  const inv = await agent.investigate("login の判定を変えたい", "auto", { onStatus: (s) => statuses.push(s) });

  const cont = lastUser(calls.explore[2]);
  assert.match(cont, /^まだ分かっていない項目があります。ツールで調べてください\(残りのツール呼び出し: 19回\)。/);
  assert.match(cont, /- n2 \[手本\] 手本になる呼び出しはどれか — src\/app\.ts:3-5 はまだ読んでいない/);
  assert.match(cont, /- n3 \[呼び出し元・入口\] 画面の操作はどこから始まるか/);
  assert.match(cont, /読んでいない範囲を根拠にしていました: src\/app\.ts:3-5/);
  assert.ok(!/- n1 /.test(cont), "分かった項目は伝えない");
  assert.ok(statuses.some((s) => s.startsWith("材料の確認: まだ分からないこと — 手本になる呼び出しはどれか / 画面の操作はどこから始まるか")));
  // 2回目の確認では、前回の判断を添える
  assert.match(lastUser(calls.review[1]), /- n1 \[変更する場所\] 判定する関数はどこか\(前回: 分かった\)/);
  assert.match(lastUser(calls.review[1]), /- n2 \[手本\] 手本になる呼び出しはどれか\(前回: まだ — src\/app\.ts:3-5 はまだ読んでいない\)/);

  assert.equal(inv.steps, 2);
  assert.equal(calls.review.length, 2);
  assert.ok(inv.needs.every((n) => n.status === "found"));
  assert.match(inv.notes, /^- まとめ\n\n【調査で確かめた場所】/);
});

test("調査: 調べ続けていても、一定の回数で材料を確かめ、足りていればそこで終える", async (t) => {
  const { ws, client, index, calls } = await setup(t, {
    plan: { needs: [need("判定する関数はどこか", "change_site")] },
    // 調査担当は自分からは終えない
    explore: [(b) => msg(null, [read("src/auth.ts", toolResults(b).length + 1, toolResults(b).length + 1)])],
    reviews: [review([found("n1", "src/auth.ts", 1, 3)])],
  });
  const agent = new QuizAgent({ llm: client, ws, index, config: CONFIG });
  const inv = await agent.investigate("login の判定を変えたい", "auto");
  assert.equal(inv.steps, 3, "項目1つなら3回調べたところで確かめる");
  assert.equal(calls.explore.length, 3);
  assert.match(lastUser(calls.review[0]), /^ここまでに集めた材料で足りるかを確認します/);
  assert.equal(inv.needs[0]!.status, "found");
});

test("調査: 上限を超える呼び出しと同じ呼び出しの繰り返しは実行せず、上限に達したら調べきれなかったことを残す", async (t) => {
  const { ws, client, index, calls } = await setup(t, {
    plan: { needs: [need("判定する関数はどこか", "change_site")] },
    explore: [
      () =>
        msg(null, [
          read("src/auth.ts", 1, 3),
          { name: "read_file", args: { endLine: 3, path: "src/auth.ts", startLine: 1 } }, // 引数の順序が違うだけの同じ呼び出し
          read("src/app.ts"),
          read("src/util.ts"),
        ]),
    ],
    reviews: [review([{ id: "n1", status: "missing", locations: [], note: "判定の基準の定義が見つからない" }])],
  });
  const statuses: string[] = [];
  const agent = new QuizAgent({ llm: client, ws, index, config: { ...CONFIG, maxSteps: 2 } });
  const inv = await agent.investigate("login の判定を変えたい", "auto", { onStatus: (s) => statuses.push(s) });

  assert.equal(inv.steps, 2);
  assert.equal(calls.explore.length, 1, "上限に達したら、調査担当にはもう聞かない");
  const results = toolResults(calls.review[0]);
  assert.match(results[1]!, /^この呼び出しは調査 1 で実行済みです/);
  assert.match(results[2]!, /^src\/app\.ts \(L1-10/);
  assert.match(results[3]!, /^ツール呼び出しの上限に達したため、実行しませんでした。/);
  assert.ok(!inv.evidence.paths().includes("src/util.ts"));
  assert.match(lastUser(calls.review[0]), /^ツール呼び出しの上限に達しました/);
  assert.match(lastUser(calls.review[0]), /newNeeds は空配列にする/);
  assert.ok(!lastUser(calls.review[0]).includes("残りのツール呼び出し"), "最後の確認では残りの回数を伝えない");
  assert.match(inv.notes, /【調べきれなかったこと\(推測で補わず、確かめた範囲で扱う\)】\n- \[変更する場所\] 判定する関数はどこか — 判定の基準の定義が見つからない/);
  assert.ok(statuses.some((s) => s.startsWith("材料の確認: 調べきれなかったこと — 判定する関数はどこか")));
});

test("調査: 調べることを決められなければ既定の項目で調べ、足りないと伝えても何も調べなければ打ち切る", async (t) => {
  const { ws, client, index, calls } = await setup(t, {
    plan: "{broken",
    explore: [() => msg("調査メモ")],
    reviews: [review([{ id: "n1", status: "missing", locations: [], note: "" }, { id: "n2", status: "missing", locations: [], note: "" }])],
  });
  const agent = new QuizAgent({ llm: client, ws, index, config: CONFIG });
  const inv = await agent.investigate("login の判定を変えたい", "auto");
  assert.deepEqual(
    inv.needs.map((n) => n.kind),
    ["change_site", "example"],
  );
  assert.match(lastUser(calls.explore[0]), /- n2 \[手本\] 同じ種類のことをしている既存の実装/);
  assert.equal(calls.review.length, 1);
  assert.equal(calls.explore.length, 2, "足りないと伝えた後に何も調べずに終えたら、それ以上は続けない");
  assert.equal(inv.steps, 0);
  assert.ok(!inv.evidence.isEmpty(), "何も読まなかったときは、要求の文で検索した上位を読む");
});

test("材料の確認: 必須の項目が無ければ足し、長い範囲は十分な行数を読んでいれば根拠と認める", () => {
  const change = parseNeeds({ needs: [need("手本は?", "example"), need("謎", "unknown-kind")] }, true);
  assert.deepEqual(
    change.map((n) => [n.id, n.kind]),
    [
      ["n1", "change_site"],
      ["n2", "example"],
      ["n3", "other"],
    ],
  );
  assert.deepEqual(
    parseNeeds({ needs: [] }, false).map((n) => n.kind),
    ["core", "caller"],
  );

  const evidence = new EvidenceStore();
  evidence.add("src/big.ts", 1, Array.from({ length: 50 }, (_, i) => `line ${i + 1}`));
  const needs = parseNeeds({ needs: [need("変える場所", "change_site"), need("要らない", "data")] }, true);
  const outcome = applyReview(
    needs,
    {
      needs: [
        { id: "n1", status: "found", locations: [{ path: "./src/big.ts", startLine: 1, endLine: 400 }], note: "読んだ" },
        { id: "n2", status: "not_needed", locations: [], note: "設定は変わらない" },
      ],
      newNeeds: [need("変える場所", "change_site")], // 同じ項目は足さない
      summary: " 要点 ",
    },
    evidence,
    { change: true, final: false },
  );
  assert.equal(outcome.sufficient, true, "400行の範囲でも、50行読んでいれば根拠と認める");
  assert.deepEqual(needs[0]!.locations, [{ path: "src/big.ts", startLine: 1, endLine: 400 }]);
  assert.equal(needs.length, 2);
  assert.equal(outcome.summary, "要点");

  // 変更する場所を「不要」と答えても、1つも確かめていなければ足りない
  const again = applyReview(
    parseNeeds({ needs: [need("変える場所", "change_site")] }, true),
    { needs: [{ id: "n1", status: "not_needed", locations: [], note: "なし" }], newNeeds: [], summary: "" },
    evidence,
    { change: true, final: false },
  );
  assert.equal(again.sufficient, false);
  assert.match(again.open[0]!.note, /変更する場所が根拠つきで1つも確かめられていない/);
  assert.equal(
    formatNotes(again.open, ""),
    "【調べきれなかったこと(推測で補わず、確かめた範囲で扱う)】\n- [変更する場所] 変える場所 — 変更する場所が根拠つきで1つも確かめられていない",
  );
});

test("材料の確認: 変更する場所で使っているのに定義を読んでいない名前を見つける", () => {
  assert.deepEqual(
    usedNames(["  const user = await loadUser(id); // fetchAll() はコメント", '  if (ok) { new Session(user).start("x(y)"); }', "  let s: Settings;"]),
    ["loadUser", "Session", "start", "Settings"],
  );
  const evidence = new EvidenceStore();
  evidence.add("src/app.ts", 3, ["export function handleSubmit(u: string, p: string): boolean {", "  return login(u, p) && check(p);", "}"]);
  evidence.add("src/check.ts", 1, ["export function check(p: string) {", "  return true;", "}"]);
  const chunk = (file: string, symbols: string[], startLine: number, endLine: number) => ({ file, symbols, startLine, endLine }) as ChunkRecord;
  const index = {
    findSymbols: (q: string) =>
      [chunk("src/auth.ts", ["login"], 1, 3), chunk("src/check.ts", ["check"], 1, 3), chunk("src/app.ts", ["handleSubmit"], 3, 5)].filter((c) =>
        c.symbols.some((s) => s.includes(q)),
      ),
  };
  const needs = parseNeeds({ needs: [need("変える場所", "change_site")] }, true);
  Object.assign(needs[0]!, { status: "found", locations: [{ path: "src/app.ts", startLine: 3, endLine: 5 }] });
  assert.deepEqual(definitionGaps(needs, evidence, index), ["login(src/auth.ts:1)"], "読んだ check と、同じ範囲で定義する handleSubmit は除く");
});

test("参照コード: 確かめた場所のファイルを先に並べ、収まらなければその範囲だけ残し、収まらないファイルは飛ばす", () => {
  const evidence = new EvidenceStore();
  evidence.add("src/key.ts", 1, Array.from({ length: 200 }, (_, i) => `const k${i + 1} = ${i + 1};`));
  evidence.add("src/big.ts", 1, Array.from({ length: 200 }, (_, i) => `const b${i + 1} = ${i + 1};`));
  evidence.add("src/small.ts", 1, ["export const s = 1;"]);
  evidence.markKey("src/key.ts", 150, 152, 0);
  const out = evidence.render(1500);
  assert.match(out, /^### src\/key\.ts\nL142\| const k142 = 142;/, "重要な範囲の前後だけを残す");
  assert.match(out, /L160\| const k160 = 160;\n\n### src\/small\.ts/, "収まらない big.ts は飛ばし、小さな small.ts は入れる");
  assert.ok(!out.includes("src/big.ts"));
  assert.ok(!out.includes("L1| const k1 "));
});
