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

const blank = (line: number, target: string, over: Record<string, unknown> = {}) => ({
  line,
  target,
  concept: "条件式",
  hintConcept: "長さの比較",
  hintApproach: "passwordに注目",
  hintSyntax: "プロパティと数値の比較",
  why: "src/auth.ts:2 で長さを確かめている",
  cluePath: "",
  clueLine: 0,
  clueNote: "",
  ...over,
});

const goodItem = {
  kind: "read",
  path: "src/auth.ts",
  startLine: 2, // 意図的にずらす(正しくは1〜3)
  endLine: 4,
  firstLine: "export function login(user: string, password: string): boolean {",
  lastLine: "}",
  task: "login がどんな条件でログインを許可するかを読み取る",
  newCode: "",
  blanks: [
    blank(1, "boolean", {
      concept: "型注釈",
      hintConcept: "戻り値の型を考える",
      hintApproach: "return式の型を見る",
      hintSyntax: "プリミティブ型の名前",
      cluePath: "src/app.ts",
      clueLine: 3, // handleSubmit の戻り値型にも同じ型が書かれている → 答えを含むので外される
      clueNote: "呼び出し元の型",
    }),
    // 空白を省いて写しても、実コードの表記に揃う
    blank(2, "password.length>3", { cluePath: "src/app.ts", clueLine: 4, clueNote: "ここから呼ばれる" }),
  ],
  refs: [
    { path: "src/app.ts", line: 4, note: "login の呼び出し元" },
    { path: "src/nope.ts", line: 1, note: "存在しない" },
  ],
  explanation: "login は 3 文字より長いパスワードかつ空でないユーザーを許可する。",
};
// 実コードに無い答え(幻覚)。空欄が1つも実コードに見つからないので不採用
const hallucinated = { ...goodItem, blanks: [blank(2, "password.length > 8")] };

test("通し: 調査(検索→読み取り)→出題→検証(行ずれ補正・幻覚の排除・手がかり確認)→採点→反映", async (t) => {
  let quizCalls = 0;
  let retryPrompt = "";
  const { index, ws, lsp, client } = await setup(t, (req) => {
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
      if (quizCalls === 1) {
        return { json: msg(JSON.stringify({ goal: "loginの判定条件を理解する", overallExplanation: "全体", items: [goodItem, hallucinated] })) };
      }
      // 2回目は不合格だった問題だけの作り直し
      retryPrompt = b.messages[b.messages.length - 1].content;
      return { json: msg(JSON.stringify({ goal: "", overallExplanation: "", items: [hallucinated] })) };
    }
    if (b.response_format?.json_schema?.name === "judge") {
      return { json: msg(JSON.stringify({ results: [{ index: 0, equivalent: true, reason: "同値" }] })) };
    }
    throw new Error("想定外のリクエスト");
  });
  const statuses: string[] = [];
  const agent = new QuizAgent({ llm: client, ws, lsp, index, config: CONFIG });
  const result = await agent.run("loginのパスワード判定はどう動く?", "auto", { onStatus: (s) => statuses.push(s) });

  assert.equal(quizCalls, 2, "1問しか残らなかったので、不合格分だけ1回作り直させる");
  assert.match(retryPrompt, /1問は合格し、1問が不合格/);
  assert.match(retryPrompt, /見つかりません/);
  assert.equal(result.steps, 2);
  assert.ok(statuses.some((s) => s.startsWith("調査 1: search_code")));
  assert.equal(result.quiz.items.length, 1, "幻覚を含む問題は除外され、正しい問題だけ残る");
  assert.equal(result.quiz.rejected.length, 2);
  assert.equal(result.quiz.goal, "loginの判定条件を理解する");
  const item = result.quiz.items[0]!;
  assert.deepEqual([item.startLine, item.endLine], [1, 3], "行番号が補正されていない");
  assert.ok(!item.original.includes("```"));
  assert.deepEqual(
    item.blanks.map((b) => b.answer),
    ["boolean", "password.length > 3"],
  );
  assert.equal(item.task, "login がどんな条件でログインを許可するかを読み取る");
  // 手がかり: 答えを含む行は外し、含まない行は残す。存在しない参考コードも外す
  assert.equal(item.blanks[0]!.clue, undefined);
  assert.deepEqual(item.blanks[1]!.clue, { path: "src/app.ts", line: 4, note: "ここから呼ばれる" });
  assert.deepEqual(item.refs, [{ path: "src/app.ts", line: 4, note: "login の呼び出し元" }]);

  // 採点: 厳密一致 + 空白差は正解、不一致は判定器で救済
  const judge = makeSemanticJudge(client);
  const grades = await gradeBlanks(item, ["boolean", "3 < password.length"], judge);
  assert.deepEqual(
    grades.map((g) => [g.correct, g.via]),
    [
      [true, "exact"],
      [true, "semantic"],
    ],
  );

  // read問題は反映対象ではないが、change化した場合にも安全に反映できる
  const changed = { ...item, kind: "change" as const, quizCode: item.quizCode.replace("___BLANK___ &&", "___BLANK___ ||") };
  const after = applyItemToText(await ws.readText("src/auth.ts"), changed);
  assert.match(after, /password\.length > 3 \|\| user/);
});

test("再試行: 全問が検証落ちしたら理由を添えて出し直させる", async (t) => {
  let quizCalls = 0;
  let sawFeedback = false;
  const { ws, index, client } = await setup(t, (req) => {
    const b = req.body;
    if (b.tools) {
      return { json: msg("調査メモ") };
    }
    quizCalls++;
    if (quizCalls === 1) {
      return { json: msg(JSON.stringify({ goal: "g", overallExplanation: "o", items: [hallucinated] })) };
    }
    const last = b.messages[b.messages.length - 1].content as string;
    sawFeedback = /検証で全問不合格/.test(last) && /見つかりません/.test(last);
    return { json: msg(JSON.stringify({ goal: "g", overallExplanation: "o", items: [goodItem] })) };
  });
  const agent = new QuizAgent({ llm: client, ws, index, config: CONFIG });
  const r = await agent.run("login", "read");
  assert.equal(quizCalls, 2);
  assert.ok(sawFeedback);
  assert.equal(r.quiz.items.length, 1);
});

test("実装依頼: 読解問題しか返らなければ実装問題を要求して作り直させ、読解→実装の順に出題する", async (t) => {
  const changeItem = {
    ...goodItem,
    kind: "change",
    task: "パスワードの最低文字数を厳しくする(9文字以上で許可)",
    newCode: ["export function login(user: string, password: string): boolean {", '  return password.length > 8 && user !== "";', "}"].join("\n"),
    blanks: [blank(2, "password.length > 8")],
    refs: [],
  };
  let quizCalls = 0;
  let firstSystem = "";
  let retryPrompt = "";
  let exploreUser = "";
  const { ws, index, client } = await setup(t, (req) => {
    const b = req.body;
    if (b.tools || !b.response_format) {
      exploreUser = b.messages[1].content;
      return { json: msg(null, [{ name: "read_file", args: { path: "src/auth.ts" } }]) };
    }
    if (b.response_format?.json_schema?.name !== "quiz") {
      throw new Error("想定外のリクエスト");
    }
    quizCalls++;
    if (quizCalls === 1) {
      firstSystem = b.messages[0].content;
      return { json: msg(JSON.stringify({ goal: "パスワード条件を変える", overallExplanation: "o", items: [goodItem] })) };
    }
    retryPrompt = b.messages[b.messages.length - 1].content;
    return { json: msg(JSON.stringify({ goal: "", overallExplanation: "", items: [changeItem] })) };
  });
  const agent = new QuizAgent({ llm: client, ws, index, config: { ...CONFIG, maxSteps: 1 } });
  const r = await agent.run("パスワードの最低文字数を9文字にしたい", "auto");
  assert.match(exploreUser, /実装・修正の依頼です/);
  assert.match(firstSystem, /kind="change" を必ず1問以上/);
  assert.equal(quizCalls, 2);
  assert.match(retryPrompt, /kind="change" の問題が必要ですが、まだ1問もありません/);
  assert.deepEqual(
    r.quiz.items.map((i) => i.kind),
    ["read", "change"],
  );
  assert.equal(r.quiz.notice, undefined);
  assert.equal(r.quiz.items[1]!.blanks[0]!.answer, "password.length > 8");
});

test("実装依頼: 実装問題をどうしても作れなければ、読解のみである旨を知らせる", async (t) => {
  const { ws, index, client } = await setup(t, (req) => {
    const b = req.body;
    if (b.tools || !b.response_format) {
      return { json: msg(null, [{ name: "read_file", args: { path: "src/auth.ts" } }]) };
    }
    return { json: msg(JSON.stringify({ goal: "g", overallExplanation: "o", items: [goodItem] })) };
  });
  const agent = new QuizAgent({ llm: client, ws, index, config: { ...CONFIG, maxSteps: 1 } });
  const r = await agent.run("ログアウト機能を追加したい", "auto");
  assert.equal(r.quiz.items.length, 1, "同じ読解問題は重複させない");
  assert.match(r.quiz.notice ?? "", /読解問題のみ/);
});

test("答え漏れ: ヒント・課題文が答えを含むと書き直させ、直らなければ伏せ字・形のヒントにする", async (t) => {
  const leaky = {
    ...goodItem,
    task: "password.length > 3 かどうかを読む",
    blanks: [
      blank(1, "boolean", { concept: "型注釈", hintConcept: "戻り値の型", hintApproach: "return を見る", hintSyntax: "boolean と書く" }),
      blank(2, "password.length > 3", { hintApproach: "password の length を 3 と比べる", hintSyntax: "password.length > 3" }),
    ],
    refs: [],
  };
  let fixRequest = "";
  const { ws, index, client } = await setup(t, (req) => {
    const b = req.body;
    if (b.tools || !b.response_format) {
      return { json: msg(null, [{ name: "read_file", args: { path: "src/auth.ts" } }]) };
    }
    if (b.response_format?.json_schema?.name === "quiz") {
      return { json: msg(JSON.stringify({ goal: "login の条件を理解する", overallExplanation: "o", items: [leaky] })) };
    }
    if (b.response_format?.json_schema?.name === "leak_fix") {
      fixRequest = b.messages[1].content;
      return {
        json: msg(
          JSON.stringify({
            fixes: [
              { id: "0.task", text: "login がどんな入力を受け入れるか、条件式を読み解く" },
              { id: "0.1.hint1", text: "引数のうち文字列の長さを確かめている方に注目する" },
              // 書き直しても漏れている → 形だけのヒントに置き換わる
              { id: "0.1.hint2", text: "password.length > 3 です" },
            ],
          }),
        ),
      };
    }
    throw new Error("想定外のリクエスト");
  });
  const agent = new QuizAgent({ llm: client, ws, index, config: { ...CONFIG, maxSteps: 1 } });
  const r = await agent.run("login", "read");
  assert.match(fixRequest, /id: 0\.task/);
  assert.match(fixRequest, /id: 0\.0\.hint2/);
  const item = r.quiz.items[0]!;
  assert.equal(item.task, "login がどんな入力を受け入れるか、条件式を読み解く");
  assert.equal(item.blanks[1]!.hints[1], "引数のうち文字列の長さを確かめている方に注目する");
  assert.match(item.blanks[1]!.hints[2]!, /___\.___ > \(数値\)/);
  assert.match(item.blanks[0]!.hints[2]!, /1つの語/, "返ってこなかった修正は、形のヒントで埋める");
  const visible = [r.quiz.goal, item.task ?? "", ...item.blanks.flatMap((b) => [b.concept, ...b.hints])].join("\n");
  for (const b of item.blanks) {
    assert.ok(!visible.includes(b.answer), `解答前の文章に答え「${b.answer}」が残っている`);
  }
});

test("構文チェッカがあると、構文を壊すchange問題は不採用になる", async (t) => {
  const change = {
    ...goodItem,
    kind: "change",
    newCode: ["export function login(user: string, password: string): boolean {", "  return password.length >;", "}"].join("\n"),
    blanks: [blank(2, "password.length >")],
    refs: [],
  };
  const { ws, index, client } = await setup(t, (req) => {
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
