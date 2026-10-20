import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import * as ts from "typescript";
import { QuizAgent, type AgentConfig } from "../../core/agent";
import { coChangeSuggestions, keyDelta, keyLiterals, siblingKeys } from "../../core/coupling";
import { declarationsOf, enclosingDeclaration } from "../../core/declarations";
import { applyTextEdits, diffHunks, lineMapper, textEdits } from "../../core/diff";
import { changedSubjects } from "../../core/impact";
import { IndexManager } from "../../core/indexer";
import { buildLesson, gradeItem, gradeQuestion, nextCheckQuestion, revealPayload, stepPayload, whyText } from "../../core/lesson";
import { OpenAiClient, estimateChatTokens, type ApiRequestInfo } from "../../core/llm";
import { locateBlock } from "../../core/editMatch";
import { applyEdits, applyRawEdit, VirtualWorkspace } from "../../core/overlay";
import { matchingRules, parseProjectRules } from "../../core/patterns";
import { ChangePlanner, newDiagnostics, orderSteps, PlanError } from "../../core/planner";
import type { ChangePlan, PlanStep, RequirementSpec } from "../../core/planTypes";
import type { ChatLlm, WorkspacePort } from "../../core/ports";
import { makeRng } from "../../core/text";
import { parseGitLog } from "../../host/gitHistory";
import { TsTypeChecker } from "../../host/typeChecker";
import { FakeLsp } from "./helpers/fakeLsp";
import { investigationReply, msg, startFakeOpenAi } from "./helpers/fakeOpenAi";
import { makeTempDir, NodeWorkspace, writeFiles } from "./helpers/nodeWorkspace";
import { TsCompilerParser } from "./helpers/tsAst";

// ---------- 差分 ----------

test("差分: 最小限の置き換えを当てると変更後に一致し、行番号の対応も取れる", () => {
  const cases: Array<[string, string]> = [
    ["a\nb\nc", "a\nB\nc"],
    ["a\nb\nc\n", "a\nb\nx\nc\n"],
    ["a\nb", "a"],
    ["a", "a\nb"],
    ["", "x\ny"],
    ["x\ny", ""],
    ["a\r\nb\r\nc\r\n", "a\r\nc\r\nd\r\n"],
    ["1\n2\n3\n4\n5\n6\n7\n8", "0\n1\n2\n3\nX\n5\n6\n8\n9"],
  ];
  for (const [before, after] of cases) {
    assert.equal(applyTextEdits(before, textEdits(before, after)), after, JSON.stringify([before, after]));
  }
  const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
  const changed = [...big.slice(0, 10), "inserted", ...big.slice(10, 2000), ...big.slice(2001)];
  const hunks = diffHunks(big, changed);
  assert.deepEqual(hunks, [
    { oldStart: 10, oldCount: 0, newStart: 10, newCount: 1 },
    { oldStart: 2000, oldCount: 1, newStart: 2001, newCount: 0 },
  ]);
  const mapper = lineMapper(big.join("\n"), changed.join("\n"));
  assert.equal(mapper.toCurrent(5), 5);
  assert.equal(mapper.toCurrent(12), 13, "挿入より後ろは1行ずれる");
  assert.equal(mapper.toCurrent(2001), undefined, "消した行は対応しない");
  assert.equal(mapper.toOriginal(11), undefined, "足した行は対応しない");
});

// ---------- 文字列キー・変更履歴・プロジェクトの約束 ----------

test("結合: 文字列キーの文脈・同じ種類のキー・足した/消したキー", () => {
  assert.deepEqual(keyLiterals('this.post({ type: "clarify", id });'), [{ literal: "clarify", context: "prop:type" }]);
  assert.deepEqual(keyLiterals('      case "clarify":'), [{ literal: "clarify", context: "case" }]);
  assert.deepEqual(keyLiterals('  "quizSupport.model": {'), [{ literal: "quizSupport.model", context: "key" }]);
  assert.deepEqual(keyLiterals("import { a } from './core/agent';"), []);
  assert.deepEqual(keyLiterals('if (typeof x === "string") {'), [], "ありふれた文字列はキーにしない");
  assert.deepEqual(siblingKeys('post({ type: "quiz" });\npost({ type: "graded" });\npost({ type: "x1y" });', { literal: "x1y", context: "prop:type" }), ["quiz", "graded"]);
  const delta = keyDelta(['post({ type: "quiz" });'], ['post({ type: "quiz" });', 'post({ type: "lesson" });']);
  assert.deepEqual(delta.added.map((k) => k.literal), ["lesson"]);
  assert.deepEqual(delta.removed, []);
});

test("結合: 一緒に変更されてきたファイル(大きすぎるコミットは除き、確信度順)", () => {
  const commits = [
    ["src/a.ts", "README.md"],
    ["src/a.ts", "README.md", "src/b.ts"],
    ["src/a.ts", "src/b.ts"],
    ["src/a.ts"],
    ["src/c.ts", "README.md"],
    Array.from({ length: 40 }, (_, i) => `src/bulk${i}.ts`).concat("src/a.ts"),
  ];
  const s = coChangeSuggestions(commits, ["src/a.ts"]);
  assert.deepEqual(
    s.map((x) => [x.path, x.support]),
    [
      ["README.md", 2],
      ["src/b.ts", 2],
    ],
  );
  assert.equal(s[0]!.with, "src/a.ts");
  assert.equal(s[0]!.confidence, 0.5);
  assert.deepEqual(parseGitLog("\x1e\nsrc/a.ts\nREADME.md\n\x1e\n\nsrc/b.ts\n"), [["src/a.ts", "README.md"], ["src/b.ts"]]);
});

test("プロジェクトの約束: 読み取り・不正な項目の除外・当てはまる約束", () => {
  const { rules, errors } = parseProjectRules(
    JSON.stringify([
      { name: "設定の登録", when: { literal: "^quizSupport\\." }, check: ["package.json"], criterion: "contributes に書く" },
      { name: "画面の対", when: { path: "media/*.js" }, check: ["src/ChatSidebarProvider.ts"], criterion: "受信側も足す" },
      { name: "壊れた", when: {}, check: [] },
    ]),
  );
  assert.equal(rules.length, 2);
  assert.equal(errors.length, 1);
  assert.deepEqual(
    matchingRules(rules, "src/x.ts", ["quizSupport.newKey"]).map((m) => [m.rule.name, m.literal]),
    [["設定の登録", "quizSupport.newKey"]],
  );
  assert.deepEqual(
    matchingRules(rules, "media/main.js", []).map((m) => m.rule.name),
    ["画面の対"],
  );
  assert.equal(parseProjectRules("{oops").rules.length, 0);
});

// ---------- 宣言と、約束の変化の判定 ----------

const AUTH = [
  "export function login(user: string, password: string): boolean {",
  '  return password.length > 3 && user !== "";',
  "}",
  "",
  "export function logout(user: string): void {",
  '  console.log("bye", user);',
  "}",
  "",
].join("\n");

test("宣言: 関数呼び出しの文は宣言とみなさず、既定引数の {} があっても本体の範囲を正しく取る", () => {
  const lines = [
    "export class A {",
    "  run(q: string, hooks: Hooks = {}): void {",
    "    check({ id: 1 }, answers);",
    "    if (q) {",
    "      return;",
    "    }",
    "  }",
    "}",
  ];
  assert.deepEqual(
    declarationsOf(lines).map((d) => `${d.kind}:${d.name}`),
    ["class:A", "method:run"],
  );
  const enc = enclosingDeclaration(lines, 4, 4);
  assert.deepEqual([enc?.name, enc?.end], ["run", 6]);
});

test("約束の変化: シグネチャの変更・削除・本体だけの変更・型のメンバーの変更を見分ける", () => {
  const edit = (before: string, after: string, file = AUTH, startLine = 1) => {
    const lines = file.split("\n");
    const count = before.split("\n").length;
    return {
      path: "src/auth.ts",
      created: false,
      startLine,
      endLine: startLine + count - 1,
      before,
      after,
      fileBefore: lines.join("\n"),
    };
  };
  const sig = changedSubjects(
    edit(
      "export function login(user: string, password: string): boolean {",
      "export function login(user: string, password: string, min: number): boolean {",
    ),
  );
  assert.deepEqual(sig.map((s) => [s.name, s.pattern, s.what]), [["login", "caller-follow", "シグネチャを変えた"]]);

  const body = changedSubjects(edit('  return password.length > 3 && user !== "";', '  return password.length > 8 && user !== "";', AUTH, 2));
  assert.deepEqual(body.map((s) => [s.name, s.pattern]), [["login", "behavior-callers"]]);

  const log = changedSubjects(edit('  console.log("bye", user);', '  console.info("bye", user);', AUTH, 6));
  assert.deepEqual(log, [], "戻り値・例外に関係しない本体の変更は、呼び出し元に影響しない");

  const shape = "export interface User {\n  name: string;\n}\n";
  const member = changedSubjects(edit("  name: string;", "  name: string;\n  age: number;", shape, 2));
  assert.deepEqual(member.map((s) => [s.name, s.pattern]), [["User", "data-shape"]]);
});

// ---------- 仮想ワークスペース ----------

test("仮想ワークスペース: 実ファイルに書かずに重ね、範囲は内容で探し直し、構文を壊す編集は拒否する", async () => {
  const root = await makeTempDir();
  await writeFiles(root, { "src/auth.ts": AUTH });
  const ws = new NodeWorkspace(root);
  const vws = new VirtualWorkspace(ws);
  const syntax = { isValid: async (_p: string, text: string) => !text.includes("((") };
  const ok = await applyRawEdit(
    vws,
    {
      path: "src/auth.ts",
      create: false,
      startLine: 3, // ずれている(正しくは2)
      endLine: 3,
      firstLine: '  return password.length > 3 && user !== "";',
      lastLine: '  return password.length > 3 && user !== "";',
      newCode: '  return password.length > 8 && user !== "";',
    },
    syntax,
  );
  assert.ok(ok.ok);
  assert.equal(ok.edit.startLine, 2);
  assert.match(await vws.readText("src/auth.ts"), /length > 8/);
  assert.match(await ws.readText("src/auth.ts"), /length > 3/, "実ファイルは変わらない");
  assert.deepEqual(vws.changedPaths(), ["src/auth.ts"]);

  const broken = await applyRawEdit(
    vws,
    { path: "src/auth.ts", create: false, startLine: 5, endLine: 5, firstLine: "export function logout(user: string): void {", lastLine: "export function logout(user: string): void {", newCode: "export function logout((user: string): void {" },
    syntax,
  );
  assert.equal(broken.ok, false);
  const created = await applyRawEdit(vws, { path: "src/new.ts", create: true, startLine: 1, endLine: 1, firstLine: "", lastLine: "", newCode: "export const x = 1;" });
  assert.ok(created.ok);
  assert.ok(vws.isCreated("src/new.ts"));
  assert.equal((await vws.original("src/new.ts")), null);
  const again = await applyRawEdit(vws, { path: "src/new.ts", create: true, startLine: 1, endLine: 1, firstLine: "", lastLine: "", newCode: "x" });
  assert.equal(again.ok, false, "既にあるファイルは新規作成できない");
  assert.equal((await applyRawEdit(vws, { path: "../etc/passwd", create: true, startLine: 1, endLine: 1, firstLine: "", lastLine: "", newCode: "x" })).ok, false);
});

// ---------- 型検査 ----------

test("型検査: 変更を重ねた状態で、変更前には無かったエラーだけを、import しているファイルも含めて見つける", async () => {
  const root = await makeTempDir();
  await writeFiles(root, {
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "commonjs", noEmit: true }, include: ["src"] }),
    "src/auth.ts": AUTH,
    "src/app.ts": "import { login } from './auth';\nexport const ok: boolean = login('a', 'b');\n",
    // 変更前からあるエラー(新しいエラーとは数えない)
    "src/old.ts": "export const broken: number = 'x';\n",
  });
  const checker = new TsTypeChecker(ts, root);
  const overlay = new Map([["src/auth.ts", AUTH.replace("password: string)", "password: string, min: number)")]]);
  const result = await checker.check(overlay);
  assert.ok(result);
  const fresh = newDiagnostics(result.before, result.after);
  assert.equal(fresh.length, 1, JSON.stringify(fresh));
  assert.equal(fresh[0]!.path, "src/app.ts");
  assert.equal(fresh[0]!.line, 2);
  assert.equal(fresh[0]!.code, "2554");
  // 設定ファイルが無ければ型検査しない
  const empty = await makeTempDir();
  await writeFiles(empty, { "a.ts": "export const a = 1;\n" });
  assert.equal(await new TsTypeChecker(ts, empty).check(new Map([["a.ts", "x"]])), undefined);
});

test("型検査の差分: 同じエラーは増えた分だけ新しいとみなす", () => {
  const d = (line: number, message = "m") => ({ path: "a.ts", line, code: "1", message });
  assert.deepEqual(newDiagnostics([d(1)], [d(5), d(6)]).map((x) => x.line), [6]);
  assert.deepEqual(newDiagnostics([d(1), d(2)], [d(3)]), []);
});

// ---------- 並べ替え ----------

test("手順の順序: 先に必要なステップ・引きずられた元を先にし、同時に置けるものは種類の順", () => {
  const step = (id: string, kind: PlanStep["kind"], extra: Partial<PlanStep> = {}): PlanStep => ({
    id,
    number: 0,
    label: id,
    kind,
    why: "",
    contract: "",
    mechanical: false,
    requirements: [],
    dependsOn: [],
    edits: [],
    obligations: [],
    ...extra,
  });
  const ordered = orderSteps([
    step("s1", "ui"),
    step("s2", "core"),
    step("s3", "caller", { causedBy: { obligation: "o1", step: "s2", pattern: "caller-follow" } }),
    step("s4", "data"),
    step("s5", "test", { dependsOn: ["s6"] }),
    step("s6", "doc", { dependsOn: ["s5"] }), // 循環しても止まらない
  ]);
  assert.deepEqual(
    ordered.map((s) => s.id),
    ["s4", "s2", "s3", "s1", "s5", "s6"],
  );
  assert.deepEqual(
    ordered.map((s) => s.number),
    [1, 2, 3, 4, 5, 6],
  );
});

// ---------- API 実行前の確認 ----------

test("API実行前の確認: 目的と入力トークン数の見積もりを渡し、取り消せばリクエストを送らない。実測で見積もりを補正する", async (t) => {
  let sent = 0;
  const server = await startFakeOpenAi(() => {
    sent++;
    return { json: { ...msg("ok"), usage: { prompt_tokens: 400, completion_tokens: 5 } } };
  });
  t.after(() => server.close());
  const seen: ApiRequestInfo[] = [];
  const logs: string[] = [];
  let allow = true;
  const client = new OpenAiClient({
    apiKey: async () => "sk-test",
    baseUrl: () => server.baseUrl,
    model: () => "test-model",
    embeddingModel: () => "test-embed",
    sleep: async () => undefined,
    beforeRequest: async (info) => {
      seen.push(info);
      if (!allow) {
        throw new Error("取り消しました");
      }
    },
    log: (line) => logs.push(line),
  });
  const request = { messages: [{ role: "user" as const, content: "x".repeat(700) }], purpose: "テスト" };
  const raw = estimateChatTokens(request);
  await client.chat(request);
  assert.equal(seen[0]!.purpose, "テスト");
  assert.equal(seen[0]!.kind, "chat");
  assert.equal(seen[0]!.inputTokens, raw);
  assert.deepEqual(logs, ["test-model 入力400(キャッシュ-) 出力5"]);
  await client.chat(request);
  assert.ok(seen[1]!.inputTokens > raw, "実測(400)に近づくよう補正される");

  allow = false;
  await assert.rejects(client.chat(request), /取り消しました/);
  assert.equal(sent, 2, "取り消した呼び出しは送らない");
  assert.equal(logs.length, 2, "取り消した呼び出しは送らないので記録も増えない");
  await assert.rejects(client.embed(["a", "b"], undefined, "埋め込みテスト"), /取り消しました/);
  assert.equal(seen[seen.length - 1]!.purpose, "埋め込みテスト");
  assert.equal(seen[seen.length - 1]!.kind, "embedding");
});

// ---------- 変更計画(通し) ----------

const FILES = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "commonjs", noEmit: true }, include: ["src"] }),
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
  "src/util.ts": ["export function formatDate(d: Date): string {", "  return d.toISOString();", "}", ""].join("\n"),
};

const CONFIG: AgentConfig = { maxSteps: 3, minSimilarity: 0.05, repoMapChars: 1500, evidenceChars: 12000 };

/** fakeInvestigation: 調べることの整理・材料の確認には既定の応答を返す(false ならハンドラが答える) */
async function setup(t: TestContext, handler: Parameters<typeof startFakeOpenAi>[0], { fakeInvestigation = true } = {}) {
  const root = await makeTempDir();
  await writeFiles(root, FILES);
  const ws = new NodeWorkspace(root);
  const server = await startFakeOpenAi((req, n) => (fakeInvestigation ? investigationReply(req.body) : undefined) ?? handler(req, n));
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
  return { root, ws, client, index, lsp: new FakeLsp(ws) };
}

const blankOf = (line: number, target: string) => ({
  line,
  target,
  concept: "引数",
  hintConcept: "最低文字数を渡す",
  hintApproach: "新しい引数の位置を見る",
  why: "src/auth.ts:1 で引数を足したため",
  distractors: [] as Array<{ code: string; whyWrong: string }>,
  cluePath: "",
  clueLine: 0,
  clueNote: "",
});

test("変更計画: 起点の変更 → 参照で呼び出し元を見つけ型エラーを添える → 判断して直す → 型エラーが消える → 依存される側から並べる", async (t) => {
  const resolvePrompts: string[] = [];
  let planUser = "";
  const calls: string[] = [];
  const { root, ws, client, index, lsp } = await setup(t, (req) => {
    const b = req.body;
    if (b.tools || !b.response_format) {
      const toolMsgs = b.messages.filter((m: any) => m.role === "tool").length;
      if (toolMsgs === 0) {
        return { json: msg(null, [{ name: "read_file", args: { path: "src/auth.ts" } }]) };
      }
      if (toolMsgs === 1) {
        return { json: msg(null, [{ name: "read_file", args: { path: "src/app.ts" } }]) };
      }
      return { json: msg("- src/auth.ts の login がパスワードを判定する") };
    }
    const name = b.response_format.json_schema.name;
    calls.push(name);
    if (name === "change_plan") {
      planUser = b.messages[1].content;
      return {
        json: msg(
          JSON.stringify({
            steps: [
              {
                id: "a1",
                dependsOn: [],
                requirements: [1],
                label: "最低文字数を引数で受け取る",
                kind: "core",
                why: "判定の基準を呼び出し側から渡せるようにするため。",
                contract: "login に最低文字数の引数が増える",
                mechanical: false,
                edits: [
                  {
                    path: "src/auth.ts",
                    create: false,
                    startLine: 1,
                    endLine: 3,
                    firstLine: "export function login(user: string, password: string): boolean {",
                    lastLine: "}",
                    newCode: [
                      "export function login(user: string, password: string, minLength: number): boolean {",
                      '  return password.length >= minLength && user !== "";',
                      "}",
                    ].join("\n"),
                  },
                ],
              },
            ],
          }),
        ),
      };
    }
    if (name === "resolve") {
      const prompt: string = b.messages[1].content;
      resolvePrompts.push(prompt);
      const none = { label: "", kind: "caller", why: "", contract: "", mechanical: false, edits: [] };
      // 呼び出し元の追従だけ直し、ほかの確認事項は「変更不要」と答える
      const others = [...prompt.matchAll(/### 確認事項 (o\d+) — (.+)/g)]
        .filter((m) => m[2] !== "呼び出し元の追従")
        .map((m) => ({ obligation: m[1], decisions: [{ site: 1, change: false, reason: "今回の要件とは関係しない" }], step: none }));
      const id = /### 確認事項 (o\d+) — 呼び出し元の追従/.exec(prompt)?.[1];
      if (!id) {
        return { json: msg(JSON.stringify({ resolutions: others })) };
      }
      return {
        json: msg(
          JSON.stringify({
            resolutions: [
              ...others,
              {
                obligation: id,
                decisions: [{ site: 1, change: true, reason: "この行は login を2引数で呼んでいるので、最低文字数も渡す必要がある" }],
                step: {
                  label: "呼び出し側から最低文字数を渡す",
                  kind: "caller",
                  why: "login の引数が増えたため。",
                  contract: "外から見た約束は変わらない",
                  mechanical: false,
                  edits: [
                    {
                      path: "src/app.ts",
                      create: false,
                      startLine: 4,
                      endLine: 4,
                      firstLine: "  return login(u, p);",
                      lastLine: "  return login(u, p);",
                      newCode: "  return login(u, p, 8);",
                    },
                  ],
                },
              },
            ],
          }),
        ),
      };
    }
    if (name === "step_quiz") {
      return {
        json: msg(
          JSON.stringify({
            items: [
              {
                step: "s1",
                edit: 0,
                task: "判定の基準を引数で受け取る",
                explanation: "login は引数の値と比べる",
                newNames: [{ name: "minLength", role: "最低文字数" }],
                refs: [],
                blanks: [blankOf(2, "password.length >= minLength")],
              },
              {
                step: "s2",
                edit: 0,
                task: "呼び出し側で値を渡す",
                explanation: "8文字以上を要求する",
                newNames: [],
                refs: [],
                blanks: [blankOf(1, "login(u, p, 8)")],
              },
            ],
          }),
        ),
      };
    }
    if (name === "leak_fix") {
      return { json: msg(JSON.stringify({ fixes: [] })) };
    }
    throw new Error(`想定外のリクエスト: ${name}`);
  });

  const agent = new QuizAgent({ llm: client, ws, lsp, index, config: CONFIG });
  const inv = await agent.investigate("ログインの最低文字数を呼び出し側で決められるようにしたい", "auto");
  const spec: RequirementSpec = {
    query: inv.query,
    understanding: "最低文字数を呼び出し側から渡す",
    criteria: ["呼び出し側が渡した最低文字数でパスワードを判定する"],
    contracts: [{ kind: "signature", subject: "login", description: "最低文字数の引数が増える" }],
    answers: [],
  };
  const statuses: string[] = [];
  const planner = new ChangePlanner({
    llm: client,
    ws,
    lsp,
    typeChecker: new TsTypeChecker(ts, root),
    history: { commits: async () => [["src/auth.ts", "src/util.ts"], ["src/auth.ts", "src/util.ts"], ["src/auth.ts"]] },
    config: { evidenceChars: 12000 },
  });
  const plan = await planner.plan(inv, spec, { onStatus: (s) => statuses.push(s) });

  assert.match(planUser, /【受け入れ条件】\n1\. 呼び出し側が渡した最低文字数/);
  assert.match(planUser, /src\/util\.ts\(src\/auth\.ts を変えたコミットの67%・2回で一緒に変更\)/, "変更履歴の手がかりを計画に渡す");
  // 呼び出し元の追従: 参照検索で見つけた場所に、型検査のエラーが添えられている
  const firstPrompt = resolvePrompts[0]!;
  assert.match(firstPrompt, /呼び出し元の追従/);
  assert.match(firstPrompt, /\[1\] src\/app\.ts:4\(handleSubmit の中\) — 型エラー: Expected 3 arguments, but got 2/);
  assert.match(firstPrompt, /L4\|\s+return login\(u, p\);/);
  assert.ok(statuses.some((s) => s.includes("型検査")));
  assert.ok(
    !resolvePrompts.some((p) => p.includes("「handleSubmit」の戻り値")),
    "「約束は変わらない」と明言した呼び出し側の修正からは、振る舞いの変化の確認を作らない",
  );

  assert.deepEqual(
    plan.steps.map((s) => [s.number, s.id, s.kind]),
    [
      [1, "s1", "core"],
      [2, "s2", "caller"],
    ],
  );
  const caller = plan.obligations.find((o) => o.pattern === "caller-follow")!;
  assert.equal(caller.fromStep, "s1");
  assert.deepEqual(
    caller.verdicts.map((v) => [v.path, v.changed, v.step]),
    [["src/app.ts", true, "s2"]],
  );
  assert.equal(plan.steps[1]!.causedBy?.obligation, caller.id);
  assert.equal(plan.typecheck.available, true);
  assert.deepEqual(plan.typecheck.remaining, [], "直したあとは新しい型エラーが残らない");
  const coChange = plan.obligations.find((o) => o.pattern === "co-change");
  assert.equal(coChange?.subject, "src/util.ts", "一緒に変わってきたファイルも確認事項になる");
  assert.deepEqual(
    plan.files.map((f) => f.path),
    ["src/app.ts", "src/auth.ts"],
  );
  assert.match(plan.files[0]!.final, /login\(u, p, 8\)/);
  assert.match(await ws.readText("src/app.ts"), /login\(u, p\);/, "計画の段階では実ファイルを変えない");

  // 手順(学習): 理由・穴埋め・次に確認すべき場所の予想
  const lesson = await buildLesson(plan, { llm: client, ws, level: "intermediate", evidence: inv.evidence, evidenceChars: 12000 });
  assert.equal(lesson.steps.length, 2);
  const first = lesson.steps[0]!;
  assert.equal(first.item?.blanks[0]?.answer, "password.length >= minLength");
  assert.ok(first.question, "起点のステップには「次に確認すべき場所」の予想問題が付く");
  const q = first.question!;
  assert.deepEqual(
    q.correct.map((i) => q.options[i]),
    ["src/app.ts の handleSubmit"],
  );
  assert.ok(!q.options.includes("src/auth.ts の login"), "変えた場所そのものは選択肢にしない");
  assert.match(q.hint, /呼び出し元の追従/);
  assert.match(whyText(plan.steps[1]!, plan), /ステップ1「最低文字数を引数で受け取る」でlogin に最低文字数の引数が増えるため、「呼び出し元の追従」の確認でこの場所が見つかりました/);

  // 解答前の画面には、答えや確認事項の結果を出さない
  const before = JSON.stringify(stepPayload(lesson, 0));
  assert.ok(!before.includes("correct") && !before.includes("src/auth.ts:1 で引数を足したため"), "正解の番号・解説は渡さない");
  assert.ok(!before.includes("この行は login を2引数で呼んでいる"), "判断の理由は答え合わせのあとに見せる");
  const reveal = revealPayload(lesson, 0) as { checks: Array<{ pattern: string; results: Array<{ path: string; changed: boolean; step?: number; reason: string }> }> };
  const check = reveal.checks.find((c) => c.pattern === "呼び出し元の追従")!;
  assert.deepEqual(
    check.results.map((r) => [r.path, r.changed, r.step]),
    [["src/app.ts", true, 2]],
  );

  // 採点
  const item = first.item!;
  const right = item.blanks.map((b) => (b.choices ?? []).findIndex((c) => c.code === b.answer));
  const graded = gradeItem(item, right, [1]);
  assert.ok(graded.grades.every((g) => g.correct));
  assert.equal(graded.records[0]!.hintsUsed, 1);
  assert.equal(gradeQuestion(q, q.correct).correct, true);
  assert.equal(gradeQuestion(q, [...q.correct, 99]).correct, true, "範囲外の番号は無視する");
  assert.equal(gradeQuestion(q, []).correct, false);
  assert.deepEqual(
    calls.filter((c) => c !== "leak_fix"),
    ["change_plan", "resolve", "step_quiz"],
  );
});

test("変更計画: 新しいメッセージの種類は、同じ種類の既存のキーを扱う別ファイル(受け手)を確認事項にする", async (t) => {
  const root = await makeTempDir();
  await writeFiles(root, {
    "src/host.ts": [
      "export function send(post: (m: object) => void): void {",
      '  post({ type: "quiz" });',
      '  post({ type: "graded" });',
      "}",
      "",
    ].join("\n"),
    "media/view.js": [
      "function onMessage(m) {",
      "  switch (m.type) {",
      '    case "quiz":',
      "      return 1;",
      '    case "graded":',
      "      return 2;",
      "  }",
      "}",
      "",
    ].join("\n"),
  });
  const ws = new NodeWorkspace(root);
  let resolvePrompt = "";
  const server = await startFakeOpenAi((req) => {
    const name = req.body.response_format?.json_schema?.name;
    if (name === "change_plan") {
      return {
        json: msg(
          JSON.stringify({
            steps: [
              {
                id: "a1",
                dependsOn: [],
                requirements: [1],
                label: "新しいメッセージを送る",
                kind: "core",
                why: "",
                contract: "メッセージの種類 lesson が増える",
                mechanical: false,
                edits: [
                  {
                    path: "src/host.ts",
                    create: false,
                    startLine: 3,
                    endLine: 3,
                    firstLine: '  post({ type: "graded" });',
                    lastLine: '  post({ type: "graded" });',
                    newCode: '  post({ type: "graded" });\n  post({ type: "lesson" });',
                  },
                ],
              },
            ],
          }),
        ),
      };
    }
    if (name === "resolve") {
      resolvePrompt = req.body.messages[1].content;
      return { json: msg(JSON.stringify({ resolutions: [] })) };
    }
    throw new Error(`想定外: ${name}`);
  });
  t.after(() => server.close());
  const client = new OpenAiClient({
    apiKey: async () => "sk",
    baseUrl: () => server.baseUrl,
    model: () => "m",
    embeddingModel: () => "e",
    sleep: async () => undefined,
  });
  const inv = {
    query: "q",
    mode: "auto" as const,
    messages: [],
    evidence: { render: () => "", allText: () => "", paths: () => ["src/host.ts"], add() {}, isEmpty: () => false } as any,
    notes: "",
    steps: 0,
    needs: [],
    calls: new Map(),
  };
  const planner = new ChangePlanner({ llm: client, ws, config: { evidenceChars: 8000 } });
  const plan = await planner.plan(inv, { query: "q", understanding: "", criteria: ["c"], contracts: [], answers: [] });
  const pair = plan.obligations.find((o) => o.pattern === "protocol-pair")!;
  assert.ok(pair, JSON.stringify(plan.obligations));
  assert.equal(pair.subject, '"lesson"');
  assert.deepEqual(
    pair.sites.map((s) => [s.path, s.line]),
    [
      ["media/view.js", 3],
      ["media/view.js", 5],
    ],
  );
  assert.match(pair.query, /同じ種類の既存のキー「quiz」「graded」/);
  assert.match(resolvePrompt, /キーの対応/);
  assert.equal(pair.status, "gave-up", "判断が2回返らなければあきらめて、未解決として示す");
  assert.ok(plan.warnings.some((w) => w.includes("判断しきれなかった")) || plan.obligations.some((o) => o.status === "gave-up"));
  const rng = makeRng(1);
  assert.equal(nextCheckQuestion(plan.steps[0]!, plan, [], rng), undefined, "誤答の候補が足りなければ予想問題は作らない");
});

test("変更計画: 起点の変更が既に呼び出し元も直していれば、その場所は判断待ちにせず「対応済み」にする。書き換えで対象が消えた行は今の内容で判断し直させる", async (t) => {
  const signature = {
    path: "src/auth.ts",
    create: false,
    startLine: 1,
    endLine: 3,
    firstLine: "export function login(user: string, password: string): boolean {",
    lastLine: "}",
    newCode: [
      "export function login(user: string, password: string, minLength: number): boolean {",
      '  return password.length >= minLength && user !== "";',
      "}",
    ].join("\n"),
  };
  const callerEdit = (newCode: string) => ({
    path: "src/app.ts",
    create: false,
    startLine: 4,
    endLine: 4,
    firstLine: "  return login(u, p);",
    lastLine: "  return login(u, p);",
    newCode,
  });
  const step = (id: string, edits: unknown[], extra: Record<string, unknown> = {}) => ({
    id,
    dependsOn: [],
    requirements: [1],
    label: id,
    kind: "core",
    why: "",
    contract: "login に引数が増える",
    mechanical: false,
    edits,
    ...extra,
  });
  const run = async (callerCode: string) => {
    const resolvePrompts: string[] = [];
    const { root, ws, client, lsp } = await setup(t, (req) => {
      const name = req.body.response_format?.json_schema?.name;
      if (name === "change_plan") {
        return {
          json: msg(
            JSON.stringify({
              steps: [step("a1", [signature]), step("a2", [callerEdit(callerCode)], { kind: "caller", contract: "外から見た約束は変わらない" })],
            }),
          ),
        };
      }
      if (name === "resolve") {
        resolvePrompts.push(req.body.messages[1].content);
        const ids = [...String(req.body.messages[1].content).matchAll(/### 確認事項 (o\d+)/g)].map((m) => m[1]);
        const none = { label: "", kind: "caller", why: "", contract: "", mechanical: false, edits: [] };
        return {
          json: msg(JSON.stringify({ resolutions: ids.map((id) => ({ obligation: id, decisions: [{ site: 1, change: false, reason: "対応不要" }], step: none })) })),
        };
      }
      throw new Error(`想定外: ${name}`);
    });
    const inv = { query: "q", mode: "auto" as const, messages: [], evidence: { render: () => "", allText: () => "", paths: () => [] } as any, notes: "", steps: 0, needs: [], calls: new Map() };
    const planner = new ChangePlanner({ llm: client, ws, lsp, typeChecker: new TsTypeChecker(ts, root), config: { evidenceChars: 8000 } });
    const plan = await planner.plan(inv, { query: "q", understanding: "", criteria: ["c"], contracts: [], answers: [] });
    return { plan, resolvePrompts };
  };

  // 1) 呼び出し元を起点の計画で直している: 判断待ちにせず、LLM に聞かない
  const done = await run("  return login(u, p, 8);");
  assert.deepEqual(done.resolvePrompts, []);
  const caller = done.plan.obligations.find((o) => o.pattern === "caller-follow")!;
  assert.equal(caller.status, "done");
  assert.deepEqual(
    caller.verdicts.map((v) => [v.path, v.changed, v.auto, v.step]),
    [["src/app.ts", true, true, "s2"]],
  );

  // 2) 書き換えた結果、login を呼ばなくなった行: 今の内容で判断し直させる
  const rewritten = await run("  return true;");
  assert.equal(rewritten.resolvePrompts.length, 1);
  assert.match(rewritten.resolvePrompts[0]!, /src\/app\.ts:4\(handleSubmit の中\) — 計画内の別の変更で書き換わった行/);
  assert.match(rewritten.resolvePrompts[0]!, /L4\|\s+return true;/);
});

test("変更計画: 出力が途中で切れた・ステップが空でも、理由と今のコードを添えて作り直させて完成させる", async (t) => {
  const prompts: string[] = [];
  let calls = 0;
  const good = {
    id: "a1",
    dependsOn: [],
    requirements: [1],
    label: "最低文字数を厳しくする",
    kind: "core",
    why: "",
    contract: "外から見た約束は変わらない",
    mechanical: false,
    edits: [
      {
        path: "src/auth.ts",
        create: false,
        startLine: 2,
        endLine: 2,
        firstLine: '  return password.length > 3 && user !== "";',
        lastLine: '  return password.length > 3 && user !== "";',
        newCode: '  return password.length > 8 && user !== "";',
      },
    ],
  };
  const { ws, client } = await setup(t, (req) => {
    const name = req.body.response_format?.json_schema?.name;
    if (name !== "change_plan") {
      throw new Error(`想定外: ${name}`);
    }
    calls++;
    prompts.push(req.body.messages[req.body.messages.length - 1].content);
    if (calls === 1) {
      // 出力の上限で切れた JSON
      return { json: { choices: [{ message: { role: "assistant", content: '{"steps":[{"id":"a1","label":"最低' }, finish_reason: "length" }] } };
    }
    if (calls === 2) {
      return { json: msg(JSON.stringify({ steps: [] })) };
    }
    return { json: msg(JSON.stringify({ steps: [good] })) };
  });
  const inv = { query: "q", mode: "auto" as const, messages: [], evidence: { render: () => "", allText: () => "", paths: () => ["src/auth.ts"] } as any, notes: "", steps: 0, needs: [], calls: new Map() };
  const plan = await new ChangePlanner({ llm: client, ws, config: { evidenceChars: 8000 } }).plan(inv, { query: "q", understanding: "", criteria: ["c"], contracts: [], answers: [] });
  assert.equal(calls, 3);
  assert.match(prompts[1]!, /出力が長すぎて途中で切れた/);
  assert.match(prompts[1]!, /ステップは3つまで/);
  assert.match(prompts[2]!, /steps が空でした/);
  assert.equal(plan.steps.length, 1);
  assert.match(plan.files[0]!.final, /length > 8/);
});

test("変更計画: 行を写し間違えたら、そのファイル全体を見せて作り直させる。3回とも作れなければ理由つきで失敗する", async (t) => {
  const prompts: string[] = [];
  const wrong = {
    id: "a1",
    dependsOn: [],
    requirements: [1],
    label: "判定を変える",
    kind: "core",
    why: "",
    contract: "",
    mechanical: false,
    edits: [{ path: "src/auth.ts", create: false, startLine: 2, endLine: 2, firstLine: "  return isValid(password);", lastLine: "  return isValid(password);", newCode: "  return check(password);" }],
  };
  const { ws, client } = await setup(t, (req) => {
    prompts.push(req.body.messages[req.body.messages.length - 1].content);
    return { json: msg(JSON.stringify({ steps: [wrong] })) };
  });
  const inv = { query: "q", mode: "auto" as const, messages: [], evidence: { render: () => "", allText: () => "", paths: () => ["src/auth.ts"] } as any, notes: "", steps: 0, needs: [], calls: new Map() };
  const planner = new ChangePlanner({ llm: client, ws, config: { evidenceChars: 8000 } });
  await assert.rejects(planner.plan(inv, { query: "q", understanding: "", criteria: ["c"], contracts: [], answers: [] }), (error: unknown) => {
    assert.ok(error instanceof PlanError);
    assert.match(error.message, /要件を満たす変更計画を作れませんでした/);
    assert.match(error.message, /範囲を特定できません/, "なぜ作れなかったのかを示す");
    return true;
  });
  assert.equal(prompts.length, 3, "初回 + 作り直し2回");
  assert.match(prompts[1]!, /L1\| export function login/, "短いファイルは全体を見せる");
  assert.match(prompts[1]!, /L5\| export function logout/);
});

test("編集の適用: 絶対パス・先頭の / を受け付け、firstLine に変更後の行を写していても境界の行から範囲を見つける", async () => {
  const root = await makeTempDir();
  await writeFiles(root, { "src/auth.ts": AUTH });
  const vws = new VirtualWorkspace(new NodeWorkspace(root));
  const abs = await applyRawEdit(vws, {
    path: path.join(root, "src", "auth.ts"),
    create: false,
    startLine: 9, // 大きくずれている
    endLine: 11,
    // 変更後の行を写してしまった
    firstLine: "export function login(user: string, password: string, min: number): boolean {",
    lastLine: "}",
    newCode: [
      "export function login(user: string, password: string): boolean {",
      '  return password.length > 8 && user !== "";',
      "}",
    ].join("\n"),
  });
  assert.ok(abs.ok, abs.ok ? "" : abs.reason);
  assert.equal(abs.edit.path, "src/auth.ts");
  assert.equal(abs.edit.startLine, 1);
  assert.match(await vws.readText("src/auth.ts"), /length > 8/);
  const slash = await applyRawEdit(vws, {
    path: "/src/auth.ts",
    create: false,
    startLine: 6,
    endLine: 6,
    firstLine: '  console.log("bye", user);',
    lastLine: '  console.log("bye", user);',
    newCode: '  console.info("bye", user);',
  });
  assert.ok(slash.ok);
  assert.equal((await applyRawEdit(vws, { path: "C:/other/x.ts", create: true, startLine: 1, endLine: 1, firstLine: "", lastLine: "", newCode: "x" })).ok, false, "ワークスペースの外は拒否");
});

// ---------- 内容で探す編集(oldCode) ----------

const TWO = [
  "function a() {",
  "  if (x) {",
  "    run();",
  "  }",
  "  return 1;",
  "}",
  "",
  "function b() {",
  "  if (y) {",
  "    run();",
  "  }",
  "  return 2;",
  "}",
  "",
].join("\n");

/** 括弧の対応だけを見る簡易構文チェック */
const braces = {
  isValid: async (_p: string, text: string) => {
    let depth = 0;
    for (const c of text) {
      depth += c === "{" ? 1 : c === "}" ? -1 : 0;
      if (depth < 0) {
        return false;
      }
    }
    return depth === 0;
  },
  errorLine: async () => 3,
};

test("oldCode の照合: 厳しい比較から緩め、インデントのずれを合わせ、1か所に決まらなければ失敗し、見つからなければ最も近い箇所を返す", () => {
  const lines = TWO.split("\n");
  // 空白の違い・行末の空白・前後の空行は吸収する
  const loose = locateBlock(lines, ["", "function b(){  ", "  if (y) {"]);
  assert.ok(loose.ok);
  assert.deepEqual([loose.start, loose.end], [8, 9]);
  // インデントだけずれていれば、置き換え後のコードにも同じずれを付ける
  const shifted = locateBlock(lines, ["if (y) {", "  run();", "}"]);
  assert.ok(shifted.ok);
  assert.equal(shifted.start, 9);
  assert.deepEqual(shifted.reindent(["if (y && z) {", "  run();", "}"]), ["  if (y && z) {", "    run();", "  }"]);
  // 記号の違い(typographic な引用符)
  assert.ok(locateBlock(['const s = "hi";'], ["const s = “hi”;"]).ok);
  // 複数に一致: 行番号の手がかりが無い・あいまいなら失敗、ほぼ指定どおりなら選ぶ
  const amb = locateBlock(lines, ["    run();"]);
  assert.ok(!amb.ok && amb.kind === "ambiguous");
  assert.deepEqual(amb.ok ? [] : amb.kind === "ambiguous" ? amb.starts : [], [3, 10]);
  assert.equal(locateBlock(lines, ["    run();"], 6).ok, false, "どちらとも言えない行番号では選ばない");
  const hinted = locateBlock(lines, ["    run();"], 10);
  assert.ok(hinted.ok);
  assert.equal(hinted.start, 10);
  // 見つからない: 最も近い箇所と、最初に食い違う行
  const miss = locateBlock(lines, ["function b() {", "  if (z) {", "    run();"]);
  assert.ok(!miss.ok && miss.kind === "not-found");
  assert.equal(miss.ok || miss.kind !== "not-found" ? 0 : miss.closest?.start, 8);
  assert.deepEqual(miss.ok || miss.kind !== "not-found" ? undefined : miss.closest?.diff, { index: 2, expected: "  if (z) {", actual: "  if (y) {" });
});

test("編集の適用(ステップ単位): 構文は全部入れた後で確かめ、失敗したら何も書かず、既に反映済みの編集は飛ばす", async () => {
  const root = await makeTempDir();
  await writeFiles(root, { "src/two.ts": TWO });
  const vws = new VirtualWorkspace(new NodeWorkspace(root));
  // 開き括弧と閉じ括弧を別の編集に分けても、ステップ全体で正しければ入る(以前は1つ目で拒否されていた)
  const wrap = await applyEdits(
    vws,
    [
      { path: "src/two.ts", create: false, startLine: 9, oldCode: "function b() {\n  if (y) {", newCode: "function b() {\n  try {\n  if (y) {" },
      { path: "src/two.ts", create: false, startLine: 12, oldCode: "  return 2;\n}", newCode: "  } finally {}\n  return 2;\n}" },
    ],
    braces,
  );
  assert.ok(wrap.ok, wrap.ok ? "" : wrap.reason);
  assert.equal(wrap.edits.length, 2);
  assert.match(await vws.readText("src/two.ts"), /try \{\n {2}if \(y\)/);

  // 1か所に決まらない oldCode は、黙って別の場所を書き換えずに理由を返す
  const before = await vws.readText("src/two.ts");
  const amb = await applyEdits(vws, [{ path: "src/two.ts", create: false, startLine: 6, oldCode: "    run();", newCode: "    runB();" }], braces);
  assert.ok(!amb.ok);
  assert.match(amb.reason, /2か所\(3・11行目\)に一致/);
  assert.equal(await vws.readText("src/two.ts"), before);

  // 2つ目の編集が失敗したら、1つ目も入れない
  const partial = await applyEdits(vws, [
    { path: "src/two.ts", create: false, startLine: 5, oldCode: "  return 1;", newCode: "  return 10;" },
    { path: "src/two.ts", create: false, startLine: 1, oldCode: "function c() {", newCode: "function d() {" },
  ]);
  assert.ok(!partial.ok);
  assert.equal(await vws.readText("src/two.ts"), before);

  // 構文エラーは、ステップ全体で壊れるときだけ、行を添えて拒否する
  const broken = await applyEdits(vws, [{ path: "src/two.ts", create: false, startLine: 5, oldCode: "  return 1;\n}", newCode: "  return 1;" }], braces);
  assert.ok(!broken.ok);
  assert.match(broken.reason, /構文エラーになります\(3行目付近/);
  assert.equal(broken.line, 3);

  // 見つからなければ、最も近い箇所の今のコードを添える(作り直しで写し直せるように)
  const miss = await applyEdits(vws, [{ path: "src/two.ts", create: false, startLine: 1, oldCode: "function a() {\n  if (z) {", newCode: "function a() {\n  if (w) {" }]);
  assert.ok(!miss.ok);
  assert.match(miss.reason, /最も近いのは1〜2行目.*2行目「if \(z\) \{」は実際には「if \(x\) \{」/);
  assert.match(miss.reason, /L2\|\s+if \(x\) \{/);
  assert.equal(miss.line, 1);

  // 作り直しで、入れ済みの編集がもう一度返ってきた
  const again = await applyEdits(vws, [{ path: "src/two.ts", create: false, startLine: 9, oldCode: "function b() {\n  if (y) {", newCode: "function b() {\n  try {\n  if (y) {" }]);
  assert.ok(!again.ok && again.alreadyApplied);
});

test("編集の適用(以前の形式): lastLine が範囲の終わりに見つからなければ、推測した範囲で書き換えずに失敗する", async () => {
  const root = await makeTempDir();
  await writeFiles(root, { "src/two.ts": TWO });
  const vws = new VirtualWorkspace(new NodeWorkspace(root));
  const r = await applyRawEdit(vws, {
    path: "src/two.ts",
    create: false,
    startLine: 8,
    endLine: 10, // 正しくは 13
    firstLine: "function b() {",
    lastLine: "}  // 写し間違い",
    newCode: "function b() {\n  return 3;\n}",
  });
  assert.ok(!r.ok);
  assert.match(r.reason, /範囲の終わりを特定できません/);
  assert.equal(await vws.readText("src/two.ts"), TWO);
});

test("変更計画: oldCode を写し間違えたら、最も近い箇所を示して作り直させ、2回目で完成させる", async (t) => {
  const prompts: string[] = [];
  const step = (oldCode: string) => ({
    id: "a1",
    dependsOn: [],
    requirements: [1],
    label: "最低文字数を厳しくする",
    kind: "core",
    why: "",
    contract: "外から見た約束は変わらない",
    mechanical: false,
    edits: [{ path: "src/auth.ts", create: false, startLine: 2, oldCode, newCode: '  return password.length > 8 && user !== "";' }],
  });
  const { ws, client } = await setup(t, (req) => {
    prompts.push(req.body.messages[req.body.messages.length - 1].content);
    const oldCode = prompts.length === 1 ? "  return password.length > 3 && user != '';" : '  return password.length > 3 && user !== "";';
    return { json: msg(JSON.stringify({ steps: [step(oldCode)] })) };
  });
  const inv = { query: "q", mode: "auto" as const, messages: [], evidence: { render: () => "", allText: () => "", paths: () => ["src/auth.ts"] } as any, notes: "", steps: 0, needs: [], calls: new Map() };
  const plan = await new ChangePlanner({ llm: client, ws, config: { evidenceChars: 8000 } }).plan(inv, { query: "q", understanding: "", criteria: ["c"], contracts: [], answers: [] });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /oldCode がファイルに見つかりません。最も近いのは2〜2行目/);
  assert.match(prompts[1]!, /実際には「return password\.length > 3 && user !== "";」/);
  assert.equal(plan.steps.length, 1);
  assert.deepEqual(plan.warnings.filter((w) => w.startsWith("適用できなかった")), []);
  assert.match(plan.files[0]!.final, /length > 8/);
});

test("手順: 目標の文章に答えが出ていれば、書き直し(直らなければ伏せ字)の結果を画面に出す", async () => {
  const fileBefore = "export function check(v: number): boolean {\n  return v > 0;\n}\n";
  const step: PlanStep = {
    id: "s1",
    number: 1,
    label: "境界を含める",
    kind: "core",
    why: "",
    contract: "",
    mechanical: false,
    requirements: [1],
    dependsOn: [],
    edits: [{ path: "src/a.ts", created: false, startLine: 2, endLine: 2, before: "  return v > 0;", after: "  return v >= 0;", fileBefore }],
    obligations: [],
  };
  const plan: ChangePlan = {
    // 要件の理解に、空欄の答えのコードがそのまま書かれている
    spec: { query: "0 も受け付けたい", understanding: "check は v >= 0 のときに true を返す", criteria: ["0 のとき true になる"], contracts: [], answers: [] },
    steps: [step],
    obligations: [],
    files: [{ path: "src/a.ts", original: fileBefore, final: fileBefore.replace("v > 0", "v >= 0") }],
    typecheck: { available: false, remaining: [] },
    warnings: [],
  };
  const llm: ChatLlm = {
    chat: async (req) => {
      const name = req.jsonSchema?.name;
      if (name === "step_quiz") {
        return {
          content: JSON.stringify({
            items: [{ step: "s1", edit: 0, task: "0 も通す", explanation: "", newNames: [], refs: [], blanks: [blankOf(1, "v >= 0")] }],
          }),
          toolCalls: [],
        };
      }
      // 書き直しは返さない(伏せ字で塞ぐ)
      return { content: JSON.stringify({ fixes: [] }), toolCalls: [] };
    },
  };
  const ws: WorkspacePort = { id: "w", listFiles: async () => [], stat: async () => undefined, readText: async () => fileBefore };
  const evidence = { render: () => "", allText: () => fileBefore, paths: () => ["src/a.ts"] };
  const lesson = await buildLesson(plan, { llm, ws, level: "intermediate", evidence, evidenceChars: 8000 });
  assert.equal(lesson.steps[0]!.item?.blanks[0]?.answer, "v >= 0");
  assert.ok(!lesson.goal.includes("v >= 0"), `目標に答えが残っている: ${lesson.goal}`);
});
