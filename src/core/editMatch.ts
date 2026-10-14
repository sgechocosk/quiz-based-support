/**
 * 編集の「置き換え前のコード(oldCode)」を、ファイルの中から内容で探す。
 * 一般的なコーディングエージェントの手法に合わせ、行番号ではなく内容を手がかりにする。
 * - 厳しい比較から順に緩めて探す(Codex の apply_patch: 完全一致 → 行末の空白 → 前後の空白 → 記号の正規化)
 * - 複数見つかったら行番号の手がかりで最も近いものを選び、決められなければ失敗にする(Claude の str_replace・Roo Code)
 * - インデントだけずれていれば、置き換え後のコードのインデントも合わせる(Aider)
 * - 見つからなければ、最も近い箇所と最初に食い違う行を返し、作り直しの手がかりにする(Aider の "Did you mean")
 */

import { numberLines, truncate } from "./text";

export type MatchStrategy = "exact" | "trim-end" | "indent" | "loose" | "normalized";

export type BlockMatch =
  | {
      ok: true;
      /** 1始まり・両端含む */
      start: number;
      end: number;
      strategy: MatchStrategy;
      /** 置き換え後の行を、実際のインデントに合わせる */
      reindent: (lines: string[]) => string[];
    }
  | { ok: false; kind: "empty" }
  | { ok: false; kind: "ambiguous"; starts: number[] }
  | { ok: false; kind: "not-found"; closest?: ClosestBlock };

export interface ClosestBlock {
  /** 1始まり・両端含む */
  start: number;
  end: number;
  /** 0〜1 */
  similarity: number;
  /** 最初に食い違う行(oldCode の何行目か・その行・実際の行) */
  diff?: { index: number; expected: string; actual: string };
}

const STRATEGIES: Array<{ name: MatchStrategy; key: (line: string) => string }> = [
  { name: "exact", key: (l) => l },
  { name: "trim-end", key: (l) => l.trimEnd() },
  { name: "indent", key: (l) => l.trim() },
  { name: "loose", key: (l) => l.replace(/\s+/g, "") },
  { name: "normalized", key: (l) => normalizePunctuation(l).replace(/\s+/g, "") },
];

/** LLM が混ぜやすい記号の違い(全角・typographic な引用符やダッシュ)をそろえる */
function normalizePunctuation(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[  -​　]/g, " ");
}

/** 前後の空行を落とす(LLM が付けがち。空行だけの違いで見つからなくならないように) */
export function trimBlankEdges(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a]!.trim() === "") {
    a++;
  }
  while (b > a && lines[b - 1]!.trim() === "") {
    b--;
  }
  return lines.slice(a, b);
}

function countBlank(lines: string[], fromEnd: boolean): number {
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[fromEnd ? lines.length - 1 - i : i]!.trim() !== "") {
      break;
    }
    n++;
  }
  return n;
}

/**
 * oldCode の前後の空行は探すときに落とすので、newCode の前後に同じ数だけ空行が写してあれば、それも落とす
 * (落とさないと、置き換えのたびに空行が増える)
 */
export function trimMirroredBlanks(oldLines: string[], newLines: string[]): string[] {
  let out = newLines;
  const head = Math.min(countBlank(oldLines, false), countBlank(out, false));
  out = out.slice(head);
  const tail = Math.min(countBlank(oldLines, true), countBlank(out, true));
  return tail > 0 ? out.slice(0, out.length - tail) : out;
}

function indentOf(line: string): string {
  return /^\s*/.exec(line)![0];
}

/**
 * 実際の行と oldCode の行のインデントの差が一定なら、置き換え後のコードにも同じ差を付ける。
 * 一定でなければ(行の中の空白が違うだけなど)そのまま。
 */
function reindenter(actual: string[], expected: string[]): (lines: string[]) => string[] {
  const pairs = actual.map((a, i) => [a, expected[i]!] as const).filter(([a]) => a.trim() !== "");
  if (pairs.length === 0) {
    return (l) => l;
  }
  const [a0, e0] = pairs[0]!;
  const ai = indentOf(a0);
  const ei = indentOf(e0);
  if (ai === ei) {
    return (l) => l;
  }
  if (ai.startsWith(ei)) {
    const add = ai.slice(ei.length);
    if (pairs.every(([a, e]) => a.trimEnd() === add + e.trimEnd())) {
      return (lines) => lines.map((l) => (l.trim() === "" ? l : add + l));
    }
  } else if (ei.startsWith(ai)) {
    const cut = ei.slice(ai.length);
    if (pairs.every(([a, e]) => cut + a.trimEnd() === e.trimEnd())) {
      return (lines) => lines.map((l) => (l.startsWith(cut) ? l.slice(cut.length) : l));
    }
  }
  return (l) => l;
}

function findAll(keys: string[], want: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + want.length <= keys.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (keys[i + j] !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      out.push(i);
    }
  }
  return out;
}

/**
 * oldLines をファイルの行 lines の中から探す。
 * hint(1始まり)は LLM が示した行番号。複数見つかったときに、明らかに最も近いものを選ぶのに使う。
 */
export function locateBlock(lines: string[], oldLines: string[], hint?: number): BlockMatch {
  const want = trimBlankEdges(oldLines);
  if (want.length === 0) {
    return { ok: false, kind: "empty" };
  }
  for (const { name, key } of STRATEGIES) {
    const keys = lines.map(key);
    const target = want.map(key);
    // 空白だけの違いを許す比較で、空行や「}」だけのような短い塊が偶然一致するのを避ける
    if (name !== "exact" && name !== "trim-end" && target.join("").length < 4) {
      continue;
    }
    const found = findAll(keys, target);
    if (found.length === 0) {
      continue;
    }
    let pick: number | undefined;
    if (found.length === 1) {
      pick = found[0];
    } else if (hint !== undefined && Number.isFinite(hint)) {
      const byDistance = [...found].sort((a, b) => Math.abs(a + 1 - hint) - Math.abs(b + 1 - hint));
      const d0 = Math.abs(byDistance[0]! + 1 - hint);
      const d1 = Math.abs(byDistance[1]! + 1 - hint);
      // 行番号はずれやすいので、ほぼ指定どおりの位置にあるか、2番目より十分に近いときだけ選ぶ
      if ((d0 <= 1 && d1 >= 3) || d1 - d0 >= 5) {
        pick = byDistance[0];
      }
    }
    if (pick === undefined) {
      return { ok: false, kind: "ambiguous", starts: found.map((i) => i + 1) };
    }
    const actual = lines.slice(pick, pick + want.length);
    return {
      ok: true,
      start: pick + 1,
      end: pick + want.length,
      strategy: name,
      reindent: name === "exact" ? (l) => l : reindenter(actual, want),
    };
  }
  return { ok: false, kind: "not-found", closest: closestBlock(lines, want, hint) };
}

// ---------- 見つからなかったときの手がかり ----------

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** 2つの行の似ている度合い(空白を除いた文字の2-gram の Dice 係数) */
export function lineSimilarity(a: string, b: string): number {
  const x = a.replace(/\s+/g, "");
  const y = b.replace(/\s+/g, "");
  if (x === y) {
    return 1;
  }
  if (x.length < 2 || y.length < 2) {
    return 0;
  }
  const bx = bigrams(x);
  const by = bigrams(y);
  let common = 0;
  for (const [g, n] of bx) {
    common += Math.min(n, by.get(g) ?? 0);
  }
  return (2 * common) / (x.length - 1 + (y.length - 1));
}

/** oldLines と同じ行数の範囲のうち、最も似ている箇所 */
export function closestBlock(lines: string[], oldLines: string[], hint?: number): ClosestBlock | undefined {
  const want = trimBlankEdges(oldLines);
  const n = want.length;
  if (n === 0 || lines.length === 0) {
    return undefined;
  }
  const span = Math.min(n, lines.length);
  // 長いファイルでも重くならないよう、各行の似ている度合いを先に1回だけ計算する(先頭行・末尾行で候補を絞る)
  const firstScores = lines.map((l) => lineSimilarity(l, want[0]!));
  let best: { start: number; score: number } | undefined;
  for (let i = 0; i + span <= lines.length; i++) {
    if (firstScores[i]! < 0.3 && n > 1 && lineSimilarity(lines[i + span - 1]!, want[span - 1]!) < 0.3) {
      continue;
    }
    let sum = 0;
    for (let j = 0; j < span; j++) {
      sum += j === 0 ? firstScores[i]! : lineSimilarity(lines[i + j]!, want[j]!);
    }
    const score = sum / n;
    const closer = best !== undefined && hint !== undefined && Math.abs(i + 1 - hint) < Math.abs(best.start + 1 - hint);
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && closer)) {
      best = { start: i, score };
    }
  }
  if (!best || best.score < 0.5) {
    return undefined;
  }
  let diff: ClosestBlock["diff"];
  for (let j = 0; j < span; j++) {
    const actual = lines[best.start + j]!;
    if (actual.replace(/\s+/g, "") !== want[j]!.replace(/\s+/g, "")) {
      diff = { index: j + 1, expected: want[j]!, actual };
      break;
    }
  }
  return { start: best.start + 1, end: best.start + span, similarity: best.score, diff };
}

function shown(line: string): string {
  return truncate(line.trim(), 120);
}

/** oldCode が見つからなかった・1か所に決まらなかったときの、作り直しの手がかりになる説明 */
export function describeBlockMiss(label: string, m: Exclude<BlockMatch, { ok: true }>, lines: string[]): { reason: string; line?: number } {
  if (m.kind === "empty") {
    return { reason: `${label} oldCode が空です。置き換える前のコードを逐語で写してください` };
  }
  if (m.kind === "ambiguous") {
    return {
      reason: `${label} oldCode がファイル内の${m.starts.length}か所(${m.starts.slice(0, 5).join("・")}行目)に一致し、どこを書き換えるか決まりません。前後の行も oldCode に含めて、1か所に決まるようにしてください`,
      line: m.starts[0],
    };
  }
  const c = m.closest;
  if (!c) {
    return { reason: `${label} oldCode がファイルに見つかりません(似ている箇所もありません)。今のコードを逐語で写してください` };
  }
  const where = `最も近いのは${c.start}〜${c.end}行目(一致度${Math.round(c.similarity * 100)}%)`;
  const diff = c.diff ? `で、oldCode の${c.diff.index}行目「${shown(c.diff.expected)}」は実際には「${shown(c.diff.actual)}」です` : "です";
  const actual = numberLines(lines.slice(c.start - 1, Math.min(c.end, c.start + 7)), c.start);
  return {
    reason: `${label} oldCode がファイルに見つかりません。${where}${diff}。今のコードを行番号を付けずに逐語で写してください。\n${actual}`,
    line: c.start,
  };
}
