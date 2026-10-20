import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { IndexManager } from "../../core/indexer";
import { OpenAiClient } from "../../core/llm";
import type { ChatRequest, ChatResult } from "../../core/ports";
import {
  CALLS_PER_MINUTE,
  codeNames,
  looksSecret,
  PromptAssistant,
  rejectCompletion,
  stripEcho,
  unknownNames,
  type NameSource,
} from "../../core/promptAssist";
import { startFakeOpenAi } from "./helpers/fakeOpenAi";
import { FakeEmbedder, makeTempDir, NodeWorkspace, writeFiles } from "./helpers/nodeWorkspace";
import { TsCompilerParser } from "./helpers/tsAst";

/** 索引の代わり: words にある識別子だけがコードに実在する */
function fakeIndex(words: string[]): NameSource {
  return {
    hasChunks: () => true,
    lexicalSearch: () => [],
    knowsWord: (w, exact = true) => (exact ? words.includes(w) : words.some((x) => x.toLowerCase() === w.toLowerCase())),
    repoMap: () => "src/core/indexer.ts — IndexManager, commit, prepare",
  };
}

const NAMES = fakeIndex(["IndexManager", "commit", "prepare", "handleAsk"]);

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

function assistant(reply: (req: ChatRequest, n: number) => unknown | Promise<unknown>, index: NameSource | undefined = NAMES, now = () => 0) {
  const f = fakeLlm(reply);
  const log: string[] = [];
  return { ...f, log, a: new PromptAssistant({ llm: f.llm, index: () => index, workspaceId: "/ws", log: (l) => log.push(l), now }) };
}

// ---------- 整形と規則 ----------

test("書きかけの繰り返しを除く: 全体・末尾の繰り返しは除き、語の途中や偶然の短い重なりは残す", () => {
  assert.equal(stripEcho("索引の更新", "索引の更新は、どう流れる?"), "は、どう流れる?");
  assert.equal(stripEcho("ログイン処理を読みたい。特に失敗時", "特に失敗時の流れ"), "の流れ");
  assert.equal(stripEcho("テストのテスト", "テストを足したい"), "テストを足したい");
  assert.equal(stripEcho("Add a dark mode toggle to the", " theme settings panel"), " theme settings panel");
  assert.equal(stripEcho("索引の更新", "  は?"), "は?");
});

test("続きの候補として自然なものは出し、メタ文・口調・複数の文・書式・長すぎるものは出さない", () => {
  const ok = (draft: string, c: string) => rejectCompletion(draft, stripEcho(draft, c), NAMES);
  assert.equal(ok("索引の更新", "は、ファイルを保存してから `IndexManager.commit` までどう流れる?"), undefined);
  assert.equal(ok("ログアウト機能を", "追加したい"), undefined);
  assert.equal(ok("テストモードのとき", "自動の候補を出さないようにしたい"), undefined);
  assert.equal(ok("`handleAsk` がどこから", "呼ばれているか知りたい"), undefined);
  assert.equal(ok("索引の更新", ""), "empty");
  assert.equal(ok("索引の更新", "(なし)"), "meta");
  assert.equal(ok("索引の更新", "承知しました、見てみます"), "voice");
  assert.equal(ok("索引の更新", "はどう動く?あと保存も"), "sentences");
  assert.equal(ok("索引の更新", "は\nどう動く?"), "multiline");
  assert.equal(ok("索引の更新", "- 一覧"), "formatting");
  assert.equal(ok("索引の更新", "を〔決めること〕にしたい"), "formatting");
  assert.equal(ok("索引の更新", "x".repeat(81)), "too_long");
});

test("コードの名前は索引にあるものだけ。書きかけにある名前・製品名・パスは確かめない", () => {
  assert.deepEqual(codeNames("`IndexManager.commit` と handleAsk と media/main.js と OpenAI"), ["IndexManager.commit", "handleAsk", "OpenAI"]);
  assert.deepEqual(unknownNames("`IndexManager.flushAll` と `handleLogout` を見る", NAMES), ["IndexManager.flushAll", "handleLogout"]);
  assert.deepEqual(unknownNames("`fooBarBaz` の処理", NAMES, "fooBarBaz の"), []);
  assert.deepEqual(unknownNames("OpenAI の呼び出し", NAMES), []);
  assert.equal(rejectCompletion("索引の更新", "は `IndexManager.flushAll` からどう呼ばれる?", NAMES), "unknown_name");
});

test("秘密らしい文字列(API キー・環境変数の形・Bearer・URL のパスワード)は送らない", () => {
  for (const t of ["sk-abcdefghijklmnopqrstu", "OPENAI_API_KEY=abcdef123456", "DB_PASSWORD: hunter2hunter2", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz", "https://user:pass@example.com"]) {
    assert.ok(looksSecret(t), t);
  }
  assert.ok(!looksSecret("ログイン処理の流れを知りたい"));
});

// ---------- 続きの候補(本体) ----------

test("続きの候補: 指示 → 構成 → 書きかけ の順で送り、推論なし・出力の上限・キャッシュキーを付け、同じ書きかけは使い回す", async () => {
  const { a, requests, log } = assistant(() => ({ completion: "は、`IndexManager.commit` までどう流れる?" }));
  const out = await a.complete("索引の更新", "auto");
  assert.equal(out.completion, "は、`IndexManager.commit` までどう流れる?");
  const req = requests[0]!;
  assert.equal(req.channel, "assist-auto");
  assert.equal(req.reasoningEffort, "none");
  assert.equal(req.maxOutputTokens, 200);
  assert.equal(req.retries, 0);
  assert.match(req.cacheKey ?? "", /^qbs-assist-[0-9a-f]{12}$/);
  assert.deepEqual(req.messages.map((m) => m.role), ["system", "user", "user"]);
  assert.match(req.messages[1]!.content!, /IndexManager, commit/);
  assert.match(req.messages[2]!.content!, /<<<索引の更新>>>/);
  await a.complete("索引の更新", "auto");
  assert.equal(requests.length, 1);
  assert.match(log[0]!, /^表示 書きかけ 5文字 → /);
});

test("続きの候補: 索引がまだ無くても出す(名前は確かめない)。短い・長い・秘密らしい書きかけは送らない", async () => {
  const { a, requests } = assistant(() => ({ completion: "はどう動く?" }), undefined);
  assert.equal((await a.complete("fooBar の流れ", "auto")).completion, "はどう動く?");
  assert.equal((await a.complete("ログ", "auto")).reason, "short");
  assert.equal((await a.complete("x".repeat(401), "auto")).reason, "long");
  assert.equal((await a.complete("1行目\n2行目\n3行目\n4行目", "auto")).reason, "long");
  assert.equal((await a.complete("キーは sk-abcdefghijklmnopqrstu です", "auto")).reason, "secret");
  assert.equal(requests.length, 1);
});

test("続きの候補: 捨てた理由と候補を記録に残す", async () => {
  const { a, log } = assistant(() => ({ completion: "承知しました" }));
  const out = await a.complete("ログインを直したい", "auto");
  assert.deepEqual(out, { completion: "", reason: "voice" });
  assert.match(log[0]!, /出さない\(voice\).*候補「承知しました」/);
});

test("続きの候補: 失敗しても例外を投げず、理由を記録して休む(1分・2分・5分)。成功すれば戻り、設定を変えても戻る", async () => {
  let t = 0;
  let fail = true;
  const { a, requests, log } = assistant(
    () => {
      if (fail) {
        throw new Error("API エラー(400): Unrecognized request argument");
      }
      return { completion: "はどう動く?" };
    },
    NAMES,
    () => t,
  );
  assert.equal((await a.complete("IndexManager の流れ 1", "auto")).reason, "error");
  assert.match(log[0]!, /API エラー\(400\).*60秒休みます/);
  assert.equal((await a.complete("IndexManager の流れ 2", "auto")).reason, "paused");
  assert.equal(requests.length, 1);
  t = 61_000;
  assert.equal((await a.complete("IndexManager の流れ 3", "auto")).reason, "error");
  assert.match(log.at(-1)!, /120秒休みます/);
  a.resetPause();
  fail = false;
  assert.equal((await a.complete("IndexManager の流れ 4", "auto")).completion, "はどう動く?");
});

test("続きの候補: 1分間の上限を超えたら呼ばない。新しい書きかけが来たら前の要求を中止する", async () => {
  let t = 0;
  const { a, requests } = assistant(() => ({ completion: "" }), NAMES, () => t);
  for (let i = 0; i < CALLS_PER_MINUTE; i++) {
    await a.complete(`索引の更新 ${i} 回目`, "auto");
  }
  assert.equal((await a.complete("索引の更新 上限を超えた", "auto")).reason, "rate");
  assert.equal(requests.length, CALLS_PER_MINUTE);
  t = 61_000;
  await a.complete("索引の更新 1分後", "auto");
  assert.equal(requests.length, CALLS_PER_MINUTE + 1);

  const slow = assistant((req, n) =>
    n === 1 ? new Promise((_, reject) => req.signal!.addEventListener("abort", () => reject(new Error("中止しました。")))) : { completion: "はどう動く?" },
  );
  const first = slow.a.complete("IndexManager の", "auto");
  const second = await slow.a.complete("IndexManager の prepare", "auto");
  assert.equal((await first).reason, "aborted");
  assert.equal(second.completion, "はどう動く?");
});

test("続きの候補: 出力の上限で切れた応答は出さない", async () => {
  const f = { chat: async (): Promise<ChatResult> => ({ content: '{"completion":"はど', toolCalls: [], finishReason: "length" }) };
  const a = new PromptAssistant({ llm: f, index: () => NAMES, workspaceId: "/ws" });
  assert.equal((await a.complete("IndexManager の流れ", "auto")).reason, "truncated");
});

// ---------- API クライアント ----------

test("API: 入力補助の任意の引数(推論なし・出力の上限・キャッシュキー)を拒まれたら、付けずに送り直して、以後は付けない", async () => {
  const server = await startFakeOpenAi((req) => {
    const b = req.body;
    if (b.reasoning_effort === "none" || b.prompt_cache_key || b.max_completion_tokens) {
      return { status: 400, json: { error: { message: "Unrecognized request argument supplied: prompt_cache_key" } } };
    }
    return { json: { choices: [{ message: { role: "assistant", content: '{"completion":"はどう動く?"}' }, finish_reason: "stop" }] } };
  });
  try {
    const client = new OpenAiClient({ apiKey: async () => "k", baseUrl: () => server.baseUrl, model: () => "m", embeddingModel: () => "e", reasoningEffort: () => "auto", sleep: async () => {} });
    const a = new PromptAssistant({ llm: client, index: () => NAMES, workspaceId: "/ws" });
    assert.equal((await a.complete("IndexManager の流れ", "auto")).completion, "はどう動く?");
    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[1]!.body.reasoning_effort, undefined);
    assert.equal(server.requests[1]!.body.max_completion_tokens, undefined);
    await a.complete("IndexManager の流れ 2", "auto");
    assert.equal(server.requests.length, 3, "拒まれたモデルには最初から付けない");
    assert.equal(server.requests[2]!.body.prompt_cache_key, undefined);
  } finally {
    await server.close();
  }
});

test("API: 公式エンドポイントにだけキャッシュキーと出力の上限を送る。設定が default なら推論強度を送らない。補助の呼び出しは見積もりの補正に使わない", async () => {
  const bodies: any[] = [];
  const infos: string[] = [];
  const fetchImpl = (async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "{}" } }], usage: { prompt_tokens: 10 } }), { status: 200 });
  }) as unknown as typeof fetch;
  const make = (base: string, effort: string) =>
    new OpenAiClient({ apiKey: async () => "k", baseUrl: () => base, model: () => "m", embeddingModel: () => "e", reasoningEffort: () => effort, fetchImpl, sleep: async () => {}, beforeRequest: async (i) => void infos.push(i.channel) });
  const req: ChatRequest = { messages: [{ role: "user", content: "x" }], reasoningEffort: "none", cacheKey: "qbs", maxOutputTokens: 200, channel: "assist-auto" };
  await make("https://api.openai.com/v1", "auto").chat(req);
  assert.deepEqual([bodies[0].reasoning_effort, bodies[0].prompt_cache_key, bodies[0].max_completion_tokens], ["none", "qbs", 200]);
  await make("http://localhost:11434/v1", "auto").chat(req);
  assert.deepEqual([bodies[1].reasoning_effort, bodies[1].prompt_cache_key, bodies[1].max_completion_tokens], ["none", undefined, undefined]);
  await make("https://api.openai.com/v1", "default").chat(req);
  assert.deepEqual([bodies[2].reasoning_effort, bodies[2].prompt_cache_key], [undefined, undefined]);
  assert.deepEqual(infos, ["assist-auto", "assist-auto", "assist-auto"]);
});

// ---------- 索引 ----------

test("索引: 埋め込みを呼ばない検索、コードの識別子の実在確認(文書にだけ出る語は認めない)", async () => {
  const root = await makeTempDir();
  await writeFiles(root, {
    "src/auth.ts": `export function loginUser(name: string): boolean {\n  return name !== "";\n}\n\nexport function logoutUser(): void {\n  loginUser("x");\n}\n`,
    "docs/README.md": "# README\nloginUser の説明と onlyInDocs\n",
  });
  const embedder = new FakeEmbedder();
  const mgr = new IndexManager({
    dir: path.join(root, ".idx"),
    workspace: new NodeWorkspace(root),
    parser: new TsCompilerParser(),
    embedder: () => embedder,
    embeddingModel: () => "fake",
  });
  await mgr.load();
  await mgr.commit(await mgr.prepare(), { embed: true });
  const calls = embedder.calls;
  assert.equal(mgr.lexicalSearch("logout", 2)[0]!.chunk.file, "src/auth.ts");
  assert.equal(embedder.calls, calls, "埋め込みを呼ばない");
  assert.ok(mgr.knowsWord("loginUser"));
  assert.ok(!mgr.knowsWord("LOGINUSER"), "既定は大文字小文字まで一致");
  assert.ok(mgr.knowsWord("LOGINUSER", false));
  assert.ok(!mgr.knowsWord("onlyInDocs"), "文書にしか出てこない語は認めない");
  assert.equal(mgr.repoMap(1800), mgr.repoMap(1800));
});
