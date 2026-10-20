import type { QuizMode } from "./agent";
import type { ChatLlm, ChatMessage } from "./ports";
import { parseJson, sha1 } from "./text";
import type { SearchHit } from "./types";

/**
 * 入力補助: 書きかけの依頼の続きを、入力欄に薄い文字で示す。
 * Claude Code の「次のプロンプトの予測」にならい、勧めたい依頼ではなく、利用者が書こうとしている続きを予測させる。
 * 書きかけは変えない。捨てるのは、候補になっていないもの(空・「なし」などの文・書式の崩れ)だけにする。
 */

/** 続きの候補を求める索引の機能(IndexManager が満たす) */
export interface NameSource {
  hasChunks(): boolean;
  lexicalSearch(query: string, k: number): SearchHit[];
  repoMap(budgetChars: number): string;
}

/** 入力が止まってから求めるまで(ミリ秒) */
export const DELAY_MS = 800;
/** 続きの候補を求める書きかけの長さ(空白を除く最短・全体の最長) */
export const MIN_DRAFT_CHARS = 3;
export const MAX_DRAFT_CHARS = 1000;
/** 続きの候補の最長(文字数) */
export const MAX_COMPLETION_CHARS = 200;
/** 1分間に API を呼ぶ上限 */
export const CALLS_PER_MINUTE = 20;
const REPO_MAP_CHARS = 1800;
const LEADS = 5;
const CACHE_SIZE = 40;
/** 失敗が続いたときに呼ぶのを休む時間(1回目・2回目・3回目以降) */
const PAUSE_MS = [60_000, 120_000, 300_000];

const MODE_LABEL: Record<QuizMode, string> = {
  auto: "自動で判断",
  read: "仕組みを読み解く",
  change: "変更を組み立てる",
};

export function meaningfulLength(text: string): number {
  return text.replace(/\s+/g, "").length;
}

// ---------- 送らないもの ----------

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b[sr]k_(live|test)_[A-Za-z0-9]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /:\/\/[^\s/:@]+:[^\s/@]+@/,
  /\bBearer\s+[\w.~+/-]{16,}/i,
  /(?<![A-Za-z0-9])(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/i,
  /\b[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]*\s*[:=]\s*\S{6,}/,
  /\b[A-Za-z0-9]{40,}\b/,
];

/** API キーなど秘密の情報らしい文字列を含むか(含めば API に送らない) */
export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

// ---------- 続きの候補 ----------

const SYSTEM = [
  "あなたは VS Code 拡張「コード思考」の入力欄で、利用者が書きかけている指示の続きを予測する担当です。",
  "利用者はこの入力欄に、コードの仕組みを知りたい質問や、コードを変更してほしい依頼を、自然な日本語(英語のこともある)で書きます。",
  "",
  "【やること】",
  "- 書きかけの文章が、何を指示しよう・質問しようとしているのかを推測し、その続きを書く。基準は「利用者が『まさにそう書こうとしていた』と思うか」。",
  "- 書きかけの部分は変えない。completion には、書きかけの末尾にそのままつなげる文字列だけを入れる(書きかけを繰り返さない)。",
  "- 文の途中なら、その文を完成させる。文が書き終わっていれば、利用者が次に付け足しそうな内容を書いてよい。",
  "- 文体(です・ます/である/体言止め)と言葉づかいは書きかけに合わせる。利用者自身の声で書き、説明・呼びかけ・お礼・評価はしない。",
  "- 具体的にする。【構成】【候補】にある実在のファイル名・関数名が使えるときは、バッククォートで囲んで使う。無い名前は作らない。",
  "- 質問なら問いの形(「〜はどう動く?」)、変更の依頼なら「〜ようにしたい」「〜を追加したい」の形で自然に終える。",
  "- 続きがまったく読み取れないときだけ、completion を空文字にする。",
  "- 例: 書きかけ「索引の更新」→ completion「は、ファイルを保存してから `IndexManager.commit` までどう流れる?」",
  "- 例: 書きかけ「ログアウト機能を」→ completion「追加したい。ログアウトしたらログイン画面に戻るようにしたい」",
  "出力は指定の JSON スキーマに厳密に従う。",
].join("\n");

export const SCHEMA = {
  name: "prompt_completion",
  schema: {
    type: "object",
    properties: { completion: { type: "string" } },
    required: ["completion"],
    additionalProperties: false,
  },
} as const;

/** 指示 → 構成 → 候補と書きかけ の順(先頭ほど変わらないので、プロンプトキャッシュに当たりやすい) */
export function messagesFor(draft: string, mode: QuizMode, repoMap: string, leads: SearchHit[]): ChatMessage[] {
  const lead = leads
    .map(({ chunk: c }) => `- ${c.file}:${c.startLine}-${c.endLine}${c.symbols.length > 0 ? `(${c.symbols.slice(0, 3).join(",")})` : ""}`)
    .join("\n");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: `【構成(ファイル — 主な名前)】\n${repoMap || "(索引がまだありません)"}` },
    {
      role: "user",
      content: [
        "【候補: 書きかけで検索して見つかった場所(まだ読んでいない)】",
        lead || "(見つかりませんでした)",
        "",
        `【進め方】${MODE_LABEL[mode]}`,
        "【書きかけ】(<<< と >>> の間。前後の空白も書きかけの一部)",
        `<<<${draft}>>>`,
      ].join("\n"),
    },
  ];
}

/** モデルが書きかけを繰り返した部分を除き、つなぎ目の空白を整える */
export function stripEcho(draft: string, completion: string): string {
  let c = completion.replace(/\r/g, "");
  const d = draft.trimEnd();
  if (d && c.startsWith(d)) {
    c = c.slice(d.length);
  } else {
    // 書きかけの末尾をそのまま繰り返した(3文字以下の重なり・語の途中までの重なりは偶然の一致なので残す)
    for (let k = Math.min(d.length, c.length); k >= 4; k--) {
      if (d.endsWith(c.slice(0, k)) && !/[A-Za-z0-9_]/.test(c.charAt(k))) {
        c = c.slice(k);
        break;
      }
    }
  }
  const last = draft.slice(-1);
  if (last === "" || /\s/.test(last) || /[　-鿿＀-￯]/.test(last)) {
    c = c.replace(/^[ \t]+/, "");
  }
  return c.replace(/\s+$/, "");
}

/** 候補を整える(改行は最初の行だけにする)。出さない理由があればそれを返す */
export function rejectCompletion(completion: string): string | undefined {
  const c = completion;
  const checks: Array<[string, () => boolean]> = [
    ["empty", () => meaningfulLength(c) === 0],
    ["too_long", () => c.length > MAX_COMPLETION_CHARS],
    ["formatting", () => /```/.test(c)],
    ["meta", () => /^[\s(（「『]*(なし|特になし|提案なし|候補なし|ありません|n\/a|none|null|no suggestion)[\s)）」』。.]*$/i.test(c)],
    ["voice", () => /^\s*(承知しました|かしこまりました|了解しました|let me |i'll |here is|here's|sure[,!])/i.test(c)],
  ];
  return checks.find(([, test]) => test())?.[0];
}

export interface Completion {
  /** 書きかけに続ける文字列(出さないときは空文字) */
  completion: string;
  /** 出さなかった理由(記録用) */
  reason?: string;
}

export interface AssistantDeps {
  llm: ChatLlm;
  /** 索引(まだ無ければ undefined。無いときは名前を確かめずに、構成なしで求める) */
  index: () => NameSource | undefined;
  /** プロンプトキャッシュの振り分けキーに使う(ワークスペースごと) */
  workspaceId: string;
  /** 理由の記録(出力パネルに出す。候補が出ないときに原因を調べられるように) */
  log?: (line: string) => void;
  now?: () => number;
}

/**
 * 続きの候補を作る。同時に1件だけ(新しい書きかけが来たら前の要求を中止)、同じ書きかけの結果は使い回し、
 * 1分に CALLS_PER_MINUTE 回まで。失敗が続くときは休む(設定を変えると戻す)。
 */
export class PromptAssistant {
  private readonly cache = new Map<string, Completion>();
  private readonly calls: number[] = [];
  private inflight?: AbortController;
  private failures = 0;
  private pausedUntil = 0;

  constructor(private readonly deps: AssistantDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private done(draft: string, completion: string, reason: string | undefined, detail = ""): Completion {
    this.deps.log?.(`${completion ? "表示" : "出さない"}${reason ? `(${reason})` : ""} 書きかけ ${draft.length}文字${detail ? ` ${detail}` : ""}${completion ? ` → ${completion}` : ""}`);
    return { completion, reason };
  }

  /** 前の要求を中止する(入力が変わった・送信した) */
  cancel(): void {
    this.inflight?.abort();
    this.inflight = undefined;
  }

  /** 設定・API キーが変わったとき: 失敗で休んでいたのを戻す */
  resetPause(): void {
    this.failures = 0;
    this.pausedUntil = 0;
  }

  /** 書きかけの続き。失敗しても例外は投げない(入力の邪魔をしない) */
  async complete(draft: string, mode: QuizMode): Promise<Completion> {
    if (meaningfulLength(draft) < MIN_DRAFT_CHARS) {
      return { completion: "", reason: "short" };
    }
    if (draft.length > MAX_DRAFT_CHARS || draft.split("\n").length > 10) {
      return this.done(draft, "", "long");
    }
    if (looksSecret(draft)) {
      return this.done(draft, "", "secret");
    }
    const key = `${mode}\u0000${draft}`;
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    const now = this.now();
    if (now < this.pausedUntil) {
      return { completion: "", reason: "paused" };
    }
    while (this.calls.length > 0 && now - this.calls[0]! > 60_000) {
      this.calls.shift();
    }
    if (this.calls.length >= CALLS_PER_MINUTE) {
      return this.done(draft, "", "rate");
    }
    this.calls.push(now);

    this.cancel();
    const controller = new AbortController();
    this.inflight = controller;
    const index = this.deps.index();
    try {
      const leads = index?.hasChunks() ? index.lexicalSearch(draft, LEADS * 3).filter((h) => !/\.(md|mdx|txt|rst)$/i.test(h.chunk.file)).slice(0, LEADS) : [];
      const res = await this.deps.llm.chat({
        messages: messagesFor(draft, mode, index?.repoMap(REPO_MAP_CHARS) ?? "", leads),
        jsonSchema: SCHEMA,
        signal: controller.signal,
        purpose: "入力の続きの候補",
        channel: "assist-auto",
        reasoningEffort: "none",
        cacheKey: `qbs-assist-${sha1(this.deps.workspaceId).slice(0, 12)}`,
        maxOutputTokens: 300,
        retries: 0,
      });
      this.failures = 0;
      let result: Completion;
      if (res.finishReason === "length") {
        result = this.done(draft, "", "truncated");
      } else {
        const raw = parseJson<{ completion?: unknown }>(res.content);
        // 複数行で返ってきたら最初の行を使う(入力欄に1行の続きとして足すため)
        const completion = stripEcho(draft, typeof raw.completion === "string" ? raw.completion : "").split("\n")[0]!.trimEnd();
        const reason = rejectCompletion(completion);
        result = reason ? this.done(draft, "", reason, `候補「${completion}」`) : this.done(draft, completion, undefined);
      }
      this.cache.set(key, result);
      while (this.cache.size > CACHE_SIZE) {
        this.cache.delete(this.cache.keys().next().value!);
      }
      return result;
    } catch (error) {
      if (controller.signal.aborted) {
        return { completion: "", reason: "aborted" };
      }
      this.pausedUntil = this.now() + PAUSE_MS[Math.min(this.failures++, PAUSE_MS.length - 1)]!;
      return this.done(draft, "", "error", `${error instanceof Error ? error.message : String(error)}(${Math.round((this.pausedUntil - this.now()) / 1000)}秒休みます)`);
    } finally {
      if (this.inflight === controller) {
        this.inflight = undefined;
      }
    }
  }
}
