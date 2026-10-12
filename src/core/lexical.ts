const TOKEN_RE =
  /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+)|([A-Za-z0-9_$]+)|([\p{L}\p{N}_$]+)/gu;

export function splitIdentifier(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_$]+/)
    .map((p) => p.toLowerCase())
    .filter((p) => p.length >= 2);
}

/** 識別子(camelCase/snake_case分割付き)と日本語(2-gram)を扱うトークナイザ。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m[1]) {
      const run = m[1];
      if (run.length === 1) {
        tokens.push(run);
      } else {
        for (let i = 0; i < run.length - 1; i++) {
          tokens.push(run.slice(i, i + 2));
        }
      }
    } else {
      const word = (m[2] ?? m[3])!;
      const lower = word.toLowerCase();
      if (lower.length >= 2) {
        tokens.push(lower);
      }
      const parts = splitIdentifier(word);
      if (parts.length > 1) {
        tokens.push(...parts);
      }
    }
  }
  return tokens;
}

export interface Bm25Result {
  doc: number;
  score: number;
}

export class Bm25Index {
  private readonly postings = new Map<string, Array<[number, number]>>();
  private readonly docLength: number[] = [];
  private readonly avgLength: number;
  private static readonly K1 = 1.2;
  private static readonly B = 0.75;

  constructor(docs: string[]) {
    let total = 0;
    docs.forEach((doc, index) => {
      const tokens = tokenize(doc);
      this.docLength.push(tokens.length);
      total += tokens.length;
      const tf = new Map<string, number>();
      for (const t of tokens) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
      }
      for (const [term, count] of tf) {
        let list = this.postings.get(term);
        if (!list) {
          list = [];
          this.postings.set(term, list);
        }
        list.push([index, count]);
      }
    });
    this.avgLength = docs.length > 0 ? total / docs.length : 0;
  }

  get size(): number {
    return this.docLength.length;
  }

  /** そのトークンを含む文書数 */
  df(token: string): number {
    return this.postings.get(token)?.length ?? 0;
  }

  search(query: string, k: number): Bm25Result[] {
    const n = this.docLength.length;
    if (n === 0) {
      return [];
    }
    const terms = [...new Set(tokenize(query))];
    const scores = new Map<number, number>();
    for (const term of terms) {
      const list = this.postings.get(term);
      if (!list) {
        continue;
      }
      const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
      for (const [doc, tf] of list) {
        const norm =
          1 - Bm25Index.B + Bm25Index.B * ((this.docLength[doc] ?? 0) / (this.avgLength || 1));
        const s = idf * ((tf * (Bm25Index.K1 + 1)) / (tf + Bm25Index.K1 * norm));
        scores.set(doc, (scores.get(doc) ?? 0) + s);
      }
    }
    return [...scores.entries()]
      .map(([doc, score]) => ({ doc, score }))
      .sort((a, b) => b.score - a.score || a.doc - b.doc)
      .slice(0, k);
  }
}
