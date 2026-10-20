import type { ApiChannel, ChatLlm, ChatMessage, ChatRequest, ChatResult, DecisionLlm, Embedder, PredicateRequest, ToolCall } from "./ports";
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
  kind: "chat" | "embedding" | "decision";
  model: string;
  /** 何のための呼び出しか */
  purpose: string;
  /** 入力トークン数の見積もり(直近の実測値で補正済み) */
  inputTokens: number;
  /** 呼び出し元の系統(入力補助は依頼の処理と分けて数える) */
  channel: ApiChannel;
}

const KIND_LABEL: Record<ApiRequestInfo["kind"], string> = { chat: "チャット", embedding: "埋め込み", decision: "判定" };
const CHANNEL_LABEL: Record<ApiChannel, string> = { main: "依頼の処理", assist: "入力補助", "assist-auto": "入力補助(自動)" };

/** 1回の呼び出し(リクエストの記録に添える情報) */
interface CallInfo {
  info: ApiRequestInfo;
}

const n = (v: unknown): number | undefined => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
const fmt = (v: number | undefined): string => (v === undefined ? "-" : v.toLocaleString());

/** リクエストの本文から、記録に出す引数(推論強度・出力の上限・キャッシュキー・ツール数・形式) */
function describeBody(body: unknown): string {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, any>;
  const parts: string[] = [];
  if (Array.isArray(b.messages)) {
    parts.push(`メッセージ${b.messages.length}件`);
  }
  if (Array.isArray(b.input)) {
    parts.push(`入力${b.input.length}件`);
  }
  if (b.reasoning_effort !== undefined) {
    parts.push(`推論=${b.reasoning_effort}`);
  }
  if (b.max_completion_tokens !== undefined) {
    parts.push(`出力上限=${b.max_completion_tokens}`);
  }
  if (b.prompt_cache_key !== undefined) {
    parts.push("キャッシュキー");
  }
  if (Array.isArray(b.tools)) {
    parts.push(`ツール${b.tools.length}個`);
  }
  if (b.response_format?.json_schema?.name) {
    parts.push(`JSON形式=${b.response_format.json_schema.name}`);
  }
  return parts.join(" ");
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
  /**
   * API キーを使うリクエストのたびに、記録の1行を渡す(送信・完了・失敗・確認の取り消し)。
   * 完了には、入力・出力トークン数(API が返した実測)・キャッシュに当たった数・推論トークン数・時間を含む。送った内容そのものは含まない。
   */
  log?: (line: string) => void;
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

/** Decisions API が対応しているモデル(現在はこれだけ) */
export const DECISION_MODEL = "gpt-6-luna";

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

/** prompt_cache_key は OpenAI の公式エンドポイントにだけ送る(互換エンドポイントは知らない引数を拒むことがある) */
function acceptsCacheKey(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

/**
 * OpenAI互換API(Chat Completions / Embeddings / Decisions)を fetch で直接呼ぶ薄いクライアント。
 * baseUrl を変えれば Azure/OpenRouter/Ollama 等の互換エンドポイントも使える。
 */
export class OpenAiClient implements ChatLlm, Embedder, DecisionLlm {
  /** ツール利用時に reasoning_effort=none が必要と判明したモデル */
  private readonly needsNoneWithTools = new Set<string>();
  /** 入力補助の任意の引数(推論強度・出力の上限・キャッシュキー)を拒んだモデル */
  private readonly rejectsOptional = new Set<string>();
  /** 見積もりを実測値に合わせる補正係数(実測 ÷ 見積もり の移動平均) */
  private readonly ratio = { chat: 1, embedding: 1, decision: 1 };

  constructor(private readonly o: OpenAiOptions) {}

  /** 見積もり(補正後)。確認画面に出す数 */
  private calibrated(kind: ApiRequestInfo["kind"], raw: number): number {
    return Math.max(1, Math.round(raw * this.ratio[kind]));
  }

  private learn(kind: ApiRequestInfo["kind"], raw: number, actual: number | undefined, channel: ApiChannel = "main"): void {
    // 入力補助の小さな呼び出しで、依頼の処理の見積もりを動かさない
    if (!actual || actual <= 0 || raw <= 0 || channel !== "main") {
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
    try {
      await this.o.beforeRequest(info);
      if (signal?.aborted) {
        throw new LlmError("中止しました。");
      }
    } catch (error) {
      this.o.log?.(`× 取り消し ${this.label(info)}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  private label(info: ApiRequestInfo): string {
    return `${KIND_LABEL[info.kind]}「${info.purpose}」 モデル ${info.model} 系統 ${CHANNEL_LABEL[info.channel]}`;
  }

  private async post(pathname: string, body: unknown, signal: AbortSignal | undefined, retries: number | undefined, call: CallInfo): Promise<any> {
    const key = await this.o.apiKey();
    if (!key) {
      throw new LlmError("APIキーが設定されていません。");
    }
    const doFetch = this.o.fetchImpl ?? fetch;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const url = this.o.baseUrl().replace(/\/+$/, "") + pathname;
    const maxRetries = retries ?? this.o.maxRetries ?? 3;

    const log = this.o.log;
    const label = this.label(call.info);
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      const started = Date.now();
      const secs = () => `${((Date.now() - started) / 1000).toFixed(1)}秒`;
      log?.(`→ 送信 ${label} 試行${attempt + 1}回目 入力(見積もり)約${fmt(call.info.inputTokens)}トークン ${describeBody(body)}`);
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        log?.(`× 通信失敗 ${label} ${secs()}: ${error instanceof Error ? error.message : String(error)}`);
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
        const json: any = await response.json();
        const u = json?.usage ?? {};
        const input = n(u.prompt_tokens ?? u.input_tokens);
        const output = n(u.completion_tokens ?? u.output_tokens);
        const cached = n(u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens);
        const reasoning = n(u.completion_tokens_details?.reasoning_tokens);
        const finish = json?.choices?.[0]?.finish_reason;
        log?.(
          `← 完了 ${label} ${secs()} 入力${fmt(input)}トークン(キャッシュ${fmt(cached)}) 出力${fmt(output)}トークン(推論${fmt(reasoning)})${finish ? ` 終了理由=${finish}` : ""}${input === undefined && output === undefined ? "(使用量が返されませんでした)" : ""}`,
        );
        return json;
      }
      const text = await response.text();
      let message = text.slice(0, 300);
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
      } catch {
        // JSONでない本文はそのまま使う
      }
      log?.(`× エラー ${label} ${secs()} HTTP ${response.status}: ${message.slice(0, 200)}`);
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
    const configured = (): string | undefined =>
      mode !== "auto" && mode !== "default"
        ? mode
        : mode === "auto" && hasTools && this.needsNoneWithTools.has(model)
          ? "none"
          : undefined;
    // 入力補助のための任意の引数(推論なし・出力の上限・キャッシュキー)。モデルや互換エンドポイントが拒んだら、
    // 付けずに送り直し、そのモデルには以後付けない(引数を拒まれただけで入力補助が止まらないように)
    const optional =
      !this.rejectsOptional.has(model) && (request.reasoningEffort || request.cacheKey || request.maxOutputTokens) && mode !== "default";
    const official = acceptsCacheKey(this.o.baseUrl());
    const plain = (): void => {
      delete body.prompt_cache_key;
      delete body.max_completion_tokens;
      const e = configured();
      if (e === undefined) {
        delete body.reasoning_effort;
      } else {
        body.reasoning_effort = e;
      }
    };
    plain();
    if (optional) {
      if (request.reasoningEffort) {
        body.reasoning_effort = request.reasoningEffort;
      }
      if (request.cacheKey && official) {
        body.prompt_cache_key = request.cacheKey;
      }
      if (request.maxOutputTokens && request.reasoningEffort === "none" && official) {
        body.max_completion_tokens = request.maxOutputTokens;
      }
    }
    const raw = estimateChatTokens(request);
    const info: ApiRequestInfo = {
      kind: "chat",
      model,
      purpose: request.purpose ?? "チャット",
      inputTokens: this.calibrated("chat", raw),
      channel: request.channel ?? "main",
    };
    // 1回の呼び出しにつき1回だけ確認する(下の再送・再試行は同じ内容なので確認しない)
    await this.gate(info, request.signal);
    let json: any;
    try {
      json = await this.post("/chat/completions", body, request.signal, request.retries, { info });
    } catch (error) {
      const rejected = error instanceof LlmError && error.status === 400;
      if (rejected && optional) {
        this.rejectsOptional.add(model);
        plain();
        json = await this.post("/chat/completions", body, request.signal, request.retries, { info });
      } else {
        const retriable = mode === "auto" && hasTools && body.reasoning_effort === undefined && rejected && /reasoning_effort/i.test(error.message) && /tool/i.test(error.message);
        if (!retriable) {
          throw error;
        }
        this.needsNoneWithTools.add(model);
        body.reasoning_effort = "none";
        json = await this.post("/chat/completions", body, request.signal, request.retries, { info });
      }
    }
    const actual = Number(json?.usage?.prompt_tokens) || undefined;
    this.learn("chat", raw, actual, info.channel);
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

  async predicate(request: PredicateRequest): Promise<number | undefined> {
    const raw = 3 + estimateTokens(request.input) + estimateTokens(request.instructions) + MESSAGE_OVERHEAD;
    const info: ApiRequestInfo = {
      kind: "decision",
      model: DECISION_MODEL,
      purpose: request.purpose ?? "判定",
      inputTokens: this.calibrated("decision", raw),
      channel: "main",
    };
    await this.gate(info, request.signal);
    const json = await this.post(
      "/decisions",
      {
        model: DECISION_MODEL,
        input: request.input,
        questions: [{ type: "predicate", name: request.name, instructions: request.instructions }],
      },
      request.signal,
      undefined,
      { info },
    );
    const actual = Number(json?.usage?.input_tokens) || undefined;
    this.learn("decision", raw, actual);
    const answers = (json?.answers ?? []) as Array<{ type?: string; name?: string; probability?: unknown }>;
    const answer = answers.find((a) => a?.name === request.name);
    if (!answer) {
      throw new LlmError(`Decisions API の応答に「${request.name}」の答えがありません。`);
    }
    if (answer.type === "refusal") {
      return undefined;
    }
    const p = Number(answer.probability);
    if (answer.type !== "predicate" || !Number.isFinite(p) || p < 0 || p > 1) {
      throw new LlmError(`Decisions API の応答の形が想定と違います(type=${String(answer.type)})。`);
    }
    return p;
  }

  async embed(texts: string[], signal?: AbortSignal, purpose?: string): Promise<number[][]> {
    const model = this.o.embeddingModel();
    const raw = texts.reduce((sum, t) => sum + estimateTokens(t), 0);
    const info: ApiRequestInfo = {
      kind: "embedding",
      model,
      purpose: purpose ?? "埋め込み(意味検索)",
      inputTokens: this.calibrated("embedding", raw),
      channel: "main",
    };
    await this.gate(info, signal);
    const json = await this.post("/embeddings", { model, input: texts, encoding_format: "float" }, signal, undefined, { info });
    const actual = Number(json?.usage?.prompt_tokens) || undefined;
    this.learn("embedding", raw, actual);
    const data = (json?.data ?? []) as Array<{ index: number; embedding: number[] }>;
    if (data.length !== texts.length) {
      throw new LlmError(`埋め込みの件数が一致しません(要求${texts.length}件/応答${data.length}件)。`);
    }
    return data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
