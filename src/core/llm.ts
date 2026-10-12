import type { ChatLlm, ChatMessage, ChatRequest, ChatResult, Embedder, ToolCall } from "./ports";

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface OpenAiOptions {
  apiKey: () => Promise<string | undefined>;
  baseUrl: () => string;
  model: () => string;
  embeddingModel: () => string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

function toWire(m: ChatMessage): WireMessage {
  const wire: WireMessage = { role: m.role, content: m.content };
  if (m.toolCalls && m.toolCalls.length > 0) {
    wire.tool_calls = m.toolCalls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.arguments },
    }));
  }
  if (m.toolCallId) {
    wire.tool_call_id = m.toolCallId;
  }
  return wire;
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

/**
 * OpenAI互換API(Chat Completions / Embeddings)を fetch で直接呼ぶ薄いクライアント。
 * baseUrl を変えれば Azure/OpenRouter/Ollama 等の互換エンドポイントも使える。
 */
export class OpenAiClient implements ChatLlm, Embedder {
  constructor(private readonly o: OpenAiOptions) {}

  private async post(pathname: string, body: unknown, signal?: AbortSignal): Promise<any> {
    const key = await this.o.apiKey();
    if (!key) {
      throw new LlmError("APIキーが設定されていません。");
    }
    const doFetch = this.o.fetchImpl ?? fetch;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const url = this.o.baseUrl().replace(/\/+$/, "") + pathname;
    const maxRetries = this.o.maxRetries ?? 3;

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (signal?.aborted) {
          throw new LlmError("中止しました。");
        }
        if (attempt < maxRetries) {
          await sleep(Math.min(500 * 2 ** attempt, 8000));
          continue;
        }
        throw new LlmError(`ネットワークエラー: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.ok) {
        return response.json();
      }
      const text = await response.text();
      let message = text.slice(0, 300);
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
      } catch {
        // JSONでない本文はそのまま使う
      }
      if (RETRYABLE.has(response.status) && attempt < maxRetries && !/quota/i.test(message)) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(500 * 2 ** attempt, 8000));
        continue;
      }
      if (response.status === 401) {
        throw new LlmError(`APIキーが無効です(401): ${message}`, 401);
      }
      throw new LlmError(`API エラー(${response.status}): ${message}`, response.status);
    }
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.o.model(),
      messages: request.messages.map(toWire),
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = "auto";
    }
    if (request.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: request.jsonSchema.name, strict: true, schema: request.jsonSchema.schema },
      };
    }
    const json = await this.post("/chat/completions", body, request.signal);
    const message = json?.choices?.[0]?.message as WireMessage | undefined;
    if (!message) {
      throw new LlmError("APIの応答に choices[0].message がありません。");
    }
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function.name,
      arguments: c.function.arguments,
    }));
    return { content: message.content ?? null, toolCalls };
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const json = await this.post(
      "/embeddings",
      { model: this.o.embeddingModel(), input: texts, encoding_format: "float" },
      signal,
    );
    const data = (json?.data ?? []) as Array<{ index: number; embedding: number[] }>;
    if (data.length !== texts.length) {
      throw new LlmError(`埋め込みの件数が一致しません(要求${texts.length}件/応答${data.length}件)。`);
    }
    return data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
