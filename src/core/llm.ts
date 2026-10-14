import type { ChatLlm, ChatMessage, ChatRequest, ChatResult, Embedder, ToolCall } from "./ports";
import { estimateTokens } from "./text";

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** API を呼ぶ直前に知らせる内容(実行前の確認に使う) */
export interface ApiRequestInfo {
  kind: "chat" | "embedding";
  model: string;
  /** 何のための呼び出しか */
  purpose: string;
  /** 入力トークン数の見積もり(直近の実測値で補正済み) */
  inputTokens: number;
}

/** 応答を受け取った後に知らせる内容 */
export interface ApiUsageInfo extends ApiRequestInfo {
  /** API が返した実際の入力トークン数(返されなければ undefined) */
  actualInputTokens?: number;
  outputTokens?: number;
}

export interface OpenAiOptions {
  apiKey: () => Promise<string | undefined>;
  baseUrl: () => string;
  model: () => string;
  embeddingModel: () => string;
  /** "auto"(既定): 未指定で送り、ツール+推論の非対応エラー時だけ none で再試行 / "default": 常に未指定 / それ以外: そのまま送る */
  reasoningEffort?: () => string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  /** API を呼ぶ直前に呼ばれる。例外を投げると、その呼び出しを取り消す(リクエストは送らない) */
  beforeRequest?: (info: ApiRequestInfo) => Promise<void>;
  /** 応答を受け取った後に呼ばれる */
  afterResponse?: (info: ApiUsageInfo) => void;
}

/** メッセージ1件あたりの付帯トークン(役割名・区切り)の目安 */
const MESSAGE_OVERHEAD = 4;

/** Chat Completions の入力トークン数の大まかな見積もり(補正前) */
export function estimateChatTokens(request: Pick<ChatRequest, "messages" | "tools" | "jsonSchema">): number {
  let total = 3;
  for (const m of request.messages) {
    total += MESSAGE_OVERHEAD + estimateTokens(m.content ?? "");
    for (const c of m.toolCalls ?? []) {
      total += estimateTokens(c.name) + estimateTokens(c.arguments) + MESSAGE_OVERHEAD;
    }
  }
  if (request.tools && request.tools.length > 0) {
    total += estimateTokens(JSON.stringify(request.tools));
  }
  if (request.jsonSchema) {
    total += estimateTokens(JSON.stringify(request.jsonSchema.schema));
  }
  return total;
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
  /** ツール利用時に reasoning_effort=none が必要と判明したモデル */
  private readonly needsNoneWithTools = new Set<string>();
  /** 見積もりを実測値に合わせる補正係数(実測 ÷ 見積もり の移動平均) */
  private readonly ratio = { chat: 1, embedding: 1 };

  constructor(private readonly o: OpenAiOptions) {}

  /** 見積もり(補正後)。確認画面に出す数 */
  private calibrated(kind: "chat" | "embedding", raw: number): number {
    return Math.max(1, Math.round(raw * this.ratio[kind]));
  }

  private learn(kind: "chat" | "embedding", raw: number, actual: number | undefined): void {
    if (!actual || actual <= 0 || raw <= 0) {
      return;
    }
    const next = this.ratio[kind] * 0.6 + (actual / raw) * 0.4;
    this.ratio[kind] = Math.min(Math.max(next, 0.4), 3);
  }

  /** 実行前の確認。取り消されたら LlmError(リクエストは送らない) */
  private async gate(info: ApiRequestInfo, signal?: AbortSignal): Promise<void> {
    if (!this.o.beforeRequest) {
      return;
    }
    await this.o.beforeRequest(info);
    if (signal?.aborted) {
      throw new LlmError("中止しました。");
    }
  }

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
    const model = this.o.model();
    const mode = (this.o.reasoningEffort?.() ?? "auto").trim() || "auto";
    const hasTools = !!body.tools;
    if (mode !== "auto" && mode !== "default") {
      body.reasoning_effort = mode;
    } else if (mode === "auto" && hasTools && this.needsNoneWithTools.has(model)) {
      body.reasoning_effort = "none";
    }
    const raw = estimateChatTokens(request);
    const info: ApiRequestInfo = {
      kind: "chat",
      model,
      purpose: request.purpose ?? "チャット",
      inputTokens: this.calibrated("chat", raw),
    };
    // 1回の呼び出しにつき1回だけ確認する(下の再送・再試行は同じ内容なので確認しない)
    await this.gate(info, request.signal);
    let json: any;
    try {
      json = await this.post("/chat/completions", body, request.signal);
    } catch (error) {
      const retriable =
        mode === "auto" &&
        hasTools &&
        body.reasoning_effort === undefined &&
        error instanceof LlmError &&
        error.status === 400 &&
        /reasoning_effort/i.test(error.message) &&
        /tool/i.test(error.message);
      if (!retriable) {
        throw error;
      }
      this.needsNoneWithTools.add(model);
      body.reasoning_effort = "none";
      json = await this.post("/chat/completions", body, request.signal);
    }
    const actual = Number(json?.usage?.prompt_tokens) || undefined;
    this.learn("chat", raw, actual);
    this.o.afterResponse?.({ ...info, actualInputTokens: actual, outputTokens: Number(json?.usage?.completion_tokens) || undefined });
    const message = json?.choices?.[0]?.message as WireMessage | undefined;
    if (!message) {
      throw new LlmError("APIの応答に choices[0].message がありません。");
    }
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function.name,
      arguments: c.function.arguments,
    }));
    const finishReason = typeof json?.choices?.[0]?.finish_reason === "string" ? (json.choices[0].finish_reason as string) : undefined;
    return { content: message.content ?? null, toolCalls, finishReason };
  }

  async embed(texts: string[], signal?: AbortSignal, purpose?: string): Promise<number[][]> {
    const model = this.o.embeddingModel();
    const raw = texts.reduce((sum, t) => sum + estimateTokens(t), 0);
    const info: ApiRequestInfo = {
      kind: "embedding",
      model,
      purpose: purpose ?? "埋め込み(意味検索)",
      inputTokens: this.calibrated("embedding", raw),
    };
    await this.gate(info, signal);
    const json = await this.post("/embeddings", { model, input: texts, encoding_format: "float" }, signal);
    const actual = Number(json?.usage?.prompt_tokens) || undefined;
    this.learn("embedding", raw, actual);
    this.o.afterResponse?.({ ...info, actualInputTokens: actual });
    const data = (json?.data ?? []) as Array<{ index: number; embedding: number[] }>;
    if (data.length !== texts.length) {
      throw new LlmError(`埋め込みの件数が一致しません(要求${texts.length}件/応答${data.length}件)。`);
    }
    return data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
