import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { IndexManager } from "../../core/indexer";
import { OpenAiClient } from "../../core/llm";
import type { ChatRequest, ChatResult } from "../../core/ports";
import { CALLS_PER_MINUTE, looksSecret, messagesFor, PromptAssistant, rejectCompletion, stripEcho, type AssistContext, type NameSource } from "../../core/promptAssist";
import { startFakeOpenAi } from "./helpers/fakeOpenAi";
import { FakeEmbedder, makeTempDir, NodeWorkspace, writeFiles } from "./helpers/nodeWorkspace";
import { TsCompilerParser } from "./helpers/tsAst";

const NAMES: NameSource = {
  hasChunks: () => true,
  lexicalSearch: () => [],
  repoMap: () => "src/core/indexer.ts — IndexManager, commit, prepare",
};

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

function assistant(
  reply: (req: ChatRequest, n: number) => unknown | Promise<unknown>,
  index: NameSource | undefined = NAMES,
  now = () => 0,
  context?: (files: string[]) => Promise<AssistContext>,
) {
  const f = fakeLlm(reply);
  return { ...f, a: new PromptAssistant({ llm: f.llm, index: () => index, context, workspaceId: "/ws", now }) };
}

// ---------- 整形と規則 ----------

test("書きかけの繰り返しを除く: 全体・末尾の繰り返しは除き、語の途中や偶然の短い重なりは残す", () => {
  assert.equal(stripEcho("索引の更新", "索引の更新は、どう流れる?"), "は、どう流れる?");
  assert.equal(stripEcho("ログイン処理を読みたい。特に失敗時", "特に失敗時の流れ"), "の流れ");
  assert.equal(stripEcho("テストのテスト", "テストを足したい"), "テストを足したい");
  assert.equal(stripEcho("Add a dark mode toggle to the", " theme settings panel"), " theme settings panel");
  assert.equal(stripEcho("索引の更新", "  は?"), "は?");
});

test("続きの候補は、空・「なし」などの文・返事・コードブロック・長すぎるものだけを出さない。それ以外は出す", () => {
  const ok = (draft: string, c: string) => rejectCompletion(stripEcho(draft, c));
  assert.equal(ok("索引の更新", "は、ファイルを保存してから `IndexManager.commit` までどう流れる?"), undefined);
  assert.equal(ok("ログアウト機能を", "追加したい。ログアウトしたらログイン画面に戻るようにしたい"), undefined);
  assert.equal(ok("索引の更新", ""), "empty");
  assert.equal(ok("索引の更新", "(なし)"), "meta");
  assert.equal(ok("索引の更新", "承知しました、見てみます"), "voice");
  assert.equal(ok("索引の更新", "```ts\nx\n```"), "formatting");
  assert.equal(ok("索引の更新", "x".repeat(201)), "too_long");
});

// ---------- 続きの候補(本体) ----------

const cont = (completion: string) => ({ completion });

test("モデルへの入力: 指示 → 全体像 → 入力ごとの状況 の順。関連コードの本文・開いているファイル・直近の依頼と結果・書きかけの状態を含む", () => {
  const hit: any = { chunk: { file: "media/main.js", startLine: 10, endLine: 20, symbols: ["onLessonTest"], text: "function onLessonTest(m) {\n  show(m);\n}" }, score: 1 };
  const ctx: AssistContext = {
    overview: "【プロジェクト】\nコード思考",
    activeFile: "src/a.ts",
    selection: "const x = 1;",
    changedFiles: ["src/b.ts"],
    coChanged: ["src/c.ts"],
    recent: [{ query: "ログインを直したい", outcome: "変更の依頼。受け入れ条件: …" }],
  };
  const m = messagesFor("テストの表示を", "change", [hit], ctx);
  assert.deepEqual(m.map((x) => x.role), ["system", "user", "user"]);
  assert.match(m[0]!.content!, /システムの全体像/);
  assert.equal(m[1]!.content, "【システムの全体像】\n【プロジェクト】\nコード思考");
  const last = m[2]!.content!;
  for (const needle of ["ログインを直したい", "結果: 変更の依頼", "開いているファイル: src/a.ts", "const x = 1;", "未コミットの変更: src/b.ts", "media/main.js:10-20(onLessonTest)", "show(m);", "src/c.ts", "変更を組み立てる", "<<<テストの表示を>>>"]) {
    assert.ok(last.includes(needle), needle);
  }
  assert.ok(last.indexOf("最近の依頼") < last.indexOf("関連しそうなコード") && last.indexOf("関連しそうなコード") < last.indexOf("【書きかけ】"));
});

test("続きの候補: 指示 → 全体像 → 入力ごとの状況 の順で送り、推論なし・出力の上限・キャッシュキーを付け、同じ書きかけは使い回す。作業の状況は入力ごとに集めて渡す", async () => {
  const seen: string[][] = [];
  const { a, requests } = assistant(
    () => cont("は、ファイルを保存してから `IndexManager.commit` までどう流れる?"),
    NAMES,
    () => 0,
    async (files) => (seen.push(files), { overview: "全体像", recent: [{ query: "前の依頼", outcome: "結果" }] }),
  );
  const out = await a.complete("索引の更新", "auto");
  assert.deepEqual(out, { text: "は、ファイルを保存してから `IndexManager.commit` までどう流れる?" });
  const req = requests[0]!;
  assert.equal(req.channel, "assist-auto");
  assert.equal(req.reasoningEffort, "none");
  assert.equal(req.maxOutputTokens, 300);
  assert.equal(req.retries, 0);
  assert.equal(req.jsonSchema?.name, "prompt_completion");
  assert.match(req.cacheKey ?? "", /^qbs-assist-[0-9a-f]{12}$/);
  assert.match(req.messages[2]!.content!, /前の依頼/);
  assert.equal(seen.length, 1);
  await a.complete("索引の更新", "auto");
  assert.equal(requests.length, 1);
});

test("入力補助: 索引がまだ無くても出す。短い・長い・秘密らしい書きかけは送らない。複数行の続きは最初の行を使う", async () => {
  const { a, requests } = assistant(() => cont("はどう動く?\n補足"), undefined);
  assert.equal((await a.complete("fooBar の流れ", "auto")).text, "はどう動く?");
  assert.equal((await a.complete("ログ", "auto")).reason, "short");
  assert.equal((await a.complete("x".repeat(1001), "auto")).reason, "long");
  assert.equal((await a.complete("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11", "auto")).reason, "long");
  assert.equal((await a.complete("キーは sk-abcdefghijklmnopqrstu です", "auto")).reason, "secret");
  assert.equal(requests.length, 1);
});

test("入力補助: 秘密らしい選択範囲・関連コードの抜粋は送らない", async () => {
  const secretHit: any = { chunk: { file: "src/env.ts", startLine: 1, endLine: 2, symbols: [], text: 'const k = "sk-abcdefghijklmnopqrstu";' }, score: 1 };
  const okHit: any = { chunk: { file: "src/ok.ts", startLine: 1, endLine: 2, symbols: ["ok"], text: "export const ok = 1;" }, score: 1 };
  const index: NameSource = { ...NAMES, lexicalSearch: () => [secretHit, okHit] };
  const { a, requests } = assistant(() => cont("はどう動く?"), index, () => 0, async () => ({ selection: "token=abcdef123456" }));
  await a.complete("ok の流れ", "auto");
  const sent = requests[0]!.messages.map((m) => m.content).join("\n");
  assert.ok(!sent.includes("sk-abcdefghijklmnopqrstu") && !sent.includes("abcdef123456"));
  assert.ok(sent.includes("src/ok.ts"));
});

test("続きの候補: 返事・空・「なし」・読めない応答・出力の上限で切れた応答は出さない", async () => {
  const r = async (reply: unknown, finishReason?: string) => {
    const f = { chat: async (): Promise<ChatResult> => ({ content: typeof reply === "string" ? reply : JSON.stringify(reply), toolCalls: [], finishReason }) };
    return new PromptAssistant({ llm: f, index: () => NAMES, workspaceId: "/ws" }).complete("ログインを直したい", "auto");
  };
  assert.deepEqual(await r(cont("承知しました")), { text: "", reason: "voice" });
  assert.equal((await r(cont(""))).reason, "empty");
  assert.equal((await r("not json")).reason, "unreadable");
  assert.equal((await r('{"completion":"はど', "length")).reason, "truncated");
});

test("入力補助: 失敗しても例外を投げず休む(1分・2分)。設定を変えると戻る", async () => {
  let t = 0;
  let fail = true;
  const { a, requests } = assistant(
    () => {
      if (fail) {
        throw new Error("API エラー(400): Unrecognized request argument");
      }
      return cont("はどう動く?");
    },
    NAMES,
    () => t,
  );
  assert.equal((await a.complete("IndexManager の流れ 1", "auto")).reason, "error");
  assert.equal((await a.complete("IndexManager の流れ 2", "auto")).reason, "paused");
  assert.equal(requests.length, 1);
  t = 61_000;
  assert.equal((await a.complete("IndexManager の流れ 3", "auto")).reason, "error");
  t = 61_000 + 100_000;
  assert.equal((await a.complete("IndexManager の流れ 4", "auto")).reason, "paused", "2回目の休みは2分");
  a.resetPause();
  fail = false;
  assert.equal((await a.complete("IndexManager の流れ 5", "auto")).text, "はどう動く?");
});

test("入力補助: 1分間の上限を超えたら呼ばない。新しい書きかけが来たら前の要求を中止する", async () => {
  let t = 0;
  const { a, requests } = assistant(() => cont(""), NAMES, () => t);
  for (let i = 0; i < CALLS_PER_MINUTE; i++) {
    await a.complete(`索引の更新 ${i} 回目`, "auto");
  }
  assert.equal((await a.complete("索引の更新 上限を超えた", "auto")).reason, "rate");
  assert.equal(requests.length, CALLS_PER_MINUTE);
  t = 61_000;
  await a.complete("索引の更新 1分後", "auto");
  assert.equal(requests.length, CALLS_PER_MINUTE + 1);

  const slow = assistant((req, n) =>
    n === 1 ? new Promise((_, reject) => req.signal!.addEventListener("abort", () => reject(new Error("中止しました。")))) : cont("はどう動く?"),
  );
  const first = slow.a.complete("IndexManager の", "auto");
  await new Promise((r) => setTimeout(r, 0)); // 前の要求が API の応答を待っている状態にする
  const second = await slow.a.complete("IndexManager の prepare", "auto");
  assert.equal((await first).reason, "aborted");
  assert.equal(second.text, "はどう動く?");
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
    assert.equal((await a.complete("IndexManager の流れ", "auto")).text, "はどう動く?");
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

test("索引: 埋め込みを呼ばない検索と、覚えておく構成の地図", async () => {
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
  assert.equal(mgr.repoMap(1800), mgr.repoMap(1800));
});
