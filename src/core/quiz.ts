import { detectEol, splitLines } from "./text";
import { BLANK, type BlankSpec, type NewName, type QuizItem, type QuizKind } from "./types";

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
  /** change のみ: 新しく作る名前とその役割(解答前に明示する) */
  newNames: NewName[];
  explanation: string;
}

export interface ValidateOptions {
  /** 調査で読んだコード全体。既存の関数かどうかの判定に使う */
  knownText?: string;
}

const IDENT_RE = /[A-Za-z_$][\w$]*/g;
const CONTROL_WORDS = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "new", "typeof", "await", "case", "default", "else",
  "do", "try", "throw", "in", "of", "void", "delete", "super", "this", "import", "export", "from", "yield", "async",
]);
/** 定義を探さなくても使ってよい標準の名前(ここに無い未知の関数呼び出しは「推測不能」とみなす) */
const STANDARD_GLOBALS = new Set([
  "parseInt", "parseFloat", "isNaN", "isFinite", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "String", "Number", "Boolean", "Array", "Object", "JSON", "Math", "Date", "Promise", "Map", "Set", "WeakMap",
  "RegExp", "Error", "TypeError", "Symbol", "BigInt", "console", "require", "fetch", "encodeURIComponent",
  "decodeURIComponent", "structuredClone", "queueMicrotask", "Buffer", "process", "URL", "AbortController",
  "System", "Integer", "Long", "Double", "List", "ArrayList", "HashMap", "HashSet", "Arrays", "Collections",
  "Optional", "Objects", "StringBuilder", "Exception", "RuntimeException", "IllegalArgumentException",
  "IllegalStateException", "assert", "len", "print", "range", "str", "int", "float", "dict", "list", "set",
]);

/** 識別子として妥当か */
function isIdentifier(s: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(s) && !CONTROL_WORDS.has(s);
}

function wordsOf(text: string): Set<string> {
  return new Set(text.match(IDENT_RE) ?? []);
}

/**
 * コード中で「定義」されている名前(関数・クラス・変数・メソッド・フィールド・引数)を大まかに拾う。
 * TS/JS/Java を想定した正規表現なので完全ではないが、新しく作る名前を見つける目的には十分。
 */
export function declaredNames(lines: string[]): Set<string> {
  const names = new Set<string>();
  const add = (n: string | undefined): void => {
    if (n && isIdentifier(n)) {
      names.add(n);
    }
  };
  const params = (list: string): void => {
    for (const p of list.split(",")) {
      const head = p.replace(/=.*$/, "").replace(/:.*$/, "").replace(/[{}[\]().?]/g, " ").trim();
      add(head.split(/\s+/).pop()); // Java の "Token t" は最後の語が名前
    }
  };
  const MODS = "(?:(?:public|private|protected|static|async|override|readonly|final|abstract|synchronized|export|default)\\s+)*";
  for (const line of lines) {
    for (const m of line.matchAll(/\b(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
      add(m[1]);
    }
    // const { a, b } = ... / const [a, b] = ...
    for (const m of line.matchAll(/\b(?:const|let|var)\s+[{[]([^}\]]*)[}\]]/g)) {
      params(m[1]!);
    }
    // メソッド・関数定義: name(params) { / name(params): T {
    const def = line.match(
      new RegExp(`^\\s*${MODS}(?:[\\w<>\\[\\],.?]+\\s+)?([A-Za-z_$][\\w$]*)\\s*\\(([^()]*)\\)\\s*(?::\\s*[^={;]+)?(?:throws\\s+[\\w., ]+)?\\{\\s*$`),
    );
    if (def && !CONTROL_WORDS.has(def[1]!)) {
      add(def[1]);
      params(def[2]!);
    }
    for (const m of line.matchAll(/\bfunction\*?\s*[\w$]*\s*\(([^()]*)\)/g)) {
      params(m[1]!);
    }
    // アロー関数の引数: (a, b) => / a =>
    for (const m of line.matchAll(/\(([^()]*)\)\s*(?::\s*[^=]+)?=>/g)) {
      params(m[1]!);
    }
    for (const m of line.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) {
      add(m[1]);
    }
    // クラスのフィールド: private name: T / name = ...
    const field = line.match(new RegExp(`^\\s*${MODS}([A-Za-z_$][\\w$]*)\\s*[?!]?\\s*:\\s*[^:]`));
    if (field && /^\s*(?:public|private|protected|readonly|static)\b/.test(line)) {
      add(field[1]);
    }
    // Java のローカル変数・フィールド: Type name = / Type name;
    const javaVar = line.match(new RegExp(`^\\s*${MODS}[A-Z][\\w<>\\[\\],.?]*\\s+([a-z_$][\\w$]*)\\s*[=;]`));
    add(javaVar?.[1]);
  }
  return names;
}

/**
 * 答えの中で、学習者が既存コードから推測できない名前を探す。
 * - 新しく作る名前(newNames)はあらかじめ示すので推測不要
 * - 既存コード・表示中のコード・標準の名前にも無い関数呼び出し(先頭が . でない name(...))は推測不能
 */
export function unguessableCalls(answer: string, known: Set<string>): string[] {
  const out: string[] = [];
  for (const m of answer.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1]!;
    if (!CONTROL_WORDS.has(name) && !STANDARD_GLOBALS.has(name) && !known.has(name)) {
      out.push(name);
    }
  }
  return [...new Set(out)];
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
export function validateRawItem(raw: RawItem, fileText: string, options: ValidateOptions = {}): Validation {
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

  // 新しく作る名前: newCode で定義され、ファイルにまだ無い名前。LLM の申告 + 自動検出
  const fileWords = wordsOf(fileText);
  const codeWords = wordsOf(codeLines.join("\n"));
  const newNames: NewName[] = [];
  if (raw.kind === "change") {
    for (const n of Array.isArray(raw.newNames) ? raw.newNames : []) {
      const name = (n?.name ?? "").trim();
      if (isIdentifier(name) && codeWords.has(name) && !fileWords.has(name) && !newNames.some((x) => x.name === name)) {
        newNames.push({ name, role: (n.role ?? "").trim() });
      }
    }
    for (const name of declaredNames(codeLines)) {
      if (!fileWords.has(name) && !newNames.some((x) => x.name === name)) {
        newNames.push({ name, role: "" });
      }
    }
  }
  const known = new Set([...fileWords, ...wordsOf(options.knownText ?? ""), ...newNames.map((n) => n.name)]);

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

  // 理不尽な空欄を外す: 新しい名前そのもの / どこにも定義が無く推測しようのない関数呼び出し
  const visible = wordsOf(blankOut(codeLines, spans).code);
  for (let k = spans.length - 1; k >= 0; k--) {
    const s = spans[k]!;
    const answer = codeLines[s.line]!.slice(s.start, s.end).trim();
    if (newNames.some((n) => n.name === answer)) {
      warnings.push(`${label} 空欄「${answer}」: 新しく作る名前そのものは空欄にしません(名前は newNames で解答前に示します)`);
      spans.splice(k, 1);
      continue;
    }
    const unknown = unguessableCalls(answer, new Set([...known, ...visible]));
    if (unknown.length > 0) {
      warnings.push(
        `${label} 空欄「${answer}」: ${unknown.join(", ")} は既存コードにも表示中のコードにも無く、学習者が推測できません。新しく作るなら newCode に定義を書き newNames で示してください`,
      );
      spans.splice(k, 1);
    }
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
      newNames,
    },
  };
}


// ---------- 表示量の調整 ----------

/** 空欄・変更行の前後に残す行数 */
export const CONTEXT_LINES = 3;

/**
 * 問題の範囲を「空欄(と変更行)の前後 context 行」まで切り詰める。
 * read は先頭・末尾を、change は元コードと完全に同じ先頭・末尾の行だけを削るので、反映結果は変わらない。
 */
export function compactItem(item: QuizItem, context = CONTEXT_LINES): QuizItem {
  const q = splitLines(item.quizCode);
  const o = splitLines(item.original);
  const blankLines = q.flatMap((l, i) => (l.includes(BLANK) ? [i] : []));
  if (blankLines.length === 0) {
    return item;
  }
  let head: number;
  let tail: number;
  if (item.kind === "read") {
    head = Math.max(0, blankLines[0]! - context);
    tail = Math.max(0, q.length - 1 - (blankLines[blankLines.length - 1]! + context));
  } else {
    // 元コードと一字一句同じ(空欄なし)の先頭・末尾の行数
    let prefix = 0;
    while (prefix < q.length && prefix < o.length && q[prefix] === o[prefix]) {
      prefix++;
    }
    let suffix = 0;
    while (
      suffix < q.length - prefix &&
      suffix < o.length - prefix &&
      q[q.length - 1 - suffix] === o[o.length - 1 - suffix]
    ) {
      suffix++;
    }
    head = Math.max(0, prefix - context);
    tail = Math.max(0, suffix - context);
    if (o.length - head - tail <= 0) {
      // 純粋な挿入で元の範囲が空になると反映位置を表せないので、元の行を1行は残す
      tail = Math.max(0, tail - 1);
    }
  }
  if (head === 0 && tail === 0) {
    return item;
  }
  return {
    ...item,
    startLine: item.startLine + head,
    endLine: item.endLine - tail,
    quizCode: q.slice(head, q.length - tail).join("\n"),
    original: o.slice(head, o.length - tail).join("\n"),
  };
}

/**
 * 表示時に折りたたむ行範囲(quizCode の0始まりの行番号, 両端含む)。
 * 空欄・変更行の前後 context 行以外が minRun 行以上続く部分を返す。
 */
export function foldRanges(item: Pick<QuizItem, "kind" | "quizCode" | "original">, context = 2, minRun = 3): Array<[number, number]> {
  const q = splitLines(item.quizCode);
  const keep = new Set<number>();
  const mark = (i: number): void => {
    for (let k = Math.max(0, i - context); k <= Math.min(q.length - 1, i + context); k++) {
      keep.add(k);
    }
  };
  q.forEach((l, i) => l.includes(BLANK) && mark(i));
  if (item.kind === "change") {
    changedLineIndexes(splitLines(item.original), q).forEach(mark);
  }
  const folds: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i <= q.length; i++) {
    const hidden = i < q.length && !keep.has(i);
    if (hidden && start < 0) {
      start = i;
    } else if (!hidden && start >= 0) {
      if (i - start >= minRun) {
        folds.push([start, i - 1]);
      }
      start = -1;
    }
  }
  return folds;
}

/**
 * 変更前後の差分を、変更行の前後 context 行だけに絞って返す(採点後の「完成形」表示用)。
 * 各行は " "(同じ) / "-"(削除) / "+"(追加) / "…"(省略) のいずれかを先頭に付ける。
 */
export function compactDiff(before: string, after: string, context = 2): string {
  const a = splitLines(before);
  const b = splitLines(after);
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const rows: Array<{ op: " " | "-" | "+"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ op: " ", text: a[i++]! });
      j++;
    } else if (i < a.length && (j >= b.length || dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
      // 置き換えは「- 旧」→「+ 新」の順に並べる
      rows.push({ op: "-", text: a[i++]! });
    } else {
      rows.push({ op: "+", text: b[j++]! });
    }
  }
  const near = new Set<number>();
  rows.forEach((r, k) => {
    if (r.op !== " ") {
      for (let d = Math.max(0, k - context); d <= Math.min(rows.length - 1, k + context); d++) {
        near.add(d);
      }
    }
  });
  const out: string[] = [];
  let skipped = 0;
  rows.forEach((r, k) => {
    if (near.has(k)) {
      if (skipped > 0) {
        out.push(`… (${skipped}行省略)`);
        skipped = 0;
      }
      out.push(`${r.op} ${r.text}`);
    } else {
      skipped++;
    }
  });
  if (skipped > 0 && out.length > 0) {
    out.push(`… (${skipped}行省略)`);
  }
  return out.join("\n");
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
