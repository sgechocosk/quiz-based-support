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
