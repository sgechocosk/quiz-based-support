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
