import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { makeSemanticJudge, QuizAgent, type AgentConfig } from "../../core/agent";
import { IndexManager } from "../../core/indexer";
import { OpenAiClient } from "../../core/llm";
import { applyItemToText, gradeBlanks } from "../../core/quiz";
import { buildStructureQuestions } from "../../core/questions";
import { EvidenceStore, executeTool, normalizeRelPath, type ToolContext } from "../../core/tools";
import { makeRng } from "../../core/text";
import { FakeLsp } from "./helpers/fakeLsp";
import { msg, startFakeOpenAi } from "./helpers/fakeOpenAi";
import { makeTempDir, NodeWorkspace, writeFiles } from "./helpers/nodeWorkspace";
import { TsCompilerParser } from "./helpers/tsAst";

const AUTH = [
  'export function login(user: string, password: string): boolean {',
  '  return password.length > 3 && user !== "";',
  "}",
  "",
  "export function logout(user: string): void {",
  '  console.log("bye", user);',
  "}",
  "",
].join("\n");

const FILES = {
  "src/auth.ts": AUTH,
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
  "src/util.ts": [
    "export function formatDate(d: Date): string {",
    "  return d.toISOString();",
    "}",
    "",
    "export function clamp(n: number): number {",
    "  return Math.min(n, 10);",
    "}",
    "",
  ].join("\n"),
};

const CONFIG: AgentConfig = { maxSteps: 6, minSimilarity: 0.05, repoMapChars: 1500, evidenceChars: 12000 };

async function setup(t: TestContext, handler: Parameters<typeof startFakeOpenAi>[0]) {
  const root = await makeTempDir();
  await writeFiles(root, FILES);
  const ws = new NodeWorkspace(root);
  const server = await startFakeOpenAi(handler);
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
  await index.commit(await index.prepare(), { embed: true });
  const lsp = new FakeLsp(ws);
  return { root, ws, server, client, index, lsp };
}

const goodItem = {
  kind: "read",
  path: "src/auth.ts",
  startLine: 2, // 意図的にずらす(正しくは1〜3)
  endLine: 4,
  firstLine: "export function login(user: string, password: string): boolean {",
  lastLine: "}",
  quizCode: ["export function login(user: string, password: string): ___BLANK___ {", "  return ___BLANK___ && user !== \"\";", "}"].join("\n"),
  blanks: [
    { answer: "boolean", concept: "型注釈", hintConcept: "戻り値の型を考える", hintApproach: "return式の型を見る", hintSyntax: "プリミティブ型の名前" },
    { answer: "password.length > 3", concept: "条件式", hintConcept: "長さの比較", hintApproach: "passwordに注目", hintSyntax: "obj.prop > 数値" },
  ],
  explanation: "login は 3 文字より長いパスワードかつ空でないユーザーを許可する。",
};
const hallucinated = { ...goodItem, blanks: [goodItem.blanks[0]!, { ...goodItem.blanks[1]!, answer: "password.length > 8" }] };

test("通し: 調査(検索→読み取り)→出題→検証(行ずれ補正・幻覚の排除)→採点→反映", async (t) => {
  let quizCalls = 0;
  const { server, index, ws, lsp, client } = await setup(t, (req) => {
    const b = req.body;
    if (b.tools) {
      const toolMsgs = b.messages.filter((m: any) => m.role === "tool").length;
      if (toolMsgs === 0) {
        assert.match(b.messages[0].content, /src\/auth\.ts|src\/app\.ts/, "repo map がプロンプトに入っていない");
        return { json: msg(null, [{ name: "search_code", args: { query: "login password check" } }]) };
      }
      if (toolMsgs === 1) {
        return { json: msg(null, [{ name: "read_file", args: { path: "src/auth.ts", startLine: 1, endLine: 7 } }]) };
      }
      return { json: msg("- src/auth.ts の 1-3 行目が中心(login)") };
    }
    if (b.response_format?.json_schema?.name === "quiz") {
      quizCalls++;
      const user = b.messages[1].content as string;
      assert.match(user, /L2\|\s+return password\.length > 3/, "実際に読んだ行が根拠として渡されていない");
      assert.ok(!user.includes("formatDate"), "読んでいないファイルが混入している");
      return {
        json: msg(JSON.stringify({ goal: "loginの判定条件を理解する", overallExplanation: "全体", items: [goodItem, hallucinated] })),
      };
    }
    if (b.response_format?.json_schema?.name === "judge") {
      return { json: msg(JSON.stringify({ results: [{ index: 0, equivalent: true, reason: "同値" }] })) };
    }
    throw new Error("想定外のリクエスト");
  });
  const statuses: string[] = [];
  const agent = new QuizAgent({ llm: client, ws, lsp, index, config: CONFIG });
  const result = await agent.run("loginのパスワード判定はどう動く?", "auto", { onStatus: (s) => statuses.push(s) });

  assert.equal(quizCalls, 1);
  assert.equal(result.steps, 2);
  assert.ok(statuses.some((s) => s.startsWith("調査 1: search_code")));
  assert.equal(result.quiz.items.length, 1, "幻覚を含む問題は除外され、正しい問題だけ残る");
  assert.equal(result.quiz.rejected.length, 1);
  const item = result.quiz.items[0]!;
  assert.deepEqual([item.startLine, item.endLine], [1, 3], "行番号が補正されていない");
  assert.ok(!item.original.includes("```"));

  // 採点: 厳密一致 + 空白差は正解、不一致は判定器で救済
  const judge = makeSemanticJudge(client);
  const grades = await gradeBlanks(item, ["boolean", "3 < password.length"], judge);
  assert.deepEqual(grades.map((g) => [g.correct, g.via]), [[true, "exact"], [true, "semantic"]]);

  // read問題は反映対象ではないが、change化した場合にも安全に反映できる
  const changed = { ...item, kind: "change" as const, quizCode: item.quizCode.replace("___BLANK___ &&", "___BLANK___ ||") };
  const after = applyItemToText(await ws.readText("src/auth.ts"), changed);
  assert.match(after, /password\.length > 3 \|\| user/);
});

test("再試行: 全問が検証落ちしたら理由を添えて出し直させる", async (t) => {
  let quizCalls = 0;
  let sawFeedback = false;
  const { server, ws, index, client } = await setup(t, (req) => {
    const b = req.body;
    if (b.tools) {
      return { json: msg("調査メモ") };
    }
    quizCalls++;
    if (quizCalls === 1) {
      return { json: msg(JSON.stringify({ goal: "g", overallExplanation: "o", items: [hallucinated] })) };
    }
    const last = b.messages[b.messages.length - 1].content as string;
    sawFeedback = /検証で全問不合格/.test(last) && /一致しません/.test(last);
    return { json: msg(JSON.stringify({ goal: "g", overallExplanation: "o", items: [goodItem] })) };
  });
  const agent = new QuizAgent({ llm: client, ws, index, config: CONFIG });
  const r = await agent.run("login", "read");
  assert.equal(quizCalls, 2);
  assert.ok(sawFeedback);
  assert.equal(r.quiz.items.length, 1);
});

test("構文チェッカがあると、構文を壊すchange問題は不採用になる", async (t) => {
  const change = {
    ...goodItem,
    kind: "change",
    quizCode: ["export function login(user: string, password: string): boolean {", "  return ___BLANK___;", "}"].join("\n"),
    blanks: [{ ...goodItem.blanks[1]!, answer: "password.length >" }],
  };
  const { server, ws, index, client } = await setup(t, (req) => {
    if (req.body.tools) {
      return { json: msg("メモ") };
    }
    return { json: msg(JSON.stringify({ goal: "g", overallExplanation: "o", items: [change] })) };
  });
  const syntax = { isValid: async (_p: string, text: string) => !text.includes("length >;") && !text.includes("length >\n") };
  const agent = new QuizAgent({ llm: client, ws, index, syntax, config: CONFIG });
  await assert.rejects(agent.run("loginを変えたい", "change"), /検証に通るクイズを作れませんでした/);
});

test("LLMクライアント: 429は待って再試行、401は明確なエラー、404等は即エラー", async (t) => {
  const seen: number[] = [];
  const { server, client } = await setup(t, (req, n) => {
    seen.push(n);
    const mode = req.body.messages?.[0]?.content;
    if (mode === "rate") {
      return seen.filter((x) => x).length % 2 === 0 ? { json: msg("ok") } : { status: 429, json: { error: { message: "slow down" } }, headers: { "retry-after": "0" } };
    }
    if (mode === "auth") {
      return { status: 401, json: { error: { message: "bad key" } } };
    }
    return { status: 400, json: { error: { message: "bad request" } } };
  });
  seen.length = 0;
  const ok = await client.chat({ messages: [{ role: "user", content: "rate" }] });
  assert.equal(ok.content, "ok");
  await assert.rejects(client.chat({ messages: [{ role: "user", content: "auth" }] }), /APIキーが無効です\(401\): bad key/);
  await assert.rejects(client.chat({ messages: [{ role: "user", content: "other" }] }), /API エラー\(400\): bad request/);
});

test("ツール: 経路トラバーサル拒否・grep・outline・参照(LSP/フォールバック)", async (t) => {
  const { server, ws, index, lsp } = await setup(t, () => ({ json: {} }));
  const mk = (withLsp: boolean): ToolContext => ({ ws, lsp: withLsp ? lsp : undefined, index, evidence: new EvidenceStore(), minSimilarity: 0.05 });
  const ctx = mk(true);

  assert.equal(normalizeRelPath("../secret"), undefined);
  assert.equal(normalizeRelPath("/etc/passwd"), undefined);
  assert.equal(normalizeRelPath("./src//a.ts"), "src/a.ts");
  assert.match(await executeTool("read_file", JSON.stringify({ path: "../../etc/passwd" }), ctx), /エラー/);
  assert.match(await executeTool("read_file", JSON.stringify({ path: "src/auth" }), ctx), /近いパス: src\/auth\.ts/);
  assert.match(await executeTool("nope", "{}", ctx), /未知のツール/);
  assert.match(await executeTool("grep", "{bad json", ctx), /JSON/);
  assert.match(await executeTool("grep", JSON.stringify({ pattern: "(" }), ctx), /正規表現が不正/);

  const grep = await executeTool("grep", JSON.stringify({ pattern: "login\\(", glob: "src/**/*.ts" }), ctx);
  assert.match(grep, /src\/app\.ts:4: return login\(u, p\);/);

  const read = await executeTool("read_file", JSON.stringify({ path: "src/app.ts", startLine: 3, endLine: 5 }), ctx);
  assert.match(read, /L3\| export function handleSubmit/);
  assert.match(ctx.evidence.render(5000), /### src\/app\.ts/);

  assert.match(await executeTool("list_files", JSON.stringify({ glob: "*.ts" }), ctx), /src\/util\.ts/);
  assert.match(await executeTool("outline", JSON.stringify({ path: "src/auth.ts" }), ctx), /Function login {2}L1-3/);

  const refs = await executeTool("find_references", JSON.stringify({ path: "src/auth.ts", symbol: "login" }), ctx);
  assert.match(refs, /src\/app\.ts:4:.*\[in handleSubmit\]/);
  const def = await executeTool("find_definition", JSON.stringify({ path: "src/app.ts", symbol: "login", line: 4 }), ctx);
  assert.match(def, /src\/auth\.ts:1:/);

  // LSPなし → 単語境界grepに切り替え、outline はインデックスから
  const noLsp = mk(false);
  assert.match(await executeTool("find_references", JSON.stringify({ path: "src/auth.ts", symbol: "login" }), noLsp), /単語境界grepで代替/);
  assert.match(await executeTool("outline", JSON.stringify({ path: "src/auth.ts" }), noLsp), /login/);
  assert.match(await executeTool("find_symbols", JSON.stringify({ query: "clamp" }), noLsp), /clamp/);

  const sc = await executeTool("search_code", JSON.stringify({ query: "format date iso string" }), ctx);
  assert.match(sc, /src\/util\.ts:1-/);
});

test("構造クイズ: 呼び出し元と定義ファイルをLSPの事実から作る", async (t) => {
  const { server, ws, lsp } = await setup(t, () => ({ json: {} }));
  const qs = await buildStructureQuestions({ ws, lsp }, { path: "src/auth.ts", startLine: 1, endLine: 3 }, makeRng(7));
  const callers = qs.find((q) => q.id.startsWith("callers:"));
  assert.ok(callers, JSON.stringify(qs));
  assert.equal(callers.options.length, 4);
  assert.deepEqual(callers.correct.map((i) => callers.options[i]), ["handleSubmit"]);

  const qs2 = await buildStructureQuestions({ ws, lsp }, { path: "src/app.ts", startLine: 3, endLine: 5 }, makeRng(3));
  const defined = qs2.find((q) => q.id.startsWith("defined:"));
  assert.ok(defined, JSON.stringify(qs2));
  assert.equal(defined.options[defined.correct[0]!], "src/auth.ts");

  // LSPが無反応でもクラッシュせず空配列
  const dead = { documentSymbols: async () => { throw new Error("no server"); }, workspaceSymbols: async () => [], references: async () => [], definition: async () => [] };
  assert.deepEqual(await buildStructureQuestions({ ws, lsp: dead }, { path: "src/auth.ts", startLine: 1, endLine: 3 }, makeRng(1)), []);
});
