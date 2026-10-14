/**
 * 言語サーバの参照検索では見えない結合を見つける。
 * - 文字列のキー(メッセージの種類・設定キー・イベント名など)でつながっている場所
 * - 過去のコミットで一緒に変更されてきたファイル(ROSE: Zimmermann et al., ICSE 2004 の考え方)
 */

/** 文字列のキーと、それが書かれている文脈(同じ文脈の別のキーは「同じ種類のキー」とみなす) */
export interface KeyLiteral {
  literal: string;
  /** 例: "prop:type"(type: "..." の値)/ "case" / "cmp" / "call:get" / "key"(JSON等のキー) */
  context: string;
}

/** キーとして扱わない、ありふれた文字列(typeof の結果・文字コード名など) */
const COMMON_LITERALS = new Set([
  "string", "number", "boolean", "object", "function", "undefined", "symbol", "bigint",
  "utf8", "utf-8", "ascii", "base64", "hex", "true", "false", "null", "default", "auto", "none",
  "GET", "POST", "PUT", "DELETE", "div", "span", "button", "input", "click", "change", "keydown", "message",
]);

/** 引用符(q)で囲まれたキー(lit)。同じ種類の引用符で閉じたものだけ */
const LITERAL = String.raw`(?<q>["'\x60])(?<lit>[A-Za-z_][\w.:/-]{1,63})\k<q>`;
const PATTERNS: Array<{ re: RegExp; context: (m: RegExpMatchArray) => string }> = [
  // case "quiz":
  { re: new RegExp(String.raw`\bcase\s+${LITERAL}\s*:`, "g"), context: () => "case" },
  // type: "quiz"(オブジェクトの値)
  { re: new RegExp(String.raw`(?<name>[A-Za-z_$][\w$]*)\s*:\s*${LITERAL}`, "g"), context: (m) => `prop:${m.groups!.name}` },
  // "quizSupport.model": ...(JSON・オブジェクトのキー。三項演算子の "a" : "b" は除く)
  { re: new RegExp(String.raw`(?:^|[{,])\s*${LITERAL}\s*:(?!:)`, "g"), context: () => "key" },
  // x === "quiz" / "quiz" === x
  { re: new RegExp(String.raw`(?:===|!==|==|!=)\s*${LITERAL}`, "g"), context: () => "cmp" },
  { re: new RegExp(String.raw`${LITERAL}\s*(?:===|!==|==|!=)`, "g"), context: () => "cmp" },
  // get<string>("model", ...) / executeCommand("quiz-based-support.setApiKey")
  {
    re: new RegExp(String.raw`(?<name>[A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\(\s*${LITERAL}`, "g"),
    context: (m) => `call:${m.groups!.name}`,
  },
];

/** キーらしい文字列か(空白なし・3文字以上・ありふれた語でない・パスや URL でない) */
function isKeyLike(literal: string): boolean {
  return (
    literal.length >= 3 &&
    !COMMON_LITERALS.has(literal) &&
    !literal.startsWith("./") &&
    !literal.startsWith("../") &&
    !/^https?:/.test(literal) &&
    !/\.(?:ts|tsx|js|jsx|json|css|html|md|java|png|svg|wasm)$/.test(literal)
  );
}

/** 1行から、キーの位置にある文字列を拾う(import の指定子などは対象外) */
export function keyLiterals(line: string): KeyLiteral[] {
  if (/^\s*(?:import|export\s+\*|export\s+\{[^}]*\}\s+from)\b/.test(line) || /\brequire\s*\(/.test(line)) {
    return [];
  }
  const out: KeyLiteral[] = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of line.matchAll(p.re)) {
      const literal = m.groups!.lit!;
      if (isKeyLike(literal) && !out.some((o) => o.literal === literal)) {
        out.push({ literal, context: p.context(m) });
      }
    }
  }
  return out;
}

/** 複数行のキーを、文字列ごとに1つにまとめて返す */
export function keyLiteralsOf(lines: string[]): KeyLiteral[] {
  const out: KeyLiteral[] = [];
  for (const line of lines) {
    for (const k of keyLiterals(line)) {
      if (!out.some((o) => o.literal === k.literal)) {
        out.push(k);
      }
    }
  }
  return out;
}

/** before → after で、新しく現れたキーと消えたキー */
export function keyDelta(beforeLines: string[], afterLines: string[]): { added: KeyLiteral[]; removed: KeyLiteral[] } {
  const before = keyLiteralsOf(beforeLines);
  const after = keyLiteralsOf(afterLines);
  return {
    added: after.filter((a) => !before.some((b) => b.literal === a.literal)),
    removed: before.filter((b) => !after.some((a) => a.literal === b.literal)),
  };
}

/** text の中で、context が同じ別のキー(= 同じ種類のキー)を出現順に返す */
export function siblingKeys(text: string, key: KeyLiteral, limit = 3): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const k of keyLiterals(line)) {
      if (k.context === key.context && k.literal !== key.literal && !out.includes(k.literal)) {
        out.push(k.literal);
        if (out.length >= limit) {
          return out;
        }
      }
    }
  }
  return out;
}

/** 文字列リテラルとしての出現を探す正規表現 */
export function quotedLiteralPattern(literal: string): RegExp {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`["'\`]${escaped}["'\`]`);
}

// ---------- 変更履歴(一緒に変わってきたファイル) ----------

export interface CoChange {
  path: string;
  /** 今回変えたファイルのうち、どれと一緒に変わってきたか */
  with: string;
  /** with を変えたコミットのうち、path も変えた割合 */
  confidence: number;
  /** 一緒に変わったコミット数 */
  support: number;
}

export interface CoChangeOptions {
  /** これより多くのファイルを変えたコミットは雑音として除く(一括置換・整形など) */
  maxCommitSize: number;
  minSupport: number;
  minConfidence: number;
  limit: number;
}

const DEFAULT_COCHANGE: CoChangeOptions = { maxCommitSize: 30, minSupport: 2, minConfidence: 0.3, limit: 5 };

/**
 * 「changed のファイルを変えたコミットでは、このファイルも変わっていることが多い」という関連ルールを作る。
 * changed に含まれるファイルは結果から除く。
 */
export function coChangeSuggestions(commits: string[][], changed: string[], options: Partial<CoChangeOptions> = {}): CoChange[] {
  const o = { ...DEFAULT_COCHANGE, ...options };
  const changedSet = new Set(changed);
  const best = new Map<string, CoChange>();
  for (const f of changed) {
    // 単独で変更されたコミットも分母に数える(単独で変わることが多いファイルほど、関連の確信度は下がる)
    const related = commits.filter((c) => c.length <= o.maxCommitSize && c.includes(f));
    if (related.length === 0) {
      continue;
    }
    const counts = new Map<string, number>();
    for (const c of related) {
      for (const g of new Set(c)) {
        if (!changedSet.has(g)) {
          counts.set(g, (counts.get(g) ?? 0) + 1);
        }
      }
    }
    for (const [g, support] of counts) {
      const confidence = support / related.length;
      if (support < o.minSupport || confidence < o.minConfidence) {
        continue;
      }
      const prev = best.get(g);
      if (!prev || confidence > prev.confidence || (confidence === prev.confidence && support > prev.support)) {
        best.set(g, { path: g, with: f, confidence, support });
      }
    }
  }
  return [...best.values()]
    .sort((a, b) => b.confidence - a.confidence || b.support - a.support || a.path.localeCompare(b.path))
    .slice(0, o.limit);
}
