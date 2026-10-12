import { embeddingTextOf } from "./chunker";
import { Bm25Index } from "./lexical";
import type { ChunkRecord, SearchHit } from "./types";
import { dot } from "./vectorStore";

export interface SearchOptions {
  k: number;
  /** ベクトルのみでヒットしたものに適用するコサイン類似度の下限 */
  minSimilarity: number;
}

const RRF_K = 60;
const CANDIDATES = 40;

/** BM25(識別子・文字列の完全一致に強い) + ベクトル(言い換えに強い) を RRF で統合する。 */
export class HybridIndex {
  private readonly lexical: Bm25Index;

  constructor(
    readonly chunks: ChunkRecord[],
    private readonly vectors: Map<string, Float32Array>,
  ) {
    this.lexical = new Bm25Index(chunks.map((c) => embeddingTextOf(c.file, c)));
  }

  get vectorCoverage(): number {
    if (this.chunks.length === 0) {
      return 0;
    }
    const covered = this.chunks.filter((c) => this.vectors.has(c.hash)).length;
    return covered / this.chunks.length;
  }

  hasVectors(): boolean {
    return this.chunks.some((c) => this.vectors.has(c.hash));
  }

  documentFrequency(token: string): number {
    return this.lexical.df(token);
  }

  search(query: string, queryVector: Float32Array | undefined, options: SearchOptions): SearchHit[] {
    const lex = this.lexical.search(query, CANDIDATES);
    const vec: Array<{ doc: number; similarity: number }> = [];
    if (queryVector) {
      this.chunks.forEach((chunk, doc) => {
        const v = this.vectors.get(chunk.hash);
        if (v) {
          const similarity = dot(queryVector, v);
          if (similarity >= options.minSimilarity) {
            vec.push({ doc, similarity });
          }
        }
      });
      vec.sort((a, b) => b.similarity - a.similarity);
      vec.length = Math.min(vec.length, CANDIDATES);
    }

    const merged = new Map<number, SearchHit>();
    const touch = (doc: number): SearchHit => {
      let hit = merged.get(doc);
      if (!hit) {
        hit = { chunk: this.chunks[doc]!, score: 0 };
        merged.set(doc, hit);
      }
      return hit;
    };
    lex.forEach((r, rank) => {
      const hit = touch(r.doc);
      hit.lexRank = rank + 1;
      hit.score += 1 / (RRF_K + rank + 1);
    });
    vec.forEach((r, rank) => {
      const hit = touch(r.doc);
      hit.vecRank = rank + 1;
      hit.similarity = r.similarity;
      hit.score += 1 / (RRF_K + rank + 1);
    });
    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, options.k);
  }
}
