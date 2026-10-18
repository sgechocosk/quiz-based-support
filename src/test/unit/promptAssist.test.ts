import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { IndexManager } from "../../core/indexer";
import { OpenAiClient, type ApiRequestInfo } from "../../core/llm";
import type { ChatRequest, ChatResult, KeyValueStore } from "../../core/ports";
import {
  addedNameRefs,
  AUTO_CALLS_PER_MINUTE,
  codeNames,
  contextNames,
  missingParts,
  nameExists,
  parseRefine,
  PromptAssistant,
  rejectCompletion,
  stripEcho,
  type NameSource,
} from "../../core/promptAssist";
import { FakeEmbedder, makeTempDir, NodeWorkspace, writeFiles } from "./helpers/nodeWorkspace";
import { TsCompilerParser } from "./helpers/tsAst";

/** 索引の代わり: words にある単語・paths にあるパスだけが実在する */
function fakeNames(words: string[], paths: string[] = [], repoMap?: string): NameSource {
  const lower = new Set(words.map((w) => w.toLowerCase()));
  return {
    hasChunks: () => true,
    lexicalSearch: () => [],
    knowsWord: (w, exact = true) => (exact ? words.includes(w) : lower.has(w.toLowerCase())),
    hasPath: (p) => paths.some((f) => f === p || f.endsWith(`/${p}`)),
    completeName: (prefix) => {
      const names = words.filter((w) => w.toLowerCase().startsWith(prefix.toLowerCase()) && w !== prefix);
      return { names: names.slice(0, 5), total: names.length };
    },
    repoMap: () => repoMap ?? "src/core/indexer.ts — IndexManager, commit, prepare\nmedia/main.js — onLessonTest, handleAsk",
    definitionOf: (n) => (words.includes(n) ? { path: "src/x.ts", line: 1 } : undefined),
  };
}

const NAMES = fakeNames(["IndexManager", "commit", "prepare", "handleAsk", "onLessonTest"], ["src/core/indexer.ts", "media/main.js"]);

function memoryStore(): KeyValueStore {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: async (key, value) => {
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
}

/** 偽の LLM: reply が返す内容を JSON にして返す。リクエストは requests に残る */
function fakeLlm(reply: (req: ChatRequest, n: number) => unknown | Promise<unknown>) {
  const requests: ChatRequest[] = [];
  return {
    requests,
    llm: {
      chat: async (req: ChatRequest): Promise<ChatResult> => {
        requests.push(req);
        const out = await reply(req, requests.length);
        return { content: typeof out === "string" ? out : JSON.stringify(out), toolCalls: [] };
      },
    },
  };
}

function assistant(reply: (req: ChatRequest, n: number) => unknown | Promise<unknown>, names: NameSource = NAMES, now = () => 0) {
  const f = fakeLlm(reply);
  const store = memoryStore();
  return { ...f, store, a: new PromptAssistant({ llm: f.llm, index: () => names, store, workspaceId: "/ws", now }) };
}

// ---------- 整形と規則 ----------

test("書きかけの繰り返し: 全体・後半の繰り返しは除き、偶然の短い重なりは残す", () => {
  assert.equal(stripEcho("索引の更新", "索引の更新は、どう流れる?"), "は、どう流れる?");
  assert.equal(stripEcho("ログイン処理を読みたい。特に失敗時", "特に失敗時の流れ"), "の流れ");
  assert.equal(stripEcho("テストのテスト", "テストを足したい"), "テストを足したい");
  assert.equal(stripEcho("索引の更新", "  は?"), "は?");
  assert.equal(stripEcho("add ", " a logout button"), "a logout button");
});

test("続きの候補を捨てる規則: メタ文・口調・評価・複数の文・書式・決めること", () => {
  const r = (c: string, mode: "auto" | "read" | "change" = "auto", draft = "索引の更新") => rejectCompletion(draft, c, mode, NAMES);
  assert.equal(r(""), "empty");
  assert.equal(r("(なし)"), "meta");
  assert.equal(r("提案はありません"), "meta");
  assert.equal(r("承知しました、索引を見ます"), "assistant_voice");
  assert.equal(r("を確認しますね"), "assistant_voice");
  assert.equal(r("ありがとうございます"), "evaluative");
  assert.equal(r("はどう動く?あと保存も"), "multiple_sentences");
  assert.equal(r("は\nどう動く?"), "multiline");
  assert.equal(r("- 一覧"), "formatting");
  assert.equal(r("を〔決めること〕にしたい"), "placeholder");
  assert.equal(r("x".repeat(81)), "too_long");
});

test("続きの候補を捨てる規則: 進め方との食い違い・索引に無い名前。読み解きの問いは出してよい", () => {
  assert.equal(rejectCompletion("索引の更新", "は、`IndexManager.commit` までどう流れる?", "read", NAMES), undefined);
  assert.equal(rejectCompletion("索引の更新", "は、`IndexManager.flushAll` までどう流れる?", "auto", NAMES), "unknown_name");
  assert.equal(rejectCompletion("索引の更新", "に進み具合の表示を追加したい", "read", NAMES), "intent_flip");
  assert.equal(rejectCompletion("索引の更新", "の流れを知りたい", "read", NAMES), undefined);
  // 自動で判断でも、書きかけが示す種類は変えない
  assert.equal(rejectCompletion("索引の更新はどう", "変えればよいか知りたいので `commit` を直したい", "auto", NAMES), "intent_flip");
  assert.equal(rejectCompletion("ログアウトを追加したい", "。あわせてログインも直したい", "auto", NAMES), "multiple_sentences");
  assert.equal(rejectCompletion("ログアウトボタンを", "追加して、あわせて設定も直したい", "auto", NAMES), "extra_request");
  assert.equal(rejectCompletion("保存ボタンを押", "したら確認を出したい", "auto", NAMES), "new_condition");
  assert.equal(rejectCompletion("パスワードを間違えたらロック", "を5回目から有効にしたい", "auto", NAMES), "new_number");
  assert.equal(rejectCompletion("保存したら", "「保存しました」と表示したい", "auto", NAMES), "new_quote");
  assert.equal(rejectCompletion("保存したら「保存しました」", "と表示したい", "auto", NAMES), undefined);
  assert.equal(rejectCompletion("`utf8` の", "読み込みはどう動く?", "auto", fakeNames(["utf8"])), undefined);
  assert.equal(rejectCompletion("索引の更新処理を", "直すにはどうする?", "change", NAMES), "question_in_change");
  // 利用者が書いた名前は確かめない
  assert.equal(rejectCompletion("fooBarBaz の", "処理はどう動く?", "auto", NAMES), undefined);
});

test("名前は文脈(構成の地図・手がかり・書きかけ)にあるものだけ認め、LLM が書いた名前は大文字小文字まで確かめる", () => {
  const ctx = contextNames("src/core/indexer.ts — IndexManager, commit", "- media/main.js:1-9(function onLessonTest)", "索引の更新");
  assert.ok(ctx.has("IndexManager") && ctx.has("indexer.ts") && ctx.has("src/core/indexer.ts") && ctx.has("main.js"));
  assert.ok(nameExists("IndexManager.commit", NAMES, "", ctx));
  assert.ok(!nameExists("handleAsk", NAMES, "", ctx), "索引にはあるが文脈に無い");
  assert.ok(!nameExists("indexManager", NAMES, "", ctx), "大文字小文字が違う");
  assert.ok(nameExists("media/main.js", NAMES, "", ctx));
  assert.equal(rejectCompletion("索引の更新", "は `handleAsk` からどう呼ばれる?", "auto", NAMES, ctx), "unknown_name");
});

test("コードの名前: バッククォート・camelCase・パスを拾い、製品名や利用者の書いた名前は確かめない", () => {
  assert.deepEqual(codeNames("`IndexManager.commit` と handleAsk と media/main.js と OpenAI"), ["IndexManager.commit", "handleAsk", "media/main.js", "OpenAI"]);
  assert.ok(nameExists("IndexManager.commit", NAMES));
  assert.ok(!nameExists("IndexManager.flushAll", NAMES));
  assert.ok(nameExists("main.js", NAMES));
  assert.ok(!nameExists("src/none.ts", NAMES));
  assert.ok(nameExists("OpenAI", NAMES));
  assert.ok(nameExists("handleLogin()", NAMES, "handleLogin() を読みたい"));
});

test("伝わりやすさの要素: 利用者にしか決められないことだけ(変更はどうなってほしいか、読み解きは知りたいこと)。場所は求めない", () => {
  assert.deepEqual(missingParts("ログインを直したい", "auto"), ["どうなってほしいか"]);
  assert.deepEqual(missingParts("ログインで失敗した行を表示したい", "auto"), []);
  assert.deepEqual(missingParts("索引の更新", "read"), ["知りたいこと(流れ・呼び出し元・データなど)"]);
  assert.deepEqual(missingParts("索引の更新はどう動く?", "auto"), []);
});

test("書き直しで補った名前に、定義の場所を添える(書きかけにあった名前・製品名は除く)", () => {
  const defs: Record<string, { path: string; line: number }> = {
    onLessonTest: { path: "media/main.js", line: 1380 },
    commit: { path: "src/core/indexer.ts", line: 320 },
    "package.json": { path: "package.json", line: 1 },
  };
  const refs = addedNameRefs("`onLessonTest` と `IndexManager.commit` と `package.json` と `handleAsk` と OpenAI と `noSuch`", "handleAsk を", { definitionOf: (n) => defs[n] });
  assert.deepEqual(refs, [
    { name: "onLessonTest", path: "media/main.js", line: 1380 },
    { name: "IndexManager.commit", path: "src/core/indexer.ts", line: 320 },
    { name: "package.json", path: "package.json", line: 1 },
  ]);
});

test("書き直し案の確認: 案に無い要素・〔〕の無い問い・同じ選択肢を捨て、無い名前・書きかけに無い数値・進め方の食い違いは直させる", () => {
  const { proposal, problems } = parseRefine(
    {
      instruction: "`onLessonTest` で、テストが失敗したときに〔表示する内容〕も出すようにしたい。",
      intent: "change",
      parts: [
        { kind: "location", text: "`onLessonTest` で" },
        { kind: "condition", text: "テストが失敗したときに" },
        { kind: "scope", text: "成功したときは変えない" },
        { kind: "bogus", text: "x" },
      ],
      questions: [
        {
          slot: "〔表示する内容〕",
          question: "何を表示しますか?",
          options: [
            { label: "終了コード", fill: "終了コード" },
            { label: "失敗したテスト名", fill: "失敗したテスト名" },
            { label: "同じ", fill: "失敗したテスト名" },
            { label: "", fill: "x" },
          ],
        },
        { slot: "〔無い〕", question: "?", options: [{ label: "a", fill: "a" }, { label: "b", fill: "b" }] },
      ],
    },
    "テストの表示を直したい",
    "auto",
    NAMES,
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(proposal!.parts.map((p) => p.kind), ["location", "condition"]);
  assert.equal(proposal!.questions.length, 1);
  assert.deepEqual(proposal!.questions[0]!.options.map((o) => o.label), ["終了コード", "失敗したテスト名"]);

  const bad = parseRefine({ instruction: "`handleLogout` を足したい", intent: "change", parts: [], questions: [] }, "ログアウト", "read", NAMES);
  assert.deepEqual(bad.proposal!.unknownNames, ["handleLogout"]);
  assert.equal(bad.problems.length, 2);
  assert.deepEqual(parseRefine({ instruction: " " }, "x", "auto", NAMES).problems, ["instruction が空です。"]);
  assert.match(parseRefine({ instruction: "5回失敗したらロックしたい", intent: "change" }, "ログインをロックしたい", "auto", NAMES).problems[0]!, /数値/);
});

// ---------- 続きの候補(本体) ----------

test("続きの候補: 指示 → 構成と最近の依頼 → 書きかけ の順で送り、自動の系統・推論なし・キャッシュキーを付ける", async () => {
  const { a, requests } = assistant(() => ({ completion: "は、`IndexManager.commit` までどう流れる?", intent: "read" }));
  const out = await a.complete("索引の更新", "auto");
  assert.equal(out.completion, "は、`IndexManager.commit` までどう流れる?");
  const req = requests[0]!;
  assert.equal(req.channel, "assist-auto");
  assert.equal(req.reasoningEffort, "none");
  assert.match(req.cacheKey ?? "", /^qbs-assist-[0-9a-f]{12}$/);
  assert.equal(req.jsonSchema?.name, "prompt_completion");
  assert.deepEqual(req.messages.map((m) => m.role), ["system", "user", "user"]);
  assert.match(req.messages[1]!.content!, /IndexManager, commit/);
  assert.match(req.messages[2]!.content!, /<<<索引の更新>>>/);
  // 同じ書きかけは覚えている(API を呼ばない)
  await a.complete("索引の更新", "auto");
  assert.equal(requests.length, 1);
});

test("続きの候補: 短い・秘密らしい書きかけは送らず、捨てた候補は理由と足りない要素を返す", async () => {
  const { a, requests } = assistant(() => ({ completion: "承知しました", intent: "none" }));
  assert.equal((await a.complete("ログ", "auto")).reason, "short");
  assert.equal((await a.complete("キーは sk-abcdefghijklmnopqrstu です", "auto")).reason, "secret");
  assert.equal(requests.length, 0);
  const out = await a.complete("ログインを直したい", "auto");
  assert.equal(out.completion, "");
  assert.equal(out.reason, "assistant_voice");
  assert.deepEqual(out.missing, ["どうなってほしいか"]);
  assert.equal(a.stats().suppressed.assistant_voice, 1);
});

test("続きの候補: 失敗しても例外を投げず、1分間の上限を超えたら呼ばない", async () => {
  const failing = assistant(() => {
    throw new Error("400 response_format is not supported");
  });
  const out = await failing.a.complete("索引の更新はどう", "auto");
  assert.equal(out.reason, "error");

  let t = 0;
  const { a, requests } = assistant(() => ({ completion: "", intent: "none" }), NAMES, () => t);
  for (let i = 0; i < AUTO_CALLS_PER_MINUTE; i++) {
    await a.complete(`索引の更新 ${i} 回目`, "auto");
  }
  assert.equal((await a.complete("索引の更新 上限を超えた", "auto")).reason, "rate");
  assert.equal(requests.length, AUTO_CALLS_PER_MINUTE);
  t = 61_000;
  await a.complete("索引の更新 1分後", "auto");
  assert.equal(requests.length, AUTO_CALLS_PER_MINUTE + 1);
});

test("続きの候補: 新しい書きかけが来たら前の要求を中止する", async () => {
  const { a } = assistant(
    (req, n) =>
      n === 1
        ? new Promise((_, reject) => req.signal!.addEventListener("abort", () => reject(new Error("中止しました。"))))
        : { completion: "はどう動く?", intent: "read" },
  );
  const first = a.complete("IndexManager の", "auto");
  const second = await a.complete("IndexManager の prepare", "auto");
  assert.equal((await first).reason, "aborted");
  assert.equal(second.completion, "はどう動く?");
});

// ---------- 書き直し案 ----------

test("書き直し案: 名前の誤りは1回だけ作り直させ、残ったら見つからない名前として返す", async () => {
  const good = {
    instruction: "`onLessonTest` で、テストが失敗したときに〔表示する内容〕も出すようにしたい。",
    intent: "change",
    parts: [{ kind: "location", text: "`onLessonTest` で" }],
    questions: [],
  };
  const fixed = assistant((_req, n) => (n === 1 ? { ...good, instruction: "`renderTestFailure` で表示したい。" } : good));
  const p = await fixed.a.refine("テストの表示を直したい", "auto");
  assert.equal(p.instruction, good.instruction);
  assert.equal(fixed.requests.length, 2);
  assert.equal(fixed.requests[0]!.channel, "assist");
  assert.match(fixed.requests[1]!.messages.at(-1)!.content!, /renderTestFailure/);

  const stubborn = assistant(() => ({ ...good, instruction: "`renderTestFailure` で表示したい。" }));
  const q = await stubborn.a.refine("テストの表示を直したい", "auto");
  assert.deepEqual(q.unknownNames, ["renderTestFailure"]);
  assert.equal(stubborn.requests.length, 2);

  const broken = assistant(() => "not json");
  await assert.rejects(broken.a.refine("テストの表示を直したい", "auto"), /整えられませんでした/);
});

// ---------- 記録と間隔 ----------

test("候補が表示されたのに使わない依頼が続いたら間隔を延ばし、使えば戻す。結果は補助の有無で分けて数える", async () => {
  const { a } = assistant(() => ({ completion: "", intent: "none" }));
  const normal = a.delayMs();
  for (let i = 0; i < 9; i++) {
    a.recordSend(`依頼 ${i}`, { shown: 1, accepted: 0, refined: false });
  }
  a.recordSend("表示なし", { shown: 0, accepted: 0, refined: false });
  assert.equal(a.delayMs(), normal, "表示が無かった依頼は数えない");
  a.recordSend("依頼 9", { shown: 2, accepted: 0, refined: false });
  assert.ok(a.delayMs() > normal);
  a.recordSend("使った", { shown: 1, accepted: 1, refined: false });
  assert.equal(a.delayMs(), normal);

  a.recordResult("使った", { steps: 4 });
  a.recordResult("使った", { clarified: true });
  a.recordResult("別の依頼", { steps: 100 });
  a.recordSend("使わない", { shown: 0, accepted: 0, refined: false });
  a.recordResult("使わない", { steps: 9, clarified: true });
  const s = a.stats();
  assert.equal(s.sends, 13);
  assert.equal(s.assistedSends, 1);
  assert.deepEqual([s.investigatedAssisted, s.stepsAssisted, s.clarifiedAssisted], [1, 4, 1]);
  assert.deepEqual([s.investigatedUnassisted, s.stepsUnassisted, s.clarifiedUnassisted], [1, 9, 1]);
});

// ---------- API クライアント ----------

test("API: 呼び出しごとの推論強度を送り、拒まれたら設定どおりに戻して覚える。キャッシュキーは公式エンドポイントにだけ送る", async () => {
  const bodies: any[] = [];
  const infos: ApiRequestInfo[] = [];
  let base = "https://api.openai.com/v1";
  const fetchImpl = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.reasoning_effort === "none") {
      return new Response(JSON.stringify({ error: { message: "Unsupported value: 'reasoning_effort' does not support 'none'" } }), { status: 400 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "{}" } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  let effort = "auto";
  const c = new OpenAiClient({
    apiKey: async () => "k",
    baseUrl: () => base,
    model: () => "m",
    embeddingModel: () => "e",
    reasoningEffort: () => effort,
    fetchImpl,
    sleep: async () => {},
    beforeRequest: async (info) => {
      infos.push(info);
    },
  });
  const req: ChatRequest = { messages: [{ role: "user", content: "x" }], reasoningEffort: "none", cacheKey: "qbs", channel: "assist-auto" };
  await c.chat(req);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].reasoning_effort, "none");
  assert.equal(bodies[1].reasoning_effort, undefined);
  assert.equal(bodies[0].prompt_cache_key, "qbs");
  assert.equal(infos[0]!.channel, "assist-auto");
  await c.chat(req);
  assert.equal(bodies.length, 3, "拒まれたモデルには最初から送らない");
  assert.equal(bodies[2].reasoning_effort, undefined);

  base = "http://localhost:11434/v1";
  effort = "default";
  bodies.length = 0;
  const c2 = new OpenAiClient({ apiKey: async () => "k", baseUrl: () => base, model: () => "m2", embeddingModel: () => "e", reasoningEffort: () => effort, fetchImpl, sleep: async () => {} });
  await c2.chat({ ...req, reasoningEffort: "low" });
  assert.equal(bodies[0].reasoning_effort, undefined, "設定が default なら送らない");
  assert.equal(bodies[0].prompt_cache_key, undefined, "互換エンドポイントには送らない");
  await c2.chat({ messages: [{ role: "user", content: "x" }] });
  assert.equal(infos.at(-1)!.channel, "assist-auto");
});

// ---------- 索引 ----------

test("索引: 名前の前方一致(大文字小文字の一致・出てくる数の順)、単語とパスの実在、埋め込みを使わない検索", async () => {
  const root = await makeTempDir();
  await writeFiles(root, {
    "src/auth.ts": `export function loginUser(name: string): boolean {\n  return name !== "";\n}\n\nexport function logoutUser(): void {\n  loginUser("x");\n  loginUser("y");\n}\n`,
    "src/log.ts": `export function LoginBanner(): string {\n  return "hi";\n}\n`,
    "package.json": `{"name": "x"}\n`,
    "docs/README.md": "# README\nloginUser の説明\n",
  });
  const ws = new NodeWorkspace(root);
  const embedder = new FakeEmbedder();
  const mgr = new IndexManager({
    dir: path.join(root, ".idx"),
    workspace: ws,
    parser: new TsCompilerParser(),
    embedder: () => embedder,
    embeddingModel: () => "fake",
  });
  await mgr.load();
  await mgr.commit(await mgr.prepare(), { embed: true });
  const calls = embedder.calls;

  const r = mgr.completeName("log");
  assert.deepEqual(r.names.slice(0, 3), ["loginUser", "logoutUser", "log.ts"]);
  assert.ok(r.names.includes("LoginBanner"));
  assert.deepEqual(mgr.completeName("src/a").names, ["src/auth.ts"]);
  assert.equal(mgr.completeName("loginUser").names.includes("loginUser"), false);
  assert.ok(mgr.knowsWord("loginUser"));
  assert.ok(!mgr.knowsWord("LOGINUSER"), "既定は大文字小文字まで一致");
  assert.ok(mgr.knowsWord("LOGINUSER", false));
  assert.ok(!mgr.knowsWord("signupUser", false));
  assert.ok(!mgr.knowsWord("README"), "文書にしか出てこない語は認めない");
  assert.ok(mgr.hasPath("src/auth.ts") && mgr.hasPath("auth.ts") && mgr.hasPath("./src/log.ts"));
  assert.ok(mgr.hasPath("package.json"), "索引に入れない .json もパスとして認める");
  assert.ok(!mgr.hasPath("src/none.ts"));
  assert.equal(mgr.lexicalSearch("logout", 2)[0]!.chunk.file, "src/auth.ts");
  assert.equal(embedder.calls, calls, "埋め込みを呼ばない");
});

test("続きの候補の歯止め: 設定の誤りで止め、混み合いは時間を置き、遅ければ止める。長い・秘密らしい書きかけと索引が無いときは呼ばない", async () => {
  let t = 0;
  let status: number | undefined = 401;
  let delay = 0;
  const { a, requests } = assistant(
    async () => {
      t += delay;
      if (status !== undefined) {
        throw Object.assign(new Error("API エラー"), { status });
      }
      return { completion: "はどう動く?", intent: "read" };
    },
    NAMES,
    () => t,
  );
  assert.equal((await a.complete("IndexManager の流れ", "auto")).reason, "error");
  assert.equal(a.autoBlock(), "config");
  assert.equal((await a.complete("IndexManager の流れ 2", "auto")).reason, "config");
  assert.equal(requests.length, 1, "設定の誤りでは呼び続けない");
  a.resetPause();
  status = 429;
  await a.complete("IndexManager の流れ 3", "auto");
  assert.equal(a.autoBlock(), undefined);
  assert.equal((await a.complete("IndexManager の流れ 4", "auto")).reason, "paused");
  t += 61_000;
  status = undefined;
  delay = 3000;
  for (let i = 0; i < 3; i++) {
    await a.complete(`IndexManager の流れ 遅い ${i}`, "auto");
  }
  assert.equal(a.autoBlock(), "slow");
  a.resetPause();
  const n = requests.length;
  assert.equal((await a.complete("x".repeat(401), "auto")).reason, "long");
  assert.equal((await a.complete("1行目\n2行目\n3行目\n4行目", "auto")).reason, "long");
  assert.equal((await a.complete("Authorization: Bearer abcdefghijklmnopqrstuvwxyz", "auto")).reason, "secret");
  assert.equal((await a.complete("接続先 https://user:pass@example.com を", "auto")).reason, "secret");
  assert.equal(requests.length, n);

  const noIndex = new PromptAssistant({ llm: fakeLlm(() => ({})).llm, index: () => undefined, store: memoryStore(), workspaceId: "/ws" });
  assert.equal((await noIndex.complete("IndexManager の流れ", "auto")).reason, "no_index");
});

test("使われない状態が続いても止めずに(利用者が決めること)、オフにできると知らせる。秘密らしい依頼は最近の依頼に残さない", async () => {
  const { a, store } = assistant(() => ({ completion: "", intent: "none" }));
  for (let i = 0; i < 30; i++) {
    a.recordSend(`依頼 ${i}`, { shown: 1, accepted: 0, refined: false });
  }
  assert.equal(a.autoBlock(), undefined);
  assert.ok(a.rarelyUsed());
  a.resetPause(true);
  assert.ok(!a.rarelyUsed(), "スイッチを入れ直すと数え直す");
  a.recordSend("トークンは token=abcdef123456 です", { shown: 0, accepted: 0, refined: false });
  assert.ok(!JSON.stringify(store.get("promptAssist.v1")).includes("abcdef123456"));
});
