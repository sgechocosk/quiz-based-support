import type { QuizMode } from "./agent";
import type { ChatLlm, ChatMessage } from "./ports";
import { parseJson, sha1 } from "./text";
import type { SearchHit } from "./types";

/**
 * 入力補助: 入力が止まったとき、書きかけの文章が何を指示しようとしているかを、システムの全体像と照らして推測し、
 * - 文の途中なら、その続きを(continue)
 * - 書き終わっていて、依頼として情報が足りないなら、足りない情報を補った依頼文への置き換えを(replace)
 * - すでに明確なら、何も出さない(none)
 * 入力欄に薄い文字で示す。Tab で入れる。書きかけは勝手には変えない。
 */

/** 入力補助が使う索引の機能(IndexManager が満たす) */
export interface NameSource {
  hasChunks(): boolean;
  lexicalSearch(query: string, k: number): SearchHit[];
  repoMap(budgetChars: number): string;
}

/** 入力のたびに集める、作業の状況(ホストが渡す) */
export interface AssistContext {
  /** システムの全体像(README・構成・プロジェクトの約束など。変わりにくい) */
  overview?: string;
  /** エディタで開いているファイル(ワークスペース相対)と、選択中のコード */
  activeFile?: string;
  selection?: string;
  /** 未コミットの変更があるファイル */
  changedFiles?: string[];
  /** 関連コードのファイルと一緒に変わってきたファイル */
  coChanged?: string[];
  /** 直近の依頼と、その結果の要約(新しい順) */
  recent?: Array<{ query: string; outcome: string }>;
}

/** 入力が止まってから求めるまで(ミリ秒) */
export const DELAY_MS = 800;
/** 求める書きかけの長さ(空白を除く最短・全体の最長) */
export const MIN_DRAFT_CHARS = 3;
export const MAX_DRAFT_CHARS = 1000;
/** 続きの候補・置き換え案の最長(文字数) */
export const MAX_COMPLETION_CHARS = 200;
export const MAX_REPLACEMENT_CHARS = 500;
/** 1分間に API を呼ぶ上限 */
export const CALLS_PER_MINUTE = 20;
const LEADS = 5;
const EXCERPT_CHARS = 700;
const SELECTION_CHARS = 1200;
const CACHE_SIZE = 40;
/** 失敗が続いたときに呼ぶのを休む時間(1回目・2回目・3回目以降) */
const PAUSE_MS = [60_000, 120_000, 300_000];
/** 置き換え案が、書きかけの文字をどれだけ残していればよいか(利用者の言葉を捨てた別の依頼にしない) */
const MIN_PRESERVED = 0.4;

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

// ---------- 書きかけの状態 ----------

/** 文が書き終わっているように見えるか(読点・助詞・接続の語尾で終わっていれば、まだ途中) */
export function looksFinished(draft: string): boolean {
  const t = draft.trimEnd();
  if (meaningfulLength(t) < 6) {
    return false;
  }
  if (/[、,，…]$|[をがはにでとのもへやて]$|(から|まで|より|ので|けど|ため|ように|として|について|に対して)$/.test(t)) {
    return false;
  }
  return true;
}

/**
 * 書きかけのうち、置き換え案がそのまま残している文字の割合。
 * 最長共通部分列のうち、3文字以上続いて残っている部分だけを数える(助詞などが散らばって偶然そろったものを数えない)
 */
export function preservedRatio(draft: string, replacement: string): number {
  const a = Array.from(draft.replace(/\s+/g, ""));
  const b = Array.from(replacement.replace(/\s+/g, ""));
  if (a.length === 0) {
    return 1;
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  let kept = 0;
  let run = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      run++;
      i++;
      j++;
      continue;
    }
    kept += run >= 3 ? run : 0;
    run = 0;
    if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  kept += run >= 3 ? run : 0;
  return kept / a.length;
}

// ---------- モデルへの入力 ----------

const SYSTEM = [
  "あなたは VS Code 拡張「コード思考」の入力欄を支える担当です。",
  "この拡張は、利用者が入力欄に書いた依頼(コードの仕組みの質問、コードの変更の依頼)を受け取り、コードを調査し、変更の計画を作ります。",
  "依頼に「どこを・どうしたいか」が書かれているほど、調査と計画は正確に進みます。あなたは、システムの全体像を知っている立場から、利用者がプロンプトを書く負担を減らします。",
  "",
  "【判断(kind)】書きかけの状態を見て、次の3つから選ぶ。",
  "- continue: 文の途中のとき。書きかけの続きを、text に入れる。",
  "- replace: 書き終わっているが、依頼として情報が足りないとき。足りない情報を補った依頼文の全体を、text に入れる。",
  "- none: すでに十分明確・意図が読めない・どちらも自信がないとき。text は空文字。無理に出さない。",
  "【状態】欄の「文末が完結している可能性」が「いいえ」のときは、replace にしない。",
  "",
  "【依頼として十分な状態】",
  "- 変更の依頼: 変更する場所(実在するファイル・関数の名前)/ どうなってほしいか(「〜のとき〜になる」)/ 変えないもの(分かる場合)/ 手本になる既存の実装(分かる場合)。",
  "- 仕組みの質問: 対象(実在するファイル・関数の名前)/ 知りたいこと(流れ・呼び出し元・データの形・条件・理由)。",
  "",
  "【continue の書き方】",
  "- completion は、書きかけの末尾にそのままつなげる文字列だけ。書きかけを繰り返さない。1文の続きを、できるだけ具体的に。",
  "",
  "【replace の書き方】",
  "- 利用者の意図と言葉を残し、足りない情報を足す(書きかけの文字の多くをそのまま残す)。まったく別の依頼にしない。",
  "- 足してよい情報は、【システムの全体像】【関連しそうなコード】【作業中の状況】【最近の依頼と結果】に根拠があるものだけ。実在するファイル名・関数名はバッククォートで囲んで使う。無い名前は作らない。",
  "- 利用者が決めること(仕様・条件・数値・画面の文言・方針)は、書かれていなければ足さない。分からないことを推測で決めない。",
  "- 1〜3文、改行なし、500文字以内。利用者自身の依頼文として書く(説明・呼びかけ・お礼は書かない)。文体は書きかけに合わせる。",
  "",
  "【例】",
  "- 書きかけ「テストの表示を直したい。」(コードに `onLessonTest` がある)→ replace「`onLessonTest` で、テストが失敗したときの表示を直したい。」",
  "- 書きかけ「索引の更新」(文の途中)→ continue「は、ファイルを保存してから `IndexManager.commit` までどう流れる?」",
  "- 書きかけ「`IndexManager.commit` が、保存のたびにどこから呼ばれるか知りたい。」→ none",
  "出力は指定の JSON スキーマに厳密に従う。",
].join("\n");

export const SCHEMA = {
  name: "prompt_assist",
  schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["continue", "replace", "none"] },
      text: { type: "string" },
    },
    required: ["kind", "text"],
    additionalProperties: false,
  },
} as const;

function section(title: string, body: string | undefined): string {
  return body && body.trim() ? `【${title}】\n${body.trim()}` : "";
}

/** 指示 → 全体像 → 入力ごとの状況 の順(先頭ほど変わらないので、プロンプトキャッシュに当たりやすい) */
export function messagesFor(draft: string, mode: QuizMode, hits: SearchHit[], ctx: AssistContext): ChatMessage[] {
  const code = hits
    .map(({ chunk: c }) => `${c.file}:${c.startLine}-${c.endLine}${c.symbols.length > 0 ? `(${c.symbols.slice(0, 3).join(",")})` : ""}\n${c.text.slice(0, EXCERPT_CHARS)}`)
    .join("\n---\n");
  const recent = (ctx.recent ?? []).map((r) => `- 依頼: ${r.query}\n  結果: ${r.outcome || "(まだ)"}`).join("\n");
  const work = [
    ctx.activeFile ? `開いているファイル: ${ctx.activeFile}` : "",
    ctx.selection ? `選択中のコード:\n${ctx.selection.slice(0, SELECTION_CHARS)}` : "",
    ctx.changedFiles && ctx.changedFiles.length > 0 ? `未コミットの変更: ${ctx.changedFiles.slice(0, 12).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: section("システムの全体像", ctx.overview) || "【システムの全体像】\n(まだありません)" },
    {
      role: "user",
      content: [
        section("最近の依頼と結果(新しい順)", recent),
        section("作業中の状況", work),
        section("関連しそうなコード(書きかけで検索した上位。まだ全体は読んでいない)", code) || "【関連しそうなコード】\n(見つかりませんでした)",
        section("一緒に変わってきたファイル", ctx.coChanged?.slice(0, 6).join(", ")),
        `【進め方】${MODE_LABEL[mode]}`,
        `【状態】文末が完結している可能性: ${looksFinished(draft) ? "はい" : "いいえ"}`,
        "【書きかけ】(<<< と >>> の間。前後の空白も書きかけの一部)",
        `<<<${draft}>>>`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
}

// ---------- 返ってきた内容の整形 ----------

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

/** 候補として成り立たないもの(出さない理由)。続きと置き換えで共通 */
function rejectText(text: string, limit: number): string | undefined {
  const checks: Array<[string, () => boolean]> = [
    ["empty", () => meaningfulLength(text) === 0],
    ["too_long", () => text.length > limit],
    ["formatting", () => /```/.test(text)],
    ["meta", () => /^[\s(（「『]*(なし|特になし|提案なし|候補なし|ありません|n\/a|none|null|no suggestion)[\s)）」』。.]*$/i.test(text)],
    ["voice", () => /^\s*(承知しました|かしこまりました|了解しました|let me |i'll |here is|here's|sure[,!])/i.test(text)],
  ];
  return checks.find(([, test]) => test())?.[0];
}

/** 続きの候補を出さない理由(出してよければ undefined) */
export function rejectCompletion(completion: string): string | undefined {
  return rejectText(completion, MAX_COMPLETION_CHARS);
}

/** 置き換え案を出さない理由(出してよければ undefined) */
export function rejectReplacement(draft: string, replacement: string): string | undefined {
  const base = rejectText(replacement, MAX_REPLACEMENT_CHARS);
  if (base) {
    return base;
  }
  const norm = (t: string) => t.replace(/\s+/g, "");
  if (norm(replacement) === norm(draft)) {
    return "same";
  }
  // 情報を足す案だけ(足りない情報を補うのが目的なので、短くなる案は出さない)
  if (norm(replacement).length < norm(draft).length + 5) {
    return "not_richer";
  }
  // 利用者の言葉を捨てた別の依頼は出さない
  if (preservedRatio(draft, replacement) < MIN_PRESERVED) {
    return "drift";
  }
  return undefined;
}

export interface Completion {
  kind: "continue" | "replace" | "none";
  /** continue: 書きかけに続ける文字列 / replace: 置き換える依頼文の全体 / none: 空文字 */
  text: string;
  /** 出さなかった理由(記録用) */
  reason?: string;
}

const NONE = (reason?: string): Completion => ({ kind: "none", text: "", reason });

export interface AssistantDeps {
  llm: ChatLlm;
  /** 索引(まだ無ければ undefined。無いときは関連コード・構成なしで求める) */
  index: () => NameSource | undefined;
  /** 入力ごとの作業の状況(全体像・開いているファイル・直近の依頼など)。関連コードのファイルを渡す */
  context?: (hitFiles: string[]) => Promise<AssistContext>;
  /** プロンプトキャッシュの振り分けキーに使う(ワークスペースごと) */
  workspaceId: string;
  /** 理由の記録(出力パネルに出す。候補が出ないときに原因を調べられるように) */
  log?: (line: string) => void;
  now?: () => number;
}

/**
 * 続きの候補・置き換え案を作る。同時に1件だけ(新しい書きかけが来たら前の要求を中止)、同じ書きかけの結果は使い回し、
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

  private done(draft: string, result: Completion, detail = ""): Completion {
    this.deps.log?.(
      `${result.kind === "none" ? "出さない" : result.kind === "replace" ? "置き換え案" : "続き"}${result.reason ? `(${result.reason})` : ""} 書きかけ ${draft.length}文字${detail ? ` ${detail}` : ""}${result.text ? ` → ${result.text}` : ""}`,
    );
    return result;
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

  /** 書きかけの続き・置き換え案。失敗しても例外は投げない(入力の邪魔をしない) */
  async complete(draft: string, mode: QuizMode): Promise<Completion> {
    if (meaningfulLength(draft) < MIN_DRAFT_CHARS) {
      return NONE("short");
    }
    if (draft.length > MAX_DRAFT_CHARS || draft.split("\n").length > 10) {
      return this.done(draft, NONE("long"));
    }
    if (looksSecret(draft)) {
      return this.done(draft, NONE("secret"));
    }
    const key = `${mode}\u0000${draft}`;
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    const now = this.now();
    if (now < this.pausedUntil) {
      return NONE("paused");
    }
    while (this.calls.length > 0 && now - this.calls[0]! > 60_000) {
      this.calls.shift();
    }
    if (this.calls.length >= CALLS_PER_MINUTE) {
      return this.done(draft, NONE("rate"));
    }
    this.calls.push(now);

    this.cancel();
    const controller = new AbortController();
    this.inflight = controller;
    const index = this.deps.index();
    try {
      // 書きかけで検索した関連コード(文書は除く)。秘密らしい抜粋は渡さない
      const hits = index?.hasChunks()
        ? index
            .lexicalSearch(draft, LEADS * 3)
            .filter((h) => !/\.(md|mdx|txt|rst)$/i.test(h.chunk.file) && !looksSecret(h.chunk.text))
            .slice(0, LEADS)
        : [];
      const ctx = (await this.deps.context?.([...new Set(hits.map((h) => h.chunk.file))])) ?? {};
      if (ctx.selection && looksSecret(ctx.selection)) {
        ctx.selection = undefined;
      }
      if (controller.signal.aborted) {
        return NONE("aborted");
      }
      const res = await this.deps.llm.chat({
        messages: messagesFor(draft, mode, hits, ctx),
        jsonSchema: SCHEMA,
        signal: controller.signal,
        purpose: "入力の続き・置き換えの候補",
        channel: "assist-auto",
        reasoningEffort: "none",
        cacheKey: `qbs-assist-${sha1(this.deps.workspaceId).slice(0, 12)}`,
        maxOutputTokens: 500,
        retries: 0,
      });
      this.failures = 0;
      const result = this.interpret(draft, res.content, res.finishReason);
      this.cache.set(key, result.result);
      while (this.cache.size > CACHE_SIZE) {
        this.cache.delete(this.cache.keys().next().value!);
      }
      return this.done(draft, result.result, result.detail);
    } catch (error) {
      if (controller.signal.aborted) {
        return NONE("aborted");
      }
      this.pausedUntil = this.now() + PAUSE_MS[Math.min(this.failures++, PAUSE_MS.length - 1)]!;
      return this.done(draft, NONE("error"), `${error instanceof Error ? error.message : String(error)}(${Math.round((this.pausedUntil - this.now()) / 1000)}秒休みます)`);
    } finally {
      if (this.inflight === controller) {
        this.inflight = undefined;
      }
    }
  }

  /** モデルの応答を、出してよい形にする(出さないときは理由つき) */
  private interpret(draft: string, content: string | null, finishReason?: string): { result: Completion; detail: string } {
    if (finishReason === "length") {
      return { result: NONE("truncated"), detail: "" };
    }
    let raw: { kind?: unknown; text?: unknown };
    try {
      raw = parseJson<{ kind?: unknown; text?: unknown }>(content);
    } catch {
      return { result: NONE("unreadable"), detail: "" };
    }
    const text = typeof raw.text === "string" ? raw.text : "";
    if (raw.kind === "replace") {
      const replacement = text.replace(/\s*\n+\s*/g, " ").trim();
      const reason = !looksFinished(draft) ? "unfinished" : rejectReplacement(draft, replacement);
      return reason ? { result: NONE(reason), detail: `置き換え案「${replacement}」` } : { result: { kind: "replace", text: replacement }, detail: "" };
    }
    if (raw.kind === "continue") {
      // 複数行で返ってきたら最初の行を使う(入力欄に1行の続きとして足すため)
      const completion = stripEcho(draft, text).split("\n")[0]!.trimEnd();
      const reason = rejectCompletion(completion);
      return reason ? { result: NONE(reason), detail: `候補「${completion}」` } : { result: { kind: "continue", text: completion }, detail: "" };
    }
    return { result: NONE("none"), detail: "" };
  }
}
