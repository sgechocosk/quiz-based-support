import { revealsAnswer } from "./leak";
import { isSameCode } from "./quiz";
import { makeRng, sha1, shuffle } from "./text";
import type { Choice } from "./types";

/**
 * 選択式の空欄の選択肢を作る。
 * 誤答は「コードベースを見れば誤りだと判断できる」ものにしたいので、
 * - LLM の誤答のうち、実在しない名前を含むもの・正解と同じ書き方のもの・長さで見分けがつくものは捨てる
 * - 足りなければ、正解の演算子・値・名前を実在するものに入れ替えた誤答で補う
 */

export const OPTION_COUNT = 4;

export interface RawDistractor {
  code: string;
  whyWrong: string;
}

const IDENT_RE = /[A-Za-z_$][\w$]*/g;
const TOKEN_RE =
  /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\d[\d_]*(?:\.\d+)?|[A-Za-z_$][\w$]*|=>|===|!==|\*\*=?|\?\?=?|\?\.|\.\.\.|[<>!=+\-*/%&|^]=|&&|\|\||<<|>>>?|\+\+|--|::|->|\s+|\S/g;

/** 言語のキーワード・リテラル(どのコードベースでも「実在する」とみなす) */
const LANGUAGE_WORDS = new Set([
  "true", "false", "null", "undefined", "this", "super", "new", "await", "async", "return", "typeof", "instanceof",
  "void", "in", "of", "const", "let", "var", "function", "class", "if", "else", "for", "while", "break", "continue",
  "throw", "try", "catch", "finally", "yield", "as", "is", "keyof", "readonly", "string", "number", "boolean",
  "any", "unknown", "never", "object", "bigint", "symbol", "int", "long", "double", "float", "char", "byte",
  "short", "final", "static", "public", "private", "protected", "None", "True", "False", "self", "not", "and", "or",
]);

/** 正解の一部を入れ替えて「ありがちな誤り」を作るための対応表 */
const OPERATOR_SWAPS: Record<string, string[]> = {
  "<": ["<=", ">"],
  "<=": ["<", ">="],
  ">": [">=", "<"],
  ">=": [">", "<="],
  "===": ["!=="],
  "!==": ["==="],
  "==": ["!="],
  "!=": ["=="],
  "&&": ["||"],
  "||": ["&&"],
  "+": ["-"],
  "-": ["+"],
  "??": ["||"],
  "true": ["false"],
  "false": ["true"],
  // 型注釈の取り違え
  "boolean": ["string", "number", "void"],
  "string": ["number", "boolean", "string[]"],
  "number": ["string", "boolean", "bigint"],
  "void": ["boolean", "undefined", "never"],
};

/** 文字列・コメントの中の語は名前の候補にしない */
function stripStringsAndComments(text: string): string {
  return text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, " ");
}

function squash(s: string): string {
  return s.replace(/\s+/g, "");
}

/** 正解と同じ意味になる書き方か(空白・引用符・末尾の ; の違いだけ) */
function sameAsAnswer(code: string, answer: string): boolean {
  return squash(code) === squash(answer) || isSameCode(code, answer, { loose: true });
}

/** 先頭が . でない識別子(メンバー名以外)が、すべて既知の名前か */
function usesKnownNames(code: string, known: ReadonlySet<string>): boolean {
  for (const m of code.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*/g)) {
    const w = m[0];
    if (!known.has(w) && !LANGUAGE_WORDS.has(w)) {
      return false;
    }
  }
  return true;
}

/** 長さが極端に違うと形だけで正解が分かってしまう */
function similarLength(code: string, answer: string): boolean {
  const a = squash(answer).length;
  const c = squash(code).length;
  return c >= Math.max(1, Math.floor(a * 0.4)) && c <= Math.ceil(a * 2.5) + 4;
}

/** 名前の見た目(先頭が大文字か)が同じ種類の識別子を、入れ替え候補にする */
function sameKind(a: string, b: string): boolean {
  return /^[A-Z]/.test(a) === /^[A-Z]/.test(b) && a !== b;
}

/**
 * 正解を1か所だけ変えた誤答の候補を、ありがちな誤り(境界・条件の反転・数値のずれ・名前の取り違え)の順に作る。
 * pool は入れ替え先として使ってよい実在の名前(近くのコードにある順)。
 */
export function mutateAnswer(answer: string, pool: string[]): string[] {
  const tokens = answer.match(TOKEN_RE) ?? [];
  const out: string[] = [];
  const replaceAt = (i: number, value: string): string => tokens.map((t, k) => (k === i ? value : t)).join("");
  tokens.forEach((t, i) => {
    for (const swap of OPERATOR_SWAPS[t] ?? []) {
      out.push(replaceAt(i, swap));
    }
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      out.push(replaceAt(i, String(n + 1)));
      if (n > 0) {
        out.push(replaceAt(i, String(n - 1)));
      }
    }
  });
  const idents = tokens.map((t, i) => ({ t, i })).filter(({ t }) => /^[A-Za-z_$]/.test(t) && !LANGUAGE_WORDS.has(t));
  for (const { t, i } of idents) {
    for (const other of pool.filter((p) => sameKind(p, t) && !LANGUAGE_WORDS.has(p)).slice(0, 4)) {
      out.push(replaceAt(i, other));
    }
  }
  return [...new Set(out)];
}

/** コード中の識別子を、出現が近い順(ブランクに近いものから)に並べる */
export function namePool(nearText: string, farText = ""): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const words = (t: string): string[] => stripStringsAndComments(t).match(IDENT_RE) ?? [];
  for (const w of [...words(nearText), ...words(farText)]) {
    if (!seen.has(w) && !LANGUAGE_WORDS.has(w) && w.length >= 2) {
      seen.add(w);
      out.push(w);
    }
  }
  return out;
}

export interface BuildChoicesInput {
  answer: string;
  /** 正解を選ぶ理由(採点後に表示) */
  why: string;
  distractors: RawDistractor[];
  /** 実在する名前(ファイル・調査で読んだコード・新しく作る名前・標準の名前) */
  known: ReadonlySet<string>;
  /** 誤答の自動補充に使う名前 */
  pool: string[];
  /** 選択肢の並び順を決める種(同じ問題なら毎回同じ並び) */
  seed: string;
}

export interface BuiltChoices {
  choices: Choice[];
  /** 捨てた誤答の理由(LLMへの作り直し依頼に添える) */
  dropped: string[];
}

export function buildChoices(input: BuildChoicesInput): BuiltChoices {
  const { answer, known } = input;
  const picked: Choice[] = [];
  const dropped: string[] = [];
  const taken = (code: string): boolean => sameAsAnswer(code, answer) || picked.some((c) => squash(c.code) === squash(code));

  for (const d of Array.isArray(input.distractors) ? input.distractors : []) {
    const code = (d?.code ?? "").trim();
    if (picked.length >= OPTION_COUNT - 1) {
      break;
    }
    if (!code || /[\r\n]/.test(code) || code.length > 100) {
      dropped.push(`誤答「${code.slice(0, 30)}」: 1行・100文字以内にしてください`);
    } else if (taken(code)) {
      dropped.push(`誤答「${code}」: 正解や他の選択肢と同じです`);
    } else if (!usesKnownNames(code, known)) {
      dropped.push(`誤答「${code}」: コードベースに無い名前を含むため、見ただけで誤りと分かってしまいます`);
    } else if (!similarLength(code, answer)) {
      dropped.push(`誤答「${code}」: 正解と長さが違いすぎて、形だけで見分けられてしまいます`);
    } else {
      picked.push({ code, note: (d.whyWrong ?? "").trim() });
    }
  }
  for (const code of mutateAnswer(answer, input.pool)) {
    if (picked.length >= OPTION_COUNT - 1) {
      break;
    }
    if (!taken(code) && usesKnownNames(code, known)) {
      picked.push({ code, note: "" });
    }
  }
  if (picked.length === 0) {
    return { choices: [], dropped };
  }
  const all: Choice[] = [{ code: answer, note: input.why }, ...picked];
  return { choices: shuffle(all, makeRng(parseInt(sha1(input.seed).slice(0, 8), 16))), dropped };
}

/**
 * 「選択肢を1つ消す」ヒント用に、消す誤答とその理由を選ぶ。
 * 理由が答えを漏らす場合は理由を出さない。消せる誤答が1つしかなければ消さない(二択になってしまうため)。
 */
export function eliminationHint(choices: Choice[], answer: string): { index: number; note: string } | undefined {
  const wrong = choices.map((c, i) => ({ c, i })).filter(({ c }) => c.code !== answer);
  if (wrong.length < 2) {
    return undefined;
  }
  const best = wrong.find(({ c }) => c.note) ?? wrong[0]!;
  const note = best.c.note && !revealsAnswer(best.c.note, answer) ? best.c.note : "";
  return { index: best.i, note };
}
