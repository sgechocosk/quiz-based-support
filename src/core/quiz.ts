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

/** 空白の有無・量の違いを無視した比較用 */
function looseLine(s: string | undefined): string {
  return (s ?? "").replace(/\s+/g, "");
}

/**
 * LLM が返す行番号はずれやすい。firstLine/lastLine(逐語)を手がかりに、近傍で実際の位置を探し直す。
 * 近傍に無ければファイル全体から最も近い一致を探す。空白の違いは無視する。
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
  const first = looseLine(stripLineNumber(firstLine));
  const last = looseLine(stripLineNumber(lastLine));
  const span = Math.max(0, endLine - startLine);
  const guess = Math.min(Math.max(startLine - 1, 0), Math.max(lines.length - 1, 0));

  const nearest = (target: string, center: number, from: number, to: number): number => {
    let found = -1;
    let best = Infinity;
    for (let i = Math.max(0, from); i <= Math.min(lines.length - 1, to); i++) {
      if (looseLine(lines[i]) === target && Math.abs(i - center) < best) {
        best = Math.abs(i - center);
        found = i;
      }
    }
    return found;
  };

  let startIdx = -1;
  if (first === "") {
    startIdx = guess;
  } else {
    startIdx = nearest(first, guess, guess - window, guess + window);
    if (startIdx < 0) {
      startIdx = nearest(first, guess, 0, lines.length - 1);
    }
  }
  if (startIdx < 0 || startIdx >= lines.length) {
    return undefined;
  }

  const expectedEnd = Math.min(startIdx + span, lines.length - 1);
  let endIdx = expectedEnd;
  if (last !== "") {
    const found = nearest(last, expectedEnd, Math.max(startIdx, expectedEnd - 8), expectedEnd + 8);
    if (found >= 0) {
      endIdx = found;
    }
  }
  return { start: startIdx + 1, end: endIdx + 1 };
}

// ---------- LLM出力の検証と問題の組み立て ----------

/**
 * LLM は「どの行のどの文字列を空欄にするか」だけを指定する。
 * quizCode はシステムが実コード(read)/変更後コード(change)から組み立てるので、
 * 書き写しの食い違いで問題が落ちることはない。
 */
export interface RawBlank {
  /** read: ファイルの行番号 / change: newCode 内の行番号(どちらも1始まり。ずれていても近傍を探す) */
  line: number;
  /** 空欄にする文字列(その行に逐語で含まれる1行以内の部分) */
  target: string;
  concept: string;
  hintConcept: string;
  hintApproach: string;
  hintSyntax: string;
  why: string;
  cluePath: string;
  clueLine: number;
  clueNote: string;
}

export interface RawRef {
  path: string;
  line: number;
  note: string;
}

export interface RawItem {
  kind: QuizKind;
  path: string;
  startLine: number;
  endLine: number;
  firstLine: string;
  lastLine: string;
  task: string;
  /** change のみ: 対象範囲を置き換える変更後のコード(空欄なし) */
  newCode: string;
  blanks: RawBlank[];
  refs: RawRef[];
  explanation: string;
}

export type Validation =
  | { ok: true; item: QuizItem; warnings: string[] }
  | { ok: false; reason: string };

/** "L12| " のような表示用の行番号が混入していたら除く */
function stripLineNumber(line: string): string {
  return (line ?? "").replace(/^\s*L\d+\|\s?/, "");
}

/** ```フェンスや行番号の混入を取り除いてから行に分ける */
export function cleanCodeLines(code: string): string[] {
  let lines = splitLines((code ?? "").replace(/^\s*```[\w-]*\s*\n/, "").replace(/\n\s*```\s*$/, ""));
  if (lines.length > 0 && lines.every((l) => l.trim() === "" || /^\s*L\d+\|/.test(l))) {
    lines = lines.map(stripLineNumber);
  }
  return lines;
}

// 空欄の位置合わせに使うトークン(空白の違いを吸収するため)
const RAW_TOKEN_RE =
  /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\d[\d_]*(?:\.\d+)?|[A-Za-z_$][\w$]*|=>|===|!==|\*\*=?|\?\?=?|\?\.|\.\.\.|[<>!=+\-*/%&|^]=|&&|\|\||<<|>>>?|\+\+|--|::|->|\S/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Span {
  line: number;
  start: number;
  end: number;
}

function overlaps(spans: Span[], s: Span): boolean {
  return spans.some((t) => t.line === s.line && t.start < s.end && s.start < t.end);
}

/**
 * target を lines の中から探す。guess 行から近い順に、まず逐語一致、次に空白の違いを無視した一致。
 * 既に空欄にした範囲と重なる位置は避ける。
 */
export function locateTarget(lines: string[], guess: number, target: string, taken: Span[] = []): Span | undefined {
  const t = stripLineNumber(target).trim();
  if (!t || lines.length === 0) {
    return undefined;
  }
  const center = Math.min(Math.max(Number.isFinite(guess) ? guess : 0, 0), lines.length - 1);
  const order = [center];
  for (let d = 1; d < lines.length; d++) {
    if (center - d >= 0) {
      order.push(center - d);
    }
    if (center + d < lines.length) {
      order.push(center + d);
    }
  }
  const tokens = t.match(RAW_TOKEN_RE) ?? [];
  const flex = tokens.length > 0 ? new RegExp(tokens.map(escapeRegExp).join("\\s*"), "g") : undefined;
  for (const idx of order) {
    const line = lines[idx]!;
    for (let at = line.indexOf(t); at >= 0; at = line.indexOf(t, at + 1)) {
      const span = { line: idx, start: at, end: at + t.length };
      if (!overlaps(taken, span)) {
        return span;
      }
    }
    if (flex) {
      flex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = flex.exec(line)) !== null) {
        const span = { line: idx, start: m.index, end: m.index + m[0].length };
        if (m[0].length > 0 && !overlaps(taken, span)) {
          return span;
        }
        flex.lastIndex = m.index + 1;
      }
    }
  }
  return undefined;
}

/** spans を ___BLANK___ に置き換えたコードと、出現順に並べた spans を返す。 */
export function blankOut(lines: string[], spans: Span[]): { code: string; ordered: Span[] } {
  const ordered = [...spans].sort((a, b) => a.line - b.line || a.start - b.start);
  const out = lines.slice();
  for (const s of [...ordered].reverse()) {
    const line = out[s.line]!;
    out[s.line] = line.slice(0, s.start) + BLANK + line.slice(s.end);
  }
  return { code: out.join("\n"), ordered };
}

/** LCS で「元コードに無い(=変更された)行」の添字を返す。比較は空白を無視。 */
export function changedLineIndexes(before: string[], after: string[]): Set<number> {
  const a = before.map(looseLine);
  const b = after.map(looseLine);
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const changed = new Set<number>();
  let i = 0;
  let j = 0;
  while (j < b.length) {
    if (i < a.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (i < a.length && dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      if (b[j] !== "") {
        changed.add(j);
      }
      j++;
    }
  }
  return changed;
}

const MAX_ANSWER_CHARS = 100;

/**
 * LLMが返した1問を、実ファイルに照らして検証し、出題できる形に組み立てる。
 * - read(読解): 実コードの該当範囲から空欄を作る(正解で埋めると必ず実コードに戻る)
 * - change(変更): newCode から空欄を作る。元コードと異なり、変更行に空欄が少なくとも1つあること
 * 個々の空欄の不備はその空欄だけ捨てて warnings に残す(問題全体は落とさない)。
 * 構文チェックは非同期なので呼び出し側(agent)が行う。
 */
export function validateRawItem(raw: RawItem, fileText: string): Validation {
  const lines = splitLines(fileText);
  const label = `${raw.path}:${raw.startLine}-${raw.endLine}`;
  let range = locateRange(lines, raw.startLine, raw.endLine, raw.firstLine, raw.lastLine);
  const rawBlanks = Array.isArray(raw.blanks) ? raw.blanks : [];
  if (!range && raw.kind === "read" && raw.startLine >= 1 && raw.endLine >= raw.startLine && raw.endLine <= lines.length) {
    // firstLine が写し間違いでも、指定範囲に空欄の文字列が全部見つかるなら範囲は正しいとみなす
    const candidate = lines.slice(raw.startLine - 1, raw.endLine);
    if (rawBlanks.length > 0 && rawBlanks.every((b) => locateTarget(candidate, b.line - raw.startLine, b.target))) {
      range = { start: raw.startLine, end: raw.endLine };
    }
  }
  if (!range) {
    return {
      ok: false,
      reason: `${label} 範囲を特定できません(firstLine「${raw.firstLine}」が実ファイルに見つからない)。参照コードの行を逐語で firstLine に入れてください`,
    };
  }
  if (rawBlanks.length === 0) {
    return { ok: false, reason: `${label} blanks が空です` };
  }

  const originalLines = lines.slice(range.start - 1, range.end);
  const original = originalLines.join("\n");
  let codeLines: string[];
  if (raw.kind === "read") {
    codeLines = originalLines;
  } else {
    codeLines = cleanCodeLines(raw.newCode);
    if (codeLines.join("").trim() === "") {
      return { ok: false, reason: `${label} change問題: newCode が空です` };
    }
    if (isSameCode(codeLines.join("\n"), original, { loose: true })) {
      return { ok: false, reason: `${label} change問題: newCode が元コードと同じです(変更になっていません)` };
    }
    if (codeLines.length > originalLines.length * 3 + 30) {
      return { ok: false, reason: `${label} change問題: 変更後が元の範囲に比べて長すぎます` };
    }
  }

  const warnings: string[] = [];
  const spans: Array<Span & { blank: RawBlank }> = [];
  const lineBase = raw.kind === "read" ? range.start : 1;
  for (const b of rawBlanks) {
    const target = (b.target ?? "").trim();
    if (!target || /[\r\n]/.test(target) || target.includes(BLANK)) {
      warnings.push(`${label} 空欄「${target}」: 1行以内の空でない文字列にしてください`);
      continue;
    }
    if (target.length > MAX_ANSWER_CHARS) {
      warnings.push(`${label} 空欄「${target.slice(0, 30)}…」: 長すぎます(${MAX_ANSWER_CHARS}文字以内)`);
      continue;
    }
    if (!/[A-Za-z0-9_$]/.test(target) && target.length < 2) {
      warnings.push(`${label} 空欄「${target}」: 記号1文字だけの空欄は考える意味が薄いため除外しました`);
      continue;
    }
    const span = locateTarget(codeLines, (Number(b.line) || lineBase) - lineBase, target, spans);
    if (!span) {
      const where = raw.kind === "read" ? `L${b.line}` : `newCode の${b.line}行目`;
      const actual = codeLines[(Number(b.line) || lineBase) - lineBase];
      warnings.push(
        `${label} 空欄「${target}」が${raw.kind === "read" ? "実コード" : "newCode"}に見つかりません(${where}${actual !== undefined ? ` の実際の内容: ${actual.trim()}` : ""})`,
      );
      continue;
    }
    spans.push({ ...span, blank: b });
  }
  if (spans.length === 0) {
    return { ok: false, reason: `${label} 有効な空欄がありません。${warnings.slice(0, 3).join(" / ")}` };
  }

  if (raw.kind === "change") {
    const changed = changedLineIndexes(originalLines, codeLines);
    if (!spans.some((s) => changed.has(s.line))) {
      return {
        ok: false,
        reason: `${label} change問題: 変更した行(${[...changed].slice(0, 5).map((i) => i + 1).join(", ")}行目)に空欄がありません。変更の核心を空欄にしてください`,
      };
    }
  }

  const { code, ordered } = blankOut(codeLines, spans);
  const blanks = (ordered as Array<Span & { blank: RawBlank }>).map((s) => {
    const b = s.blank;
    const spec: BlankSpec = {
      answer: codeLines[s.line]!.slice(s.start, s.end),
      concept: (b.concept ?? "").trim() || "コード理解",
      hints: [b.hintConcept, b.hintApproach, b.hintSyntax].map((h) => (h ?? "").trim()),
      why: (b.why ?? "").trim(),
    };
    if (b.cluePath && Number(b.clueLine) > 0) {
      spec.clue = { path: b.cluePath, line: Number(b.clueLine), note: (b.clueNote ?? "").trim() };
    }
    return spec;
  });

  return {
    ok: true,
    warnings,
    item: {
      kind: raw.kind,
      path: raw.path,
      startLine: range.start,
      endLine: range.end,
      original,
      quizCode: code,
      blanks,
      explanation: (raw.explanation ?? "").trim(),
      task: (raw.task ?? "").trim(),
      refs: (Array.isArray(raw.refs) ? raw.refs : [])
        .filter((r) => r && r.path && Number(r.line) > 0)
        .map((r) => ({ path: r.path, line: Number(r.line), note: (r.note ?? "").trim() })),
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
