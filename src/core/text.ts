import * as crypto from "node:crypto";

export function sha1(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex");
}

/** 大まかなトークン数の見積り(ASCII≒3.5文字/トークン、CJK≒1文字/トークン)。課金の目安表示用。 */
export function estimateTokens(value: string): number {
  let wide = 0;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) >= 0x2e80) {
      wide++;
    }
  }
  return Math.ceil((value.length - wide) / 3.5 + wide);
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** 各行の開始オフセット(0始まり)。 */
export function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      starts.push(i + 1);
    }
  }
  return starts;
}

/** オフセットが属する行番号(1始まり)。 */
export function offsetToLine(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo + 1;
}

export function numberLines(lines: string[], startLine: number): string {
  return lines.map((line, i) => `L${startLine + i}| ${line}`).join("\n");
}

export function truncate(value: string, max: number, note = "…(省略)"): string {
  return value.length <= max ? value : value.slice(0, max) + note;
}

/** 簡易シード付き乱数(テストで再現可能にするため)。 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function shuffle<T>(items: T[], rng: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** LLM の JSON 出力を読む(```json の囲みがあれば外す)。読めなければ例外 */
export function parseJson<T>(content: string | null | undefined): T {
  return JSON.parse((content ?? "").replace(/^```json\s*|```\s*$/g, "").trim()) as T;
}
