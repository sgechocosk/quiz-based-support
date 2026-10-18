import { detectIntent, type QuizMode } from "./agent";
import type { ChatLlm, ChatMessage, KeyValueStore } from "./ports";
import { WORDING_RULE } from "./level";
import { parseJson, sha1 } from "./text";
import type { SearchHit } from "./types";

/**
 * 入力補助。依頼を書くこと自体の負担(名前を思い出す・何を書けば伝わるかを組み立てる)を減らし、
 * 何をしたいかは利用者が決めたまま、調査と計画にうまく伝わる依頼文にするのを助ける。
 *
 * - 続きの候補: 書きかけの末尾に続く1文を薄い文字で示す(書きかけは変えない)
 * - 書き直し案: 「指示を整える」で、場所・振る舞いなどを補った案と、利用者にしか決められないことの選択肢を示す
 * - 名前の補完: 索引にある関数名・ファイル名を前方一致で補う(API を使わない)
 *
 * Claude Code の「次のプロンプトの予測」に倣い、勧めたい依頼ではなく利用者が書こうとしている続きを予測させ、
 * 外れそうなら出さない。LLM の出力は規則で確かめ(名前は索引に実在するものだけ)、使われなければ出す間隔を延ばす。
 * 固定の部分(指示・構成の地図・最近の依頼)を先頭にそろえて、プロンプトキャッシュに当てる。
 */

/** 入力補助が使う索引の機能(IndexManager が満たす) */
export interface NameSource {
  hasChunks(): boolean;
  lexicalSearch(query: string, k: number): SearchHit[];
  /** exact=false は大文字小文字を区別しない(利用者が書いた名前) */
  knowsWord(word: string, exact?: boolean): boolean;
  hasPath(path: string): boolean;
  completeName(prefix: string, limit?: number): { names: string[]; total: number };
  repoMap(budgetChars: number): string;
  /** 名前が宣言されている場所(パスなら先頭行)。見つからなければ undefined */
  definitionOf(name: string): { path: string; line: number } | undefined;
}

/** 続きの候補を出す最短の長さ(空白を除いた文字数) */
export const MIN_DRAFT_CHARS = 5;
/** 続きの候補の最長(文字数) */
export const MAX_COMPLETION_CHARS = 80;
/** 書き直し案の最長(文字数) */
export const MAX_INSTRUCTION_CHARS = 400;
/** 自動の候補を1分間に呼ぶ上限 */
export const AUTO_CALLS_PER_MINUTE = 10;
/** 自動の候補を求める書きかけの上限(貼り付けたログやコードは送らない) */
export const MAX_AUTO_DRAFT_CHARS = 400;
/** 自動の候補の応答がこれより遅い(直近3回の中央値)なら、推論が止まっていないとみなして止める */
const SLOW_MS = 2500;
/** 候補が表示されたのに使わずに送った依頼がこれだけ続いたら、オフにできることを知らせる(止めるかは利用者が決める) */
const UNUSED_NOTICE = 30;
const REPO_MAP_CHARS = 1800;
const LEADS = 5;
const RECENT = 5;
const CACHE_SIZE = 40;
/** 入力が止まってから候補を求めるまで(ミリ秒)。使われない状態が続くと延ばす */
const DELAY_MS = { normal: 800, slow: 1600, slower: 3000 };
const STORE_KEY = "promptAssist.v1";
const DOC_FILE = /\.(md|mdx|markdown|txt|rst)$/i;

export const MODE_LABEL: Record<QuizMode, string> = {
  auto: "自動で判断",
  read: "仕組みを読み解く",
  change: "変更を組み立てる",
};

/** 空白を除いた文字数 */
export function meaningfulLength(text: string): number {
  return text.replace(/\s+/g, "").length;
}

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
  /\b(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/i,
  /\b[A-Za-z0-9]{40,}\b/,
];

/** API キーなど秘密の情報らしい文字列を含むか(含めば自動では送らない) */
export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

// ---------- 名前の確認 ----------

/** 名前の形をしていても、コードではなく製品名などとしてよく書かれる語(実在の確認をしない) */
const COMMON_NAMES = new Set(
  [
    "openai", "javascript", "typescript", "github", "gitlab", "vscode", "powershell", "postgresql", "mysql", "mongodb",
    "graphql", "websocket", "youtube", "iphone", "ipad", "macos", "ios", "nodejs", "node.js", "next.js", "nuxt.js",
    "vue.js", "react.js", "express.js", "three.js", "d3.js", "chatgpt", "devtools", "localhost",
  ].map((s) => s.toLowerCase()),
);

const FILE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|java|kt|py|go|rs|rb|php|cs|cpp|c|h|hpp|swift|css|scss|html|vue|svelte|ya?ml|toml|sh|sql)$/i;

/** コードの名前らしい語か(camelCase・snake_case・$・パス・a.b の形) */
function isCodeLike(word: string): boolean {
  return /[a-z0-9][A-Z]/.test(word) || /[A-Za-z]_[A-Za-z0-9]|^_/.test(word) || word.includes("$") || word.includes("/") || /[A-Za-z]\.[A-Za-z]/.test(word);
}

/** 文の中のコードの名前(バッククォートの中身と、バッククォートの外のコードらしい語) */
export function codeNames(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    out.add(m[1]!.trim());
  }
  const outside = text.replace(/`[^`\n]*`/g, " ");
  for (const m of outside.matchAll(/[A-Za-z_$][\w$]*(?:[./][A-Za-z_$][\w$-]*)*(?:\(\))?/g)) {
    if (isCodeLike(m[0])) {
      out.add(m[0]);
    }
  }
  return [...out].filter(Boolean);
}

/** 名前の確認に使う索引の機能 */
export type NameCheck = Pick<NameSource, "knowsWord" | "hasPath">;

/** 書き直しで補った(書きかけに無かった)名前と、その定義の場所 */
export function addedNameRefs(instruction: string, draft: string, index: Pick<NameSource, "definitionOf">): Array<{ name: string; path: string; line: number }> {
  const out: Array<{ name: string; path: string; line: number }> = [];
  for (const name of codeNames(instruction)) {
    if (draft.toLowerCase().includes(name.toLowerCase()) || COMMON_NAMES.has(name.toLowerCase())) {
      continue;
    }
    // a.b は最後の部分の宣言を、見つからなければ最初の部分の宣言を探す
    const bare = name.replace(/\(\)$/, "");
    const parts = bare.includes("/") || FILE_EXT.test(bare) ? [bare] : bare.split(".").reverse();
    for (const part of parts) {
      const def = index.definitionOf(part);
      if (def) {
        out.push({ name, ...def });
        break;
      }
    }
  }
  return out.slice(0, 6);
}

/**
 * LLM に渡した文脈(構成の地図・手がかり・書きかけ)に出てくる名前とパス。
 * 候補に入れてよい名前はここにあるものだけにする(索引のどこかにある、では見当違いの名前で調査が引っ張られる)
 */
export function contextNames(...texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
      out.add(m[0]);
    }
    for (const m of text.matchAll(/[\w.$-]+(?:\/[\w.$-]+)+|[\w$-]+\.[A-Za-z0-9]{1,5}\b/g)) {
      out.add(m[0]);
      out.add(m[0].slice(m[0].lastIndexOf("/") + 1));
    }
  }
  return out;
}

/**
 * 名前が索引に実在するか(利用者自身が書いた名前・製品名などは確かめない)。
 * context を渡すと、そこに出てくる名前だけを認める
 */
export function nameExists(name: string, names: NameCheck, draft = "", context?: Set<string>): boolean {
  const bare = name.replace(/\(\)$/, "").replace(/^[@#]/, "").trim();
  if (!bare || draft.toLowerCase().includes(bare.toLowerCase()) || COMMON_NAMES.has(bare.toLowerCase())) {
    return true;
  }
  if (bare.includes("/") || (FILE_EXT.test(bare) && !/\s/.test(bare))) {
    const base = bare.slice(bare.lastIndexOf("/") + 1);
    return names.hasPath(bare) && (!context || context.has(bare) || context.has(base));
  }
  const parts = bare.split(/[^A-Za-z0-9_$]+/).filter((p) => p.length >= 2);
  return parts.every((p) => draft.includes(p) || (names.knowsWord(p) && (!context || context.has(p))));
}

/** 文の中の、索引に無い(context を渡したときは文脈に無い)名前 */
export function unknownNames(text: string, names: NameCheck, draft = "", context?: Set<string>): string[] {
  return codeNames(text).filter((n) => !nameExists(n, names, draft, context));
}

// ---------- 伝わりやすさの要素(API を使わない判定) ----------

/** 変更の依頼で「どうなってほしいか」が書かれているとみなす言い回し(「直したい」だけでは足りない) */
const RESULT_WORDS =
  /ように|になる|になって|にする|にして|にしたい|表示|返す|返る|返して|出す|出る|出して|保存|される|されない|できる|できない|しない|止ま|止め|残す|残る|消え|増え|減|追加|加え|足し|入れ|作り|作成|削除|消し|消す|外し|置き換|分け|まとめ|\b(show|return|save|add|remove|delete|create|rename)\b/i;
/** 読み解きの依頼で「何を知りたいか」が書かれているとみなす言い回し */
const VIEWPOINT_WORDS = /どう|どこ|なぜ|何を|なに|何が|何の|流れ|呼ばれ|呼び出|仕組み|役割|違い|いつ|どの|どんな|理由|意味|使われ|使い方|\b(how|where|why|what|when|which)\b/i;

/** 「〜したい」の形でも、知る・読むための言い回し(読み解きの質問) */
const READ_WISH = /(知り|理解し|読み|読み解き|確認し|調べ|把握し|見)たい/;

/**
 * 書きかけが変更の依頼か読み解きの質問か(進め方が決まっていればそれに従う)。
 * 言い回しの判定(detectIntent)に、「〜を表示したい」のような願いの形を変更の依頼として足したもの
 */
export function draftIntent(draft: string, mode: QuizMode): "read" | "change" {
  if (mode !== "auto") {
    return mode;
  }
  if (detectIntent(draft) === "change") {
    return "change";
  }
  return /(し|って|て)(たい|ほしい|欲しい|ください)/.test(draft) && !READ_WISH.test(draft) ? "change" : "read";
}

/**
 * 依頼文に足すと伝わりやすくなる要素(まだ書かれていないもの)。利用者にしか決められないことだけを挙げる:
 * 変更の依頼は「どうなってほしいか」、読み解きの質問は「知りたいこと」。
 * 場所(関数名・ファイル名)は挙げない(調査が探す。名前を知らない人に思い出す負担を戻さない)
 */
export function missingParts(draft: string, mode: QuizMode): string[] {
  if (draftIntent(draft, mode) === "change") {
    return RESULT_WORDS.test(draft) ? [] : ["どうなってほしいか"];
  }
  return VIEWPOINT_WORDS.test(draft) ? [] : ["知りたいこと(流れ・呼び出し元・データなど)"];
}

// ---------- 続きの候補 ----------

const COMPLETION_SYSTEM = [
  "あなたは VS Code 拡張「コード思考」の入力欄で、利用者が書きかけている依頼の続きを予測する担当です。",
  "利用者はこの入力欄で、コードの仕組みを読み解く質問か、コードの変更の依頼を書きます。依頼が明確だと、このあとの調査と変更の計画がうまく進みます。",
  "",
  "【いちばん大事なこと】",
  "- あなたが勧めたい依頼ではなく、利用者がまさに書こうとしている続きを予測する。基準は「利用者が『ちょうどそう書こうとしていた』と思うか」。",
  "- 書きかけの部分は変えない。completion には、書きかけの末尾にそのままつなげる文字列だけを入れる(書きかけを繰り返さない)。",
  "- 続きが1つに絞れないとき・書きかけから意図が読めないときは、completion を空文字にする。外れた候補を出すより、出さないほうがよい。",
  "",
  "【続きに入れるとよいもの】(書きかけの意図から自然に続く範囲だけ)",
  "- 変更の依頼: どこを(下の【構成】【候補】にある実在の名前)・どうなってほしいか(「〜のとき〜になる」「〜を表示する」など)。",
  "- 読み解きの質問: どの処理の(実在の名前)・何を知りたいか(流れ・呼び出し元・理由・データの形)。問いの形(「〜はどう動く?」)で終えてよい。",
  "- 例: 書きかけ「索引の更新」→ completion「は、ファイルを保存してから `IndexManager.commit` までどう流れる?」",
  "- 例: 書きかけ「APIキーが未設定のとき」→ completion は、【候補】から何をしたいかが読み取れなければ空文字。",
  "",
  "【してはいけないこと】",
  "- 書かれていない要件・機能・数値・仕様を足す(利用者にしか決められないことを決めない)。書きかけに無い条件(「〜とき」「〜以上」)・数値・画面の文言(「」で囲んだ文)・別の依頼(「あわせて〜も」)は足さない。",
  "- 読み解きの質問を変更の依頼に変える・変更の依頼を質問に変える。",
  "- 【構成】【候補】に無い関数名・ファイル名を書く(書きかけにある名前はそのまま使ってよい)。コードの名前はバッククォートで囲む。",
  "- アシスタントの口調(「承知しました」「〜しますね」)・お礼や評価・説明・複数の文・改行・箇条書き。",
  "- 進め方が「仕組みを読み解く」なのに変更の依頼にする/「変更を組み立てる」なのに質問にする。",
  "",
  "【形式】",
  "- completion は60文字以内の1文の続き。文体(です・ます/である/体言止め)と書き方は、書きかけと【最近の依頼】に合わせる。",
  "- intent は、続きを足した依頼が読み解きの質問なら read、変更の依頼なら change、completion が空なら none。",
  "出力は指定の JSON スキーマに厳密に従う。",
].join("\n");

export const COMPLETION_SCHEMA = {
  name: "prompt_completion",
  schema: {
    type: "object",
    properties: {
      completion: { type: "string" },
      intent: { type: "string", enum: ["read", "change", "none"] },
    },
    required: ["completion", "intent"],
    additionalProperties: false,
  },
} as const;

/** 固定に近い文脈(キャッシュに当てるため、書きかけより前に置く) */
function contextMessage(repoMap: string, recent: string[]): string {
  return [
    "【構成(ファイル — 主な名前)】",
    repoMap || "(索引がまだありません)",
    "",
    "【最近の依頼(新しい順。文体を合わせるため)】",
    recent.length > 0 ? recent.map((r) => `- ${r}`).join("\n") : "(まだありません)",
  ].join("\n");
}

/** 書きかけの文で索引を引いた候補(場所と名前だけ。読んだことにはしない) */
export function leadsText(hits: SearchHit[]): string {
  return hits
    .map(({ chunk: c }) => {
      const label = [c.kind, c.symbols.slice(0, 3).join(",")].filter(Boolean).join(" ");
      return `- ${c.file}:${c.startLine}-${c.endLine}${label ? `(${label})` : ""}`;
    })
    .join("\n");
}

function draftMessage(draft: string, mode: QuizMode, leads: string): string {
  return [
    "【候補: 書きかけで検索して見つかった場所(まだ読んでいない)】",
    leads || "(見つかりませんでした)",
    "",
    `【進め方】${MODE_LABEL[mode]}`,
    "【書きかけ】(<<< と >>> の間。前後の空白も書きかけの一部)",
    `<<<${draft}>>>`,
  ].join("\n");
}

/** 続きの候補を作るメッセージ。指示 → 構成と最近の依頼 → 候補と書きかけ の順(先頭ほど変わらない) */
export function completionMessages(draft: string, mode: QuizMode, ctx: { repoMap: string; recent: string[]; leads: string }): ChatMessage[] {
  return [
    { role: "system", content: COMPLETION_SYSTEM },
    { role: "user", content: contextMessage(ctx.repoMap, ctx.recent) },
    { role: "user", content: draftMessage(draft, mode, ctx.leads) },
  ];
}

/** モデルが書きかけを繰り返した部分を除き、つなぎ目の空白を整える */
export function stripEcho(draft: string, completion: string): string {
  let c = completion.replace(/\r/g, "");
  const d = draft.trimEnd();
  if (d && c.startsWith(d)) {
    c = c.slice(d.length);
  } else {
    // 書きかけの末尾をそのまま繰り返した(3文字以下の重なりは偶然の一致がありうるので残す)
    for (let k = Math.min(d.length, c.length); k >= 4; k--) {
      if (d.endsWith(c.slice(0, k))) {
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

/** 書きかけがすでに示している依頼の種類(問いのしるし・依頼の言い回しが無ければ undefined) */
function shownIntent(draft: string): "read" | "change" | undefined {
  if (draftIntent(draft, "auto") === "change") {
    return "change";
  }
  return /[?？]|どう|なぜ|どこ|何を|なに|いつ|どの|どんな/.test(draft) || READ_WISH.test(draft) ? "read" : undefined;
}

/** 候補が、書きかけ(または進め方)の示す依頼の種類を逆にするか */
function flipsIntent(draft: string, completion: string, mode: QuizMode): boolean {
  const before = mode === "auto" ? shownIntent(draft) : mode;
  return before !== undefined && draftIntent(draft + completion, "auto") !== before;
}

/** 別の依頼を足す言い回し */
const EXTRA_REQUEST = /も追加|あわせて|合わせて|ついでに|それから|さらに|加えて|\band also\b/;
/** 条件を足す言い回し(書きかけに無い条件は、利用者が決めることなので足さない) */
const CONDITION_WORDS = /とき|時に|場合|たら|以上|以下|未満|超え|ごとに|たびに/g;

/** 書きかけに無い言い回しを候補が足しているか */
function newWords(re: RegExp, draft: string, completion: string): boolean {
  const before = new Set(draft.match(re) ?? []);
  return (completion.match(re) ?? []).some((w) => !before.has(w));
}

/** 書きかけに無い数値を候補が足しているか(コードの名前の中の数字は除く) */
function newNumbers(draft: string, completion: string): boolean {
  const plain = completion.replace(/`[^`]*`/g, " ").replace(/[A-Za-z_$][\w$]*/g, " ");
  const toAscii = (t: string) => t.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  const known = new Set(toAscii(draft).match(/\d+/g) ?? []);
  return (toAscii(plain).match(/\d+/g) ?? []).some((n) => !known.has(n));
}

/**
 * 続きの候補を出さない理由(出してよければ undefined)。
 * Claude Code の後処理(メタ文・アシスタント口調・評価・複数の文・書式などを捨てる)に、この拡張機能向けの規則を足したもの。
 * - 読み解きは問いの形でよい(変更の依頼に問いは付けない)
 * - 利用者の意図を変えない: 依頼の種類を逆にする・別の依頼を足す・書きかけに無い条件や数値や文言を足す候補は捨てる
 * - 名前は索引に実在するものだけ(利用者が書いた名前は確かめない)
 */
export function rejectCompletion(
  draft: string,
  completion: string,
  mode: QuizMode,
  names: NameCheck,
  context?: Set<string>,
): string | undefined {
  const c = completion;
  const checks: Array<[string, () => boolean]> = [
    ["empty", () => meaningfulLength(c) === 0],
    ["multiline", () => /\n/.test(c)],
    ["too_long", () => c.length > MAX_COMPLETION_CHARS],
    ["formatting", () => /```|\*\*|^\s*([-*•#>]|\d+\.)\s/.test(c)],
    ["placeholder", () => /[〔〕]/.test(c)],
    [
      "meta",
      () =>
        /^[\s(（「『]*(なし|特になし|提案なし|候補なし|提案はありません|候補はありません|ありません|続きはありません|n\/a|none|null|nothing|no suggestion)[\s)）」』。.]*$/i.test(c),
    ],
    ["wrapped", () => /^\s*([(（[【「『]).*([)）\]】」』])\s*$/.test(c) && meaningfulLength(c) > 2],
    ["assistant_voice", () => /^\s*(承知|かしこまり|了解しました|以下|こちらは|では、|let me|i'll|i will|here is|here's|sure[,!])/i.test(c) || /しますね[。!！]?$/.test(c)],
    ["evaluative", () => /ありがとう|助かりました|いいですね|良さそう|よさそう|素晴らしい|完璧です|thanks|thank you|looks good/i.test(c)],
    ["multiple_sentences", () => /[。！？!?]\s*[^\s。！？!?)）」』]/.test(c)],
    ["question_in_change", () => mode === "change" && /[?？]\s*$/.test(c)],
    ["intent_flip", () => flipsIntent(draft, c, mode)],
    ["extra_request", () => EXTRA_REQUEST.test(c) && !EXTRA_REQUEST.test(draft)],
    ["new_condition", () => newWords(CONDITION_WORDS, draft, c)],
    ["new_number", () => newNumbers(draft, c)],
    ["new_quote", () => (c.match(/「[^」]+」|"[^"]+"|“[^”]+”/g) ?? []).some((q) => !draft.includes(q.slice(1, -1)))],
    ["unknown_name", () => unknownNames(c, names, draft, context).length > 0],
  ];
  for (const [reason, test] of checks) {
    if (test()) {
      return reason;
    }
  }
  return undefined;
}

// ---------- 書き直し案(指示を整える) ----------

export type PartKind = "location" | "behavior" | "condition" | "scope" | "target" | "viewpoint";

export const PART_LABEL: Record<PartKind, string> = {
  location: "場所",
  behavior: "どうなってほしいか",
  condition: "どんなとき",
  scope: "変えないもの",
  target: "対象",
  viewpoint: "知りたいこと",
};

export interface RefineOption {
  label: string;
  /** 〔…〕に入る文 */
  fill: string;
}

export interface RefineQuestion {
  /** 書き直し案の中の「〔…〕」(そのまま) */
  slot: string;
  question: string;
  options: RefineOption[];
}

export interface RefineProposal {
  instruction: string;
  intent: "read" | "change";
  /** 補った・はっきりさせた要素(text は instruction の一部) */
  parts: Array<{ kind: PartKind; text: string }>;
  /** 利用者にしか決められないこと(0〜2問) */
  questions: RefineQuestion[];
  /** 確かめてもコードに見つからなかった名前(作り直しても残ったもの) */
  unknownNames: string[];
  /** 書き直しで補った名前と、その定義の場所(利用者が開いて確かめられるように) */
  nameRefs: Array<{ name: string; path: string; line: number }>;
}

const REFINE_SYSTEM = [
  "あなたは VS Code 拡張「コード思考」で、利用者が書いた依頼を、調査と変更の計画にそのまま使える明確な依頼に整える担当です。",
  "利用者は依頼を書くこと自体に負担を感じています。何をしたいかを決めるのは利用者で、あなたはそれが伝わる形に整えるだけです。",
  "あなたはまだコードを読んでいません(【構成】【候補】は名前と場所の一覧です)。コードを読まないと決められないことは、このあとの調査と要件の確認で決まります。",
  "",
  "【いちばん大事なこと】",
  "- 利用者の意図を変えない。書かれていない要件・機能を足さない。利用者の言葉はできるだけ残し、書き換えるより足すことを優先する。",
  "- コードから分かる場所・名前は、【構成】【候補】にある実在の名前で補う(書きかけにある名前はそのまま使う)。コードの名前はバッククォートで囲む。",
  "- 利用者にしか決められないこと(何のためか・どうなってほしいか・変えたくないもの・読み解きで知りたいこと)が書かれていなければ、決めずに",
  "  instruction の中に「〔決めること〕」の形で空けておき、questions で選択肢を示す。数値・画面の文言(「」で囲む文)も、書きかけに無ければ〔 〕にする。",
  "- 置き場所・既存の仕組みを広げるか新しく作るか、などの実装の方針は質問しない(調べたあとの要件の確認で決める)。",
  "",
  "【整えた依頼に入れるもの】",
  "- 変更の依頼: どうなってほしいか(中心。「〜のとき〜になる」の形が分かりやすい)/ 場所(【構成】【候補】の名前のうち、依頼との関係がはっきりしているものだけ。分からなければ足さない)/",
  "  変えないもの(書かれていれば。名前ではなく振る舞いで書く)。結びは「〜ようにしたい」「〜を追加したい」「〜に変えたい」のような形にする。",
  "- 読み解きの質問: 対象 / 知りたいこと(流れ・呼び出し元・データの形・条件)。問いの形(「〜はどう動く?」など)で終え、「追加」「変更」「修正」「〜したい」は使わない。",
  "  読み解きの質問で〔 〕を使うときは、文の末尾に「(特に〔知りたいこと〕)」のような補足として置き、〔 〕ごと除いても文が成り立つようにする(答えなければ除いて、流れ・呼び出し元を中心に調べる)。",
  "- 書きかけが短すぎて何をしたいか読めないときは、instruction を「〔したいこと〕」を含む形にし、何をしたいかを選ぶ質問を1つ出す",
  "  (選択肢は【構成】【候補】の実在の処理に沿って、読み解きの質問と変更の依頼の両方を含める)。",
  "- 見出しやラベル(「場所:」など)を付けない地の文にする。名前は宣言どおりの英数字で書く(カタカナにしたり、単語に分けたりしない)。",
  "",
  "【出力】",
  "- instruction: 1〜3文。改行・箇条書きなし。400文字以内。利用者自身の言葉として書く(呼びかけ・説明は入れない)。",
  "- intent: 読み解きの質問なら read、変更の依頼なら change。",
  "- parts: 補った・はっきりさせた要素ごとに、kind(location=場所 / behavior=どうなってほしいか / condition=どんなとき / scope=変えないもの / target=対象 / viewpoint=知りたいこと)と、",
  "  text(instruction の該当部分をそのまま抜き出したもの)。元の依頼にすでにあった要素は入れない。",
  "- questions: 0〜2問。slot は instruction の中の「〔…〕」をそのまま、question は短い問い、options は2〜4個",
  "  (label: 短い案の名前、fill: 〔…〕の代わりに入る文)。どれが良いかは利用者が決めるので、おすすめは付けない。",
  `- question と label の言葉づかい: ${WORDING_RULE}`,
  "出力は指定の JSON スキーマに厳密に従う。",
].join("\n");

export const REFINE_SCHEMA = {
  name: "prompt_refine",
  schema: {
    type: "object",
    properties: {
      instruction: { type: "string" },
      intent: { type: "string", enum: ["read", "change"] },
      parts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["location", "behavior", "condition", "scope", "target", "viewpoint"] },
            text: { type: "string" },
          },
          required: ["kind", "text"],
          additionalProperties: false,
        },
      },
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            slot: { type: "string" },
            question: { type: "string" },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  fill: { type: "string" },
                },
                required: ["label", "fill"],
                additionalProperties: false,
              },
            },
          },
          required: ["slot", "question", "options"],
          additionalProperties: false,
        },
      },
    },
    required: ["instruction", "intent", "parts", "questions"],
    additionalProperties: false,
  },
} as const;

export function refineMessages(draft: string, mode: QuizMode, ctx: { repoMap: string; recent: string[]; leads: string }): ChatMessage[] {
  return [
    { role: "system", content: REFINE_SYSTEM },
    { role: "user", content: contextMessage(ctx.repoMap, ctx.recent) },
    { role: "user", content: draftMessage(draft, mode, ctx.leads) },
  ];
}

interface RawRefine {
  instruction?: unknown;
  intent?: unknown;
  parts?: Array<{ kind?: unknown; text?: unknown }>;
  questions?: Array<{ slot?: unknown; question?: unknown; options?: Array<{ label?: unknown; fill?: unknown }> }>;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** 書き直し案を確かめる。problems があれば作り直させる(名前の誤りなど) */
export function parseRefine(
  raw: RawRefine | undefined,
  draft: string,
  mode: QuizMode,
  names: NameCheck,
  context?: Set<string>,
): { proposal?: RefineProposal; problems: string[] } {
  const instruction = str(raw?.instruction).replace(/\s*\n+\s*/g, " ");
  if (!instruction) {
    return { problems: ["instruction が空です。"] };
  }
  const problems: string[] = [];
  if (instruction.length > MAX_INSTRUCTION_CHARS) {
    problems.push(`instruction が長すぎます(${instruction.length}文字)。${MAX_INSTRUCTION_CHARS}文字以内にしてください。`);
  }
  if (newNumbers(draft, instruction)) {
    problems.push("書きかけに無い数値が入っています。利用者が決めることなので「〔…〕」にして questions で尋ねてください。");
  }
  const unknown = unknownNames(instruction, names, draft, context);
  if (unknown.length > 0) {
    problems.push(`コードに無い名前があります: ${unknown.join(", ")}。【構成】【候補】にある実在の名前に直すか、名前を使わずに書いてください。`);
  }
  const intent = raw?.intent === "read" || raw?.intent === "change" ? raw.intent : draftIntent(instruction, mode);
  const kinds = new Set<string>(Object.keys(PART_LABEL));
  const seen = new Set<string>();
  const parts = (raw?.parts ?? [])
    .map((p) => ({ kind: str(p?.kind), text: str(p?.text) }))
    .filter((p) => kinds.has(p.kind) && p.text && instruction.includes(p.text) && !seen.has(p.kind + p.text) && seen.add(p.kind + p.text))
    .slice(0, 6) as RefineProposal["parts"];
  const questions: RefineQuestion[] = [];
  for (const q of raw?.questions ?? []) {
    const slot = str(q?.slot);
    const question = str(q?.question);
    // 〔…〕が案の中にちょうど1つあるものだけ(選んだ案で置き換えるため)
    if (!/^〔[^〔〕]+〕$/.test(slot) || instruction.split(slot).length !== 2 || !question || questions.some((x) => x.slot === slot)) {
      continue;
    }
    const options = (q?.options ?? [])
      .map((o) => ({ label: str(o?.label), fill: str(o?.fill).replace(/\s*\n+\s*/g, " ") }))
      .filter((o, i, all) => o.label && o.fill && !/[〔〕]/.test(o.fill) && all.findIndex((x) => x.fill === o.fill) === i)
      .slice(0, 4);
    if (options.length >= 2) {
      questions.push({ slot, question, options });
    }
    if (questions.length >= 2) {
      break;
    }
  }
  if (mode === "read" && intent === "change") {
    problems.push("進め方は「仕組みを読み解く」です。変更の依頼ではなく、読み解きの質問に整えてください。");
  } else if (mode === "change" && intent === "read") {
    problems.push("進め方は「変更を組み立てる」です。質問ではなく、変更の依頼に整えてください。");
  } else if (intent === "change" && detectIntent(instruction.replace(/〔[^〔〕]*〕/g, "")) !== "change") {
    // 送った後の意図の判定(Decisions API が使えないときは言い回し)に、変更の依頼として伝わる結びにする
    problems.push("変更の依頼として伝わるよう、「〜ようにしたい」「〜を追加したい」「〜に変えたい」のような結びにしてください。");
  } else if (intent === "read" && detectIntent(instruction.replace(/〔[^〔〕]*〕/g, "")) === "change") {
    problems.push("読み解きの質問に、変更の依頼と受け取られる言い回し(追加・変更・修正・〜したい など)が入っています。問いの形(「〜はどう動く?」)にしてください。");
  }
  return { proposal: { instruction, intent, parts, questions, unknownNames: unknown, nameRefs: [] }, problems };
}

// ---------- 状態(結果の記憶・間隔・記録) ----------

export type CompletionOutcome = {
  /** 書きかけに続ける文字列(出さないときは空文字) */
  completion: string;
  /** 出さなかった理由 */
  reason?: string;
  /** 足すと伝わりやすくなる要素(続きの候補が無いときに示す) */
  missing: string[];
};

/** 入力補助の記録(このワークスペースだけ。テストモードで見られる) */
export interface AssistStats {
  /** 続きの候補を表示した回数 */
  shown: number;
  /** 続きの候補を使った回数(全部・一部) */
  accepted: number;
  /** 書き直し案を求めた回数・入力欄に入れた回数 */
  refined: number;
  refineUsed: number;
  /** 名前の補完を使った回数 */
  names: number;
  /** 送った依頼の数・そのうち入力補助(候補か書き直し案)を使ったもの */
  sends: number;
  assistedSends: number;
  /** 索引に実在する名前を含んでいた依頼(補助あり/なし) */
  namedAssisted: number;
  namedUnassisted: number;
  /** 調査で関連するコードが見つからずに終わった依頼(補助あり/なし) */
  notFoundAssisted: number;
  notFoundUnassisted: number;
  /** 実装の依頼で、要件の確認(質問)を挟んだ数(補助あり/なし) */
  clarifiedAssisted: number;
  clarifiedUnassisted: number;
  /** 調べた依頼の数と、調査のツール呼び出しの合計(補助あり/なし) */
  investigatedAssisted: number;
  investigatedUnassisted: number;
  stepsAssisted: number;
  stepsUnassisted: number;
  /** 抑止の理由ごとの回数 */
  suppressed: Record<string, number>;
}

interface StoredState {
  recent: string[];
  /** 候補が表示されたのに使わずに送った依頼が続いた数(使えば 0 に戻す) */
  unusedStreak: number;
  stats: AssistStats;
}

/** 続きの候補を止めている理由(このセッションだけ。設定・API キーが変わると戻す) */
export type AutoBlock = "config" | "slow";

function emptyStats(): AssistStats {
  return {
    shown: 0,
    accepted: 0,
    refined: 0,
    refineUsed: 0,
    names: 0,
    sends: 0,
    assistedSends: 0,
    namedAssisted: 0,
    namedUnassisted: 0,
    notFoundAssisted: 0,
    notFoundUnassisted: 0,
    clarifiedAssisted: 0,
    clarifiedUnassisted: 0,
    investigatedAssisted: 0,
    investigatedUnassisted: 0,
    stepsAssisted: 0,
    stepsUnassisted: 0,
    suppressed: {},
  };
}

/** 送った依頼で、入力補助をどう使ったか(webview が数える) */
export interface SendAssist {
  /** 続きの候補を表示した回数 */
  shown: number;
  /** 続きの候補を使った回数 */
  accepted: number;
  /** 書き直し案を入力欄に入れたか */
  refined: boolean;
}

export interface AssistantDeps {
  llm: ChatLlm;
  /** 索引(まだ無ければ undefined) */
  index: () => NameSource | undefined;
  store: KeyValueStore;
  /** プロンプトキャッシュの振り分けキーに使う(ワークスペースごと) */
  workspaceId: string;
  now?: () => number;
}

/**
 * 入力補助の本体(VS Code に依存しない)。
 * 自動の候補は同時に1件だけ(新しい書きかけが来たら前の要求を中止)、同じ書きかけの結果は覚えて使い回し、1分間の回数に上限を置く。
 */
export class PromptAssistant {
  private readonly cache = new Map<string, CompletionOutcome>();
  private readonly calls: number[] = [];
  private inflight?: AbortController;
  /** 最後に送った依頼(調査・要件の整理の結果を結びつける) */
  private lastSend?: { query: string; assisted: boolean };
  /** このセッションで続きの候補を止めた理由(設定・API キーが変わるまで) */
  private stopped?: "config" | "slow";
  /** 混み合い・通信の失敗で、この時刻まで呼ばない */
  private pausedUntil = 0;
  private failures = 0;
  /** 直近の応答時間(ミリ秒) */
  private readonly durations: number[] = [];
  /** 候補を表示できなかった自動の呼び出しが続いた数 */
  private callsWithoutShow = 0;

  constructor(private readonly deps: AssistantDeps) {}

  private get cacheKey(): string {
    return `qbs-assist-${sha1(this.deps.workspaceId).slice(0, 12)}`;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private load(): StoredState {
    const s = this.deps.store.get<Partial<StoredState>>(STORE_KEY);
    return {
      recent: Array.isArray(s?.recent) ? s.recent.filter((r) => typeof r === "string").slice(0, RECENT) : [],
      unusedStreak: Number.isFinite(s?.unusedStreak) ? Number(s!.unusedStreak) : 0,
      stats: { ...emptyStats(), ...(s?.stats ?? {}), suppressed: { ...(s?.stats?.suppressed ?? {}) } },
    };
  }

  private save(state: StoredState): void {
    void this.deps.store.update(STORE_KEY, state);
  }

  private update(change: (state: StoredState) => void): void {
    const state = this.load();
    change(state);
    this.save(state);
  }

  stats(): AssistStats {
    return this.load().stats;
  }

  /** 入力が止まってから候補を求めるまでの時間。候補を出せない・使われない状態が続いたら延ばす(使えば戻す) */
  delayMs(): number {
    const streak = this.load().unusedStreak;
    return streak >= 20 ? DELAY_MS.slower : streak >= 10 || this.callsWithoutShow >= 20 ? DELAY_MS.slow : DELAY_MS.normal;
  }

  /** 続きの候補を止めているか(止めていれば理由)。混み合いでの一時的な休止は含めない */
  autoBlock(): AutoBlock | undefined {
    return this.stopped;
  }

  /**
   * 候補が使われない状態が続いているか。続きの候補を止めるかは利用者が決める(既定オン・オフは設定から)ので、
   * システムは止めずに間隔を延ばし、オフにできることを知らせるだけにする
   */
  rarelyUsed(): boolean {
    return this.load().unusedStreak >= UNUSED_NOTICE;
  }

  /** 設定・API キーが変わったとき: 失敗や遅さで止めた続きの候補を戻す。fromToggle なら、使われなかった数も数え直す */
  resetPause(fromToggle = false): void {
    this.stopped = undefined;
    this.pausedUntil = 0;
    this.failures = 0;
    this.durations.length = 0;
    this.callsWithoutShow = 0;
    if (fromToggle) {
      this.update((s) => {
        s.unusedStreak = 0;
      });
    }
  }

  private onSuccess(ms: number): void {
    this.failures = 0;
    this.pausedUntil = 0;
    this.durations.push(ms);
    if (this.durations.length > 3) {
      this.durations.shift();
    }
    const sorted = [...this.durations].sort((a, b) => a - b);
    if (sorted.length === 3 && sorted[1]! > SLOW_MS) {
      this.stopped = "slow";
    }
  }

  private onFailure(error: unknown): void {
    const status = (error as { status?: unknown } | undefined)?.status;
    if (status === 400 || status === 401 || status === 403 || status === 404) {
      // 設定(モデル名・ベースURL・引数)か API キーの問題: 変わるまで呼ばない
      this.stopped = "config";
      return;
    }
    this.failures++;
    this.pausedUntil = this.now() + [60_000, 120_000, 300_000][Math.min(this.failures - 1, 2)]!;
  }

  private context(index: NameSource | undefined, draft: string): { repoMap: string; recent: string[]; leads: string; names: Set<string> } {
    const repoMap = index?.repoMap(REPO_MAP_CHARS) ?? "";
    // 手がかりから文書(README・CHANGELOG など)を除く。日本語の書きかけでは文書が上位を占め、名前の手がかりにならない
    const hits = index?.hasChunks() ? index.lexicalSearch(draft, LEADS * 3).filter((h) => !DOC_FILE.test(h.chunk.file)).slice(0, LEADS) : [];
    const leads = leadsText(hits);
    return { repoMap, recent: this.load().recent, leads, names: contextNames(repoMap, leads, draft) };
  }

  private suppress(reason: string, missing: string[] = []): CompletionOutcome {
    this.update((s) => {
      s.stats.suppressed[reason] = (s.stats.suppressed[reason] ?? 0) + 1;
    });
    return { completion: "", reason, missing };
  }

  /** 名前の補完(API を使わない) */
  completeName(prefix: string): { names: string[]; total: number } {
    const index = this.deps.index();
    if (!index || prefix.length < 3) {
      return { names: [], total: 0 };
    }
    return index.completeName(prefix, 5);
  }

  /** 前の自動の候補の要求を中止する(入力が変わった・送信した) */
  cancel(): void {
    this.inflight?.abort();
    this.inflight = undefined;
  }

  /**
   * 書きかけの続きの候補(自動)。出さないときは completion を空にし、reason と、足すと伝わりやすくなる要素を返す。
   * 失敗しても例外は投げない(入力の邪魔をしない)。
   */
  async complete(draft: string, mode: QuizMode): Promise<CompletionOutcome> {
    const index = this.deps.index();
    if (!index) {
      // 索引ができるまでは名前を確かめられないので呼ばない
      return { completion: "", reason: "no_index", missing: [] };
    }
    const names = index;
    const missing = missingParts(draft, mode);
    if (meaningfulLength(draft) < MIN_DRAFT_CHARS) {
      return { completion: "", reason: "short", missing: [] };
    }
    const block = this.autoBlock();
    if (block) {
      return { completion: "", reason: block, missing };
    }
    if (this.now() < this.pausedUntil) {
      return { completion: "", reason: "paused", missing };
    }
    if (draft.length > MAX_AUTO_DRAFT_CHARS || draft.split("\n").length > 3) {
      return this.suppress("long", missing);
    }
    if (looksSecret(draft)) {
      return this.suppress("secret", missing);
    }
    const key = `${mode}\u0000${draft}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const now = this.now();
    while (this.calls.length > 0 && now - this.calls[0]! > 60_000) {
      this.calls.shift();
    }
    if (this.calls.length >= AUTO_CALLS_PER_MINUTE) {
      return this.suppress("rate", missing);
    }
    this.calls.push(now);

    this.cancel();
    const controller = new AbortController();
    this.inflight = controller;
    let outcome: CompletionOutcome;
    const started = this.now();
    try {
      const ctx = this.context(index, draft);
      const res = await this.deps.llm.chat({
        messages: completionMessages(draft, mode, ctx),
        jsonSchema: COMPLETION_SCHEMA,
        signal: controller.signal,
        purpose: "入力の続きの候補",
        channel: "assist-auto",
        reasoningEffort: "none",
        cacheKey: this.cacheKey,
        maxOutputTokens: 200,
        retries: 0,
      });
      this.onSuccess(this.now() - started);
      const raw = parseJson<{ completion?: unknown }>(res.content);
      const completion = stripEcho(draft, typeof raw.completion === "string" ? raw.completion : "");
      const reason = res.finishReason === "length" ? "truncated" : rejectCompletion(draft, completion, mode, names, ctx.names);
      outcome = reason ? this.suppress(reason, missing) : { completion, missing };
      this.callsWithoutShow = outcome.completion ? 0 : this.callsWithoutShow + 1;
    } catch (error) {
      if (controller.signal.aborted) {
        return { completion: "", reason: "aborted", missing: [] };
      }
      // 失敗(互換エンドポイントの非対応・ネットワーク・読めない応答)は、候補を出さないだけにする。続けば止める
      if (!(error instanceof SyntaxError)) {
        this.onFailure(error);
      }
      return this.suppress("error", missing);
    } finally {
      if (this.inflight === controller) {
        this.inflight = undefined;
      }
    }
    this.cache.set(key, outcome);
    while (this.cache.size > CACHE_SIZE) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    return outcome;
  }

  /** 書き直し案(利用者の操作で呼ぶ)。名前の誤りなどがあれば1回だけ作り直させる。作れなければ例外 */
  async refine(draft: string, mode: QuizMode, signal?: AbortSignal): Promise<RefineProposal> {
    const index = this.deps.index();
    // 索引が無い間は名前を確かめられないので、コードの名前はすべて「見つからなかった名前」として示す
    const names: NameCheck = index ?? { knowsWord: () => false, hasPath: () => false };
    this.update((s) => {
      s.stats.refined++;
    });
    const ctx = this.context(index, draft);
    const messages = refineMessages(draft, mode, ctx);
    let last: RefineProposal | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.deps.llm.chat({
        messages,
        jsonSchema: REFINE_SCHEMA,
        signal,
        purpose: attempt === 0 ? "依頼を整える" : "依頼を整える(作り直し)",
        channel: "assist",
        reasoningEffort: "low",
        cacheKey: this.cacheKey,
        retries: 1,
      });
      let raw: RawRefine | undefined;
      try {
        raw = parseJson<RawRefine>(res.content);
      } catch {
        raw = undefined;
      }
      const { proposal, problems } = parseRefine(raw, draft, mode, names, index ? ctx.names : undefined);
      if (proposal && index) {
        proposal.nameRefs = addedNameRefs(proposal.instruction, draft, index);
      }
      if (proposal && !index) {
        return proposal;
      }
      if (proposal) {
        last = proposal;
      }
      if (proposal && problems.length === 0) {
        return proposal;
      }
      messages.push(
        { role: "assistant", content: res.content ?? "" },
        { role: "user", content: `次の点を直して、同じ形式で出し直してください。\n${(problems.length > 0 ? problems : ["JSON として読めませんでした。"]).map((p) => `- ${p}`).join("\n")}` },
      );
    }
    if (!last) {
      throw new Error("依頼を整えられませんでした。もう一度試すか、そのまま送ってください。");
    }
    return last;
  }

  /** 送った依頼を記録する(最近の依頼・使われ方・間隔) */
  recordSend(query: string, assist: SendAssist): void {
    const assisted = assist.accepted > 0 || assist.refined;
    const index = this.deps.index();
    const named = !!index && codeNames(query).some((n) => nameExists(n, index));
    this.cancel();
    this.lastSend = { query, assisted };
    this.update((s) => {
      if (named) {
        if (assisted) {
          s.stats.namedAssisted++;
        } else {
          s.stats.namedUnassisted++;
        }
      }
      // 秘密の情報らしい依頼は、次の候補の文脈に入れない
      if (!looksSecret(query)) {
        s.recent = [query.slice(0, 200), ...s.recent.filter((r) => r !== query.slice(0, 200))].slice(0, RECENT);
      }
      s.stats.sends++;
      if (assisted) {
        s.stats.assistedSends++;
      }
      s.stats.shown += Math.max(0, assist.shown);
      s.stats.accepted += Math.max(0, assist.accepted);
      if (assist.refined) {
        s.stats.refineUsed++;
      }
      if (assisted) {
        s.unusedStreak = 0;
      } else if (assist.shown > 0) {
        // 候補が表示されたのに使わなかった依頼だけを数える(表示が無かった依頼は数えない)
        s.unusedStreak++;
      }
    });
  }

  recordNameAccepted(): void {
    this.update((s) => {
      s.stats.names++;
    });
  }

  /** 送った依頼の調査・要件の整理の結果(補助を使った依頼と使わなかった依頼を比べるため) */
  recordResult(query: string, result: { steps?: number; clarified?: boolean; notFound?: boolean }): void {
    const send = this.lastSend;
    if (!send || send.query !== query) {
      return;
    }
    this.update((s) => {
      if (result.steps !== undefined) {
        if (send.assisted) {
          s.stats.investigatedAssisted++;
          s.stats.stepsAssisted += result.steps;
        } else {
          s.stats.investigatedUnassisted++;
          s.stats.stepsUnassisted += result.steps;
        }
      }
      if (result.clarified) {
        if (send.assisted) {
          s.stats.clarifiedAssisted++;
        } else {
          s.stats.clarifiedUnassisted++;
        }
      }
      if (result.notFound) {
        if (send.assisted) {
          s.stats.notFoundAssisted++;
        } else {
          s.stats.notFoundUnassisted++;
        }
      }
    });
  }

  reset(): void {
    this.cache.clear();
    this.resetPause();
    this.save({ recent: [], unusedStreak: 0, stats: emptyStats() });
  }
}
