import { detectEol, splitLines } from "./text";
import { BLANK, type BlankSpec, type QuizItem, type QuizKind } from "./types";

// ---------- ブランク操作 ----------

export function countBlanks(code: string): number {
  return code.split(BLANK).length - 1;
}

/** ___BLANK___ を answers で順に置換する。replace のコールバック形式なので $& 等の特殊パターンは解釈されない。 */
export function resolveBlanks(code: string, answers: string[]): string {
  let i = 0;
  return code.replace(/___BLANK___/g, () => answers[i++] ?? BLANK);
}

/** index 番目のブランクだけを残し、他は正解で埋める(復習カード用)。 */
export function isolateBlank(code: string, answers: string[], index: number): string {
  let i = 0;
  return code.replace(/___BLANK___/g, () => {
    const current = i++;
    return current === index ? BLANK : (answers[current] ?? BLANK);
  });
}

// ---------- トークン比較(採点・検証用) ----------

// コメントも1トークンとして先に切り出して捨てる(文字列中の // を誤ってコメント扱いしないため)
const TOKEN_RE =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\d[\d_]*(?:\.\d+)?|[A-Za-z_$][\w$]*|=>|===|!==|\*\*=?|\?\?=?|\?\.|\.\.\.|[<>!=+\-*/%&|^]=|&&|\|\||<<|>>>?|\+\+|--|::|->|\S/g;

function canonicalString(token: string): string {
  const q = token[0];
  if ((q === "'" || q === '"') && token.length >= 2) {
    const inner = token.slice(1, -1);
    // 引用符の種類違い('a' と "a")は同一視する。中に別種の引用符を含む場合は触らない。
    if (!inner.includes('"') && !inner.includes("'")) {
      return `"${inner}"`;
    }
  }
  return token;
}

export interface TokenizeOptions {
  /** true: すべての ; を無視(ブロック全体の比較用)。false: 末尾の ; , のみ無視(1ブランクの採点用) */
  loose?: boolean;
}

export function tokenizeCode(source: string, options: TokenizeOptions = {}): string[] {
  const raw = source.match(TOKEN_RE) ?? [];
  const tokens = raw
    .filter((t) => !t.startsWith("//") && !t.startsWith("/*"))
    .map(canonicalString)
    .filter((t) => !(options.loose && t === ";"));
  while (tokens.length > 0 && (tokens[tokens.length - 1] === ";" || tokens[tokens.length - 1] === ",")) {
    tokens.pop();
  }
  return tokens;
}

export function isSameCode(a: string, b: string, options: TokenizeOptions = {}): boolean {
  const ta = tokenizeCode(a, options);
  const tb = tokenizeCode(b, options);
  return ta.length === tb.length && ta.every((t, i) => t === tb[i]);
}

// ---------- 行範囲の再配置 ----------

export interface LineRange {
  start: number;
  end: number;
}

/**
 * LLM が返す行番号はずれやすい。firstLine/lastLine(逐語)を手がかりに、近傍で実際の位置を探し直す。
 * start/end は 1始まり(両端含む)。
 */
export function locateRange(
  lines: string[],
  startLine: number,
  endLine: number,
  firstLine: string,
  lastLine: string,
  window = 60,
): LineRange | undefined {
  const norm = (s: string | undefined): string => (s ?? "").trim();
  const first = norm(firstLine);
  const last = norm(lastLine);
  const span = Math.max(0, endLine - startLine);
  const guess = Math.min(Math.max(startLine - 1, 0), Math.max(lines.length - 1, 0));

  let startIdx = -1;
  if (first === "") {
    startIdx = guess;
  } else {
    let best = Infinity;
    for (let i = Math.max(0, guess - window); i <= Math.min(lines.length - 1, guess + window); i++) {
      if (norm(lines[i]) === first && Math.abs(i - guess) < best) {
        best = Math.abs(i - guess);
        startIdx = i;
      }
    }
  }
  if (startIdx < 0 || startIdx >= lines.length) {
    return undefined;
  }

  const expectedEnd = Math.min(startIdx + span, lines.length - 1);
  let endIdx = expectedEnd;
  if (last !== "") {
    let best = Infinity;
    for (let j = Math.max(startIdx, expectedEnd - 8); j <= Math.min(lines.length - 1, expectedEnd + 8); j++) {
      if (norm(lines[j]) === last && Math.abs(j - expectedEnd) < best) {
        best = Math.abs(j - expectedEnd);
        endIdx = j;
      }
    }
  }
  return { start: startIdx + 1, end: endIdx + 1 };
}

// ---------- LLM出力の検証 ----------

export interface RawBlank {
  answer: string;
  concept: string;
  hintConcept: string;
  hintApproach: string;
  hintSyntax: string;
}

export interface RawItem {
  kind: QuizKind;
  path: string;
  startLine: number;
  endLine: number;
  firstLine: string;
  lastLine: string;
  quizCode: string;
  blanks: RawBlank[];
  explanation: string;
}

export type Validation = { ok: true; item: QuizItem } | { ok: false; reason: string };

function firstDifference(a: string, b: string): string {
  const la = splitLines(a).map((s) => s.trim());
  const lb = splitLines(b).map((s) => s.trim());
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) {
      return `相対${i + 1}行目: 期待「${lb[i] ?? "(なし)"}」/ 実際「${la[i] ?? "(なし)"}」`;
    }
  }
  return "";
}

/**
 * LLMが返した1問を、実ファイルに照らして検証する。
 * - read(読解): ブランクを正解で埋めた結果が実コードと一致しなければ不採用(=正解が実コードで裏付けられる)
 * - change(変更): ブランクを埋めた結果が実コードと異なり、極端に長くないこと
 * 構文チェックは非同期なので呼び出し側(agent)が行う。
 */
export function validateRawItem(raw: RawItem, fileText: string): Validation {
  const lines = splitLines(fileText);
  const label = `${raw.path}:${raw.startLine}-${raw.endLine}`;
  const range = locateRange(lines, raw.startLine, raw.endLine, raw.firstLine, raw.lastLine);
  if (!range) {
    return { ok: false, reason: `${label} 範囲を特定できません(firstLine が実ファイルの近傍に見つからない)` };
  }
  if (raw.blanks.length === 0) {
    return { ok: false, reason: `${label} blanks が空です` };
  }
  if (countBlanks(raw.quizCode) !== raw.blanks.length) {
    return {
      ok: false,
      reason: `${label} quizCode 内の ${BLANK} 数(${countBlanks(raw.quizCode)})と blanks の数(${raw.blanks.length})が一致しません`,
    };
  }
  if (raw.blanks.some((b) => !b.answer.trim() || b.answer.includes(BLANK))) {
    return { ok: false, reason: `${label} 空または不正な answer があります` };
  }
  const original = lines.slice(range.start - 1, range.end).join("\n");
  const answers = raw.blanks.map((b) => b.answer);
  const resolved = resolveBlanks(raw.quizCode, answers);

  if (raw.kind === "read") {
    if (!isSameCode(resolved, original, { loose: true })) {
      return {
        ok: false,
        reason: `${label} read問題: ブランクを正解で埋めても実コードと一致しません(${firstDifference(resolved, original)})。quizCode は実コードを逐語で写し、ブランク部分だけを置き換えてください`,
      };
    }
  } else {
    if (isSameCode(resolved, original, { loose: true })) {
      return { ok: false, reason: `${label} change問題: 正解で埋めても元コードと同じです(変更になっていません)` };
    }
    if (splitLines(resolved).length > (range.end - range.start + 1) * 3 + 30) {
      return { ok: false, reason: `${label} change問題: 変更後が元の範囲に比べて長すぎます` };
    }
  }

  return {
    ok: true,
    item: {
      kind: raw.kind,
      path: raw.path,
      startLine: range.start,
      endLine: range.end,
      original,
      quizCode: raw.quizCode,
      blanks: raw.blanks.map((b) => ({
        answer: b.answer,
        concept: b.concept || "コード理解",
        hints: [b.hintConcept, b.hintApproach, b.hintSyntax],
      })),
      explanation: raw.explanation,
    },
  };
}

// ---------- 反映(ファイル更新) ----------

export function rangeText(fileText: string, startLine: number, endLine: number): string {
  return splitLines(fileText).slice(startLine - 1, endLine).join("\n");
}

/**
 * 変更後のファイル全文を返す(CRLF/LF保持)。生成時の内容と一致しなければ例外。
 * answers を省略すると正解で埋める。採点時の構文チェックでは利用者の入力を渡す。
 */
export function applyItemToText(fileText: string, item: QuizItem, answers?: string[]): string {
  const eol = detectEol(fileText);
  const lines = splitLines(fileText);
  const current = lines.slice(item.startLine - 1, item.endLine).join("\n");
  if (current.trimEnd() !== item.original.trimEnd()) {
    throw new Error("対象範囲がクイズ生成時から変更されています。安全のため反映を中止しました。");
  }
  const resolved = resolveBlanks(item.quizCode, answers ?? item.blanks.map((b) => b.answer));
  lines.splice(item.startLine - 1, item.endLine - item.startLine + 1, ...splitLines(resolved));
  return lines.join(eol);
}

/** 最初のブランクを含む行の前後 radius 行だけを切り出す(復習カードの断片用)。 */
export function windowAround(code: string, radius = 5): string {
  const lines = splitLines(code);
  const at = lines.findIndex((l) => l.includes(BLANK));
  if (at < 0) {
    return lines.slice(0, radius * 2 + 1).join("\n");
  }
  return lines.slice(Math.max(0, at - radius), at + radius + 1).join("\n");
}

// ---------- 採点 ----------

export interface BlankGrade {
  correct: boolean;
  via: "exact" | "semantic" | "none";
  expected: string;
  given: string;
  note?: string;
}

export interface JudgeCase {
  context: string;
  expected: string;
  given: string;
}

export type SemanticJudge = (cases: JudgeCase[]) => Promise<Array<{ equivalent: boolean; reason: string }>>;

export async function gradeBlanks(
  item: Pick<QuizItem, "quizCode" | "blanks">,
  given: string[],
  judge?: SemanticJudge,
): Promise<BlankGrade[]> {
  const grades: BlankGrade[] = item.blanks.map((b, i) => {
    const g = (given[i] ?? "").trim();
    if (!g) {
      return { correct: false, via: "none", expected: b.answer, given: g, note: "未入力" };
    }
    const exact = isSameCode(g, b.answer);
    return { correct: exact, via: exact ? "exact" : "none", expected: b.answer, given: g };
  });

  if (judge) {
    const pending = grades.map((g, i) => ({ g, i })).filter(({ g }) => !g.correct && g.given !== "");
    if (pending.length > 0) {
      try {
        const verdicts = await judge(
          pending.map(({ i }) => ({
            context: isolateBlank(item.quizCode, item.blanks.map((b) => b.answer), i),
            expected: item.blanks[i]!.answer,
            given: grades[i]!.given,
          })),
        );
        pending.forEach(({ g }, k) => {
          const v = verdicts[k];
          if (v?.equivalent) {
            g.correct = true;
            g.via = "semantic";
          }
          if (v?.reason) {
            g.note = v.reason;
          }
        });
      } catch {
        // 判定器の失敗は不正解扱いのまま(採点自体は止めない)
      }
    }
  }
  return grades;
}

export function scoreOf(grades: Array<{ correct: boolean }>): { correct: number; total: number } {
  return { correct: grades.filter((g) => g.correct).length, total: grades.length };
}

export function blankSpecsOf(item: Pick<QuizItem, "blanks">): BlankSpec[] {
  return item.blanks;
}
