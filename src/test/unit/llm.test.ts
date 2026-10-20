import * as assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAiClient } from "../../core/llm";

const ERR =
  "Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";

function makeFetch(bodies: any[], rejectWithEffort: boolean): typeof fetch {
  return (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (rejectWithEffort && body.tools && body.reasoning_effort === undefined) {
      return new Response(JSON.stringify({ error: { message: ERR } }), { status: 400 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200 });
  }) as unknown as typeof fetch;
}

function client(fetchImpl: typeof fetch, effort: string) {
  return new OpenAiClient({
    apiKey: async () => "k",
    baseUrl: () => "http://x/v1",
    model: () => "gpt-6-luna",
    embeddingModel: () => "e",
    reasoningEffort: () => effort,
    fetchImpl,
    sleep: async () => {},
  });
}

const TOOLS = [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }];
const MSGS = [{ role: "user" as const, content: "hi" }];

test("auto: ツール+推論の400では none で自動再試行し、以後は最初から none", async () => {
  const bodies: any[] = [];
  const c = client(makeFetch(bodies, true), "auto");
  assert.equal((await c.chat({ messages: MSGS, tools: TOOLS })).content, "ok");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].reasoning_effort, undefined);
  assert.equal(bodies[1].reasoning_effort, "none");
  await c.chat({ messages: MSGS, tools: TOOLS });
  assert.equal(bodies.length, 3);
  assert.equal(bodies[2].reasoning_effort, "none");
  await c.chat({ messages: MSGS }); // ツール無しは推論を残す
  assert.equal(bodies[3].reasoning_effort, undefined);
});

test("明示指定はそのまま送り、default は送らず、無関係な400は再試行しない", async () => {
  const bodies: any[] = [];
  await client(makeFetch(bodies, false), "low").chat({ messages: MSGS, tools: TOOLS });
  assert.equal(bodies[0].reasoning_effort, "low");
  const b2: any[] = [];
  await assert.rejects(client(makeFetch(b2, true), "default").chat({ messages: MSGS, tools: TOOLS }), /400/);
  assert.equal(b2.length, 1);
  assert.equal(b2[0].reasoning_effort, undefined);
});

test("Decisions API: predicate を /decisions に送り、確率を返す。refusal は undefined", async () => {
  const sent: Array<{ url: string; body: any }> = [];
  let reply: any = { answers: [{ type: "predicate", name: "q", probability: 0.83 }] };
  const fetchImpl = (async (url: any, init: any) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as unknown as typeof fetch;
  const c = client(fetchImpl, "auto");
  assert.equal(await c.predicate({ input: "ログアウトを追加したい", name: "q", instructions: "依頼か?" }), 0.83);
  assert.equal(sent[0]!.url, "http://x/v1/decisions");
  assert.deepEqual(sent[0]!.body, {
    model: "gpt-6-luna",
    input: "ログアウトを追加したい",
    questions: [{ type: "predicate", name: "q", instructions: "依頼か?" }],
  });
  reply = { answers: [{ type: "refusal", name: "q" }] };
  assert.equal(await c.predicate({ input: "x", name: "q", instructions: "?" }), undefined);
  reply = { answers: [] };
  await assert.rejects(c.predicate({ input: "x", name: "q", instructions: "?" }), /答えがありません/);
});

test("API の記録: 送信・完了(入力/出力トークン・キャッシュ・推論)・HTTP エラー・再試行・任意の引数なしでの送り直しを1リクエストごとに記録し、送った内容は含めない", async () => {
  const logs: string[] = [];
  let n = 0;
  const fetchImpl = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    n++;
    if (n === 1) {
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
    }
    if (body.reasoning_effort === "none") {
      return new Response(JSON.stringify({ error: { message: "Unrecognized request argument: reasoning_effort" } }), { status: 400 });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3310, completion_tokens: 48, prompt_tokens_details: { cached_tokens: 2816 }, completion_tokens_details: { reasoning_tokens: 12 } },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const c = new OpenAiClient({
    apiKey: async () => "k",
    baseUrl: () => "https://api.openai.com/v1",
    model: () => "gpt-6-luna",
    embeddingModel: () => "e",
    fetchImpl,
    sleep: async () => {},
    log: (l) => logs.push(l),
  });
  await c.chat({ messages: [{ role: "user", content: "秘密の本文 SECRET-BODY" }], purpose: "テスト", channel: "assist-auto", reasoningEffort: "none", cacheKey: "k", maxOutputTokens: 100 });
  assert.equal(logs.length, 6);
  assert.match(logs[0]!, /^→ 送信 チャット「テスト」 モデル gpt-6-luna 系統 入力補助\(自動\) 試行1回目 入力\(見積もり\)約\d+トークン メッセージ1件 推論=none 出力上限=100 キャッシュキー$/);
  assert.match(logs[1]!, /^× エラー .* HTTP 429: rate limited/);
  assert.match(logs[2]!, /試行2回目/);
  assert.match(logs[3]!, /^× エラー .* HTTP 400: Unrecognized request argument: reasoning_effort/);
  assert.match(logs[4]!, /試行1回目 .* メッセージ1件$/, "任意の引数なしで送り直す");
  assert.match(logs[5]!, /^← 完了 チャット「テスト」 .* [\d.]+秒 入力3,310トークン\(キャッシュ2,816\) 出力48トークン\(推論12\) 終了理由=stop$/);
  assert.ok(!logs.join("\n").includes("SECRET-BODY"));
});

test("API の記録: 埋め込みと判定の完了にも入力トークン数が出る。使用量が返されなければそう記録する", async () => {
  const logs: string[] = [];
  const fetchImpl = (async (url: any) => {
    if (String(url).endsWith("/embeddings")) {
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }], usage: { prompt_tokens: 7 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ answers: [{ type: "predicate", name: "q", probability: 0.9 }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const c = new OpenAiClient({ apiKey: async () => "k", baseUrl: () => "http://x/v1", model: () => "m", embeddingModel: () => "e", fetchImpl, sleep: async () => {}, log: (l) => logs.push(l) });
  await c.embed(["a"], undefined, "埋め込みテスト");
  await c.predicate({ input: "x", name: "q", instructions: "?", purpose: "判定テスト" });
  assert.match(logs[1]!, /^← 完了 埋め込み「埋め込みテスト」 .* 入力7トークン/);
  assert.match(logs[3]!, /^← 完了 判定「判定テスト」 .*\(使用量が返されませんでした\)$/);
});
