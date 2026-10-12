/**
 * 解答前に見える文章(課題文・ヒント・概念タグ等)が答えを漏らしていないかの機械判定。
 * LLM へのお願いだけでは守られないため、出題前に必ずここを通す。
 */

/** 答えの中にあっても「答えを特定する情報」にならない語 */
const TRIVIAL_WORDS = new Set([
  "this", "self", "super", "await", "async", "new", "return", "const", "let", "var", "final", "static",
  "public", "private", "protected", "typeof", "void", "yield", "is", "as", "of", "in",
]);

const IDENT_RE = /[A-Za-z_$][\w$]*/g;
const PUNCT_ONLY = /^[()[\]{}.,;:?!\s]*$/;

function squash(s: string): string {
  return s.replace(/\s+/g, "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasWord(text: string, word: string): boolean {
  return new RegExp(`(?<![\\w$])${escapeRegExp(word)}(?![\\w$])`).test(text);
}

/** 答えを特徴づける識別子(2文字以上、ありふれたキーワードを除く) */
export function distinctiveWords(answer: string): string[] {
  return [...new Set((answer.match(IDENT_RE) ?? []).filter((w) => w.length >= 2 && !TRIVIAL_WORDS.has(w)))];
}

/**
 * text を読めば answer が分かってしまうか。
 * - 答えそのもの(空白を無視)が含まれる
 * - 答えを特徴づける識別子が2つ以上すべて含まれる(材料を全部言っている)
 * - 特徴的な識別子が1つだけの答え(例: this.cache / foo())で、その識別子が含まれる
 */
export function revealsAnswer(text: string, answer: string): boolean {
  const t = text ?? "";
  const a = squash(answer ?? "");
  if (!t.trim() || a.length < 2) {
    return false;
  }
  if (squash(t).includes(a)) {
    return true;
  }
  const words = distinctiveWords(answer);
  if (words.length === 0 || !words.every((w) => hasWord(t, w))) {
    return false;
  }
  if (words.length >= 2) {
    return true;
  }
  let rest = answer;
  for (const w of [words[0]!, ...TRIVIAL_WORDS]) {
    rest = rest.replace(new RegExp(`(?<![\\w$])${escapeRegExp(w)}(?![\\w$])`, "g"), "");
  }
  return PUNCT_ONLY.test(rest);
}

/** どうしても書き直せなかった文章の最終手段: 答えと特徴的な識別子を伏せ字にする。 */
export function maskAnswers(text: string, answers: string[]): string {
  let out = text;
  for (const answer of [...answers].sort((a, b) => b.length - a.length)) {
    const trimmed = answer.trim();
    if (trimmed.length >= 2) {
      out = out.split(trimmed).join("〇〇");
    }
  }
  for (const answer of answers) {
    if (!revealsAnswer(out, answer)) {
      continue;
    }
    for (const w of distinctiveWords(answer)) {
      out = out.replace(new RegExp(`(?<![\\w$])${escapeRegExp(w)}(?![\\w$])`, "g"), "〇〇");
    }
  }
  return out;
}

/**
 * 答えの「形」だけを示すヒント(識別子・リテラルを伏せ、記号と構文キーワードだけ残す)。
 * 例: `await this.cache.get(key)` → `await this.___.___(___)`
 */
export function answerSkeleton(answer: string): string {
  const tokens = answer.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\d[\d_.]*|[A-Za-z_$][\w$]*|\s+|\S/g) ?? [];
  let words = 0;
  const shape = tokens
    .map((t) => {
      if (/^\s+$/.test(t)) {
        return " ";
      }
      if (/^[A-Za-z_$]/.test(t)) {
        if (TRIVIAL_WORDS.has(t)) {
          return t;
        }
        words++;
        return "___";
      }
      if (/^["'`\d]/.test(t)) {
        words++;
        return /^\d/.test(t) ? "(数値)" : "(文字列)";
      }
      return t;
    })
    .join("")
    .replace(/(___)(\s*___)+/g, "___");
  if (squash(shape) === "___" || words <= 1) {
    return `答えは${words <= 1 ? "1つの語(名前や値)" : "短い式"}です。前後の行で、その位置にどんな種類の値が必要かを考えてみましょう。`;
  }
  return `答えの形: ${shape}(___ の部分を前後のコードから考える)`;
}
