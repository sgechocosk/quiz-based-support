import { buildLineStarts, detectEol, splitLines } from "./text";

/** 行単位の差分の1区間(0始まり)。old の [oldStart, oldStart+oldCount) を new の [newStart, newStart+newCount) に置き換える。 */
export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/** 編集距離がこれを超える差分は、細かく分けずに1区間として扱う(計算量とメモリを抑えるため) */
const MAX_EDIT_DISTANCE = 1500;

/**
 * Myers の O(ND) 差分で、一致する行の組 [i, j] を昇順に返す。
 * 編集距離が maxD を超えたら undefined。
 */
function matchLines(a: string[], b: string[], maxD: number): Array<[number, number]> | undefined {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] は d 回目の探索後の v[k] (k = -d..d)
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(offset - d, offset + d + 1));
        return backtrack(trace, a, b);
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  return undefined;
}

function backtrack(trace: Int32Array[], a: string[], b: string[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1]!;
    const at = (k: number): number => prev[k + (d - 1)]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      pairs.push([x - 1, y - 1]);
      x--;
      y--;
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    pairs.push([x - 1, y - 1]);
    x--;
    y--;
  }
  return pairs.reverse();
}

/** 一致する行の組(昇順)。先頭・末尾の共通部分を先に除いてから Myers で比べる。 */
export function matchedLines(a: string[], b: string[]): Array<[number, number]> {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < prefix; i++) {
    pairs.push([i, i]);
  }
  for (const [i, j] of matchLines(midA, midB, MAX_EDIT_DISTANCE) ?? []) {
    pairs.push([i + prefix, j + prefix]);
  }
  for (let s = suffix; s > 0; s--) {
    pairs.push([a.length - s, b.length - s]);
  }
  return pairs;
}

/** 行配列どうしの差分区間 */
export function diffHunks(a: string[], b: string[]): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  for (const [mi, mj] of [...matchedLines(a, b), [a.length, b.length] as [number, number]]) {
    if (mi > i || mj > j) {
      hunks.push({ oldStart: i, oldCount: mi - i, newStart: j, newCount: mj - j });
    }
    i = mi + 1;
    j = mj + 1;
  }
  return hunks;
}

/** 文字列の置き換え(original の [start, end) を text に) */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * original を final にする最小限の置き換え(行単位)。オフセットは original 上。
 * 改行コードは original に合わせる。エディタへ反映するときに、変わっていない行に触れないために使う。
 */
export function textEdits(original: string, final: string): TextEdit[] {
  const eol = detectEol(original);
  const a = splitLines(original);
  const b = splitLines(final);
  const starts = buildLineStarts(original);
  const edits: TextEdit[] = [];
  for (const h of diffHunks(a, b)) {
    const lines = b.slice(h.newStart, h.newStart + h.newCount);
    if (h.oldCount === 0) {
      if (h.oldStart < a.length) {
        const at = starts[h.oldStart]!;
        edits.push({ start: at, end: at, text: lines.map((l) => l + eol).join("") });
      } else {
        edits.push({ start: original.length, end: original.length, text: eol + lines.join(eol) });
      }
      continue;
    }
    const end = h.oldStart + h.oldCount;
    if (end < a.length) {
      edits.push({ start: starts[h.oldStart]!, end: starts[end]!, text: lines.map((l) => l + eol).join("") });
    } else if (lines.length > 0) {
      edits.push({ start: starts[h.oldStart]!, end: original.length, text: lines.join(eol) });
    } else {
      // 末尾の行をすべて消すときは、直前の改行も消す
      const start = h.oldStart > 0 ? starts[h.oldStart]! - eol.length : 0;
      edits.push({ start: Math.max(0, start), end: original.length, text: "" });
    }
  }
  return edits;
}

/** textEdits の結果を適用する(テスト・検証用) */
export function applyTextEdits(original: string, edits: TextEdit[]): string {
  let out = original;
  for (const e of [...edits].sort((x, y) => y.start - x.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/** 変更前の行番号 → 変更後の行番号(どちらも1始まり)。書き換え・削除された行は undefined。 */
export interface LineMapper {
  toCurrent(originalLine: number): number | undefined;
  toOriginal(currentLine: number): number | undefined;
}

export function lineMapper(original: string, current: string): LineMapper {
  if (original === current) {
    return { toCurrent: (l) => l, toOriginal: (l) => l };
  }
  const forward = new Map<number, number>();
  const backward = new Map<number, number>();
  for (const [i, j] of matchedLines(splitLines(original), splitLines(current))) {
    forward.set(i + 1, j + 1);
    backward.set(j + 1, i + 1);
  }
  return { toCurrent: (l) => forward.get(l), toOriginal: (l) => backward.get(l) };
}

/** 変更後のうち、変更前に無い(=書き換え・追加された)行番号(1始まり) */
export function changedCurrentLines(original: string, current: string): Set<number> {
  const out = new Set<number>();
  for (const h of diffHunks(splitLines(original), splitLines(current))) {
    for (let k = 0; k < h.newCount; k++) {
      out.add(h.newStart + k + 1);
    }
  }
  return out;
}

/** 追加・削除された行数 */
export function diffStat(original: string, current: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of diffHunks(splitLines(original), splitLines(current))) {
    added += h.newCount;
    removed += h.oldCount;
  }
  return { added, removed };
}
