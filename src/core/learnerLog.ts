import type { KeyValueStore } from "./ports";
import type { Choice } from "./types";
import { sha1 } from "./text";

/** ライトナー式の復習間隔(日)。box 0 は「すぐ再出題」。 */
export const INTERVAL_DAYS = [0, 1, 3, 7, 14, 30];
const DAY = 24 * 60 * 60 * 1000;
const MAX_CARDS = 300;

export interface ReviewCard {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  concept: string;
  /** ブランクを1つだけ残したコード断片 */
  snippet: string;
  answer: string;
  hints: string[];
  /** 採点後の解説(旧データには無い) */
  why?: string;
  /** 選択肢(旧データには無い) */
  choices?: Choice[];
  box: number;
  due: number;
  attempts: number;
  lapses: number;
  lastTs: number;
}

export interface ConceptStat {
  attempts: number;
  correct: number;
  hinted: number;
}

export interface LearningData {
  version: 1;
  cards: ReviewCard[];
  concepts: Record<string, ConceptStat>;
  totals: { sessions: number; blanks: number; correct: number };
}

export interface BlankResult {
  path: string;
  startLine: number;
  endLine: number;
  concept: string;
  snippet: string;
  answer: string;
  hints: string[];
  why?: string;
  choices?: Choice[];
  correct: boolean;
  hintsUsed: number;
}

const KEY = "quizSupport.learning";

function empty(): LearningData {
  return { version: 1, cards: [], concepts: {}, totals: { sessions: 0, blanks: 0, correct: 0 } };
}

export function nextBox(box: number, correct: boolean, hintsUsed: number): number {
  if (!correct) {
    return 0;
  }
  if (hintsUsed > 0) {
    return box;
  }
  return Math.min(box + 1, INTERVAL_DAYS.length - 1);
}

export class LearnerLog {
  private data: LearningData;

  constructor(private readonly store: KeyValueStore) {
    const saved = store.get<LearningData>(KEY);
    this.data = saved && saved.version === 1 ? saved : empty();
  }

  snapshot(): LearningData {
    return this.data;
  }

  /** 1回の採点結果を記録する。間違い・ヒント使用があったブランクは復習カードになる。 */
  /** newSession: 1回の解答として数えるか(手順のように1回をステップに分けて記録するときは、最初だけ true) */
  async record(results: BlankResult[], now = Date.now(), newSession = true): Promise<void> {
    if (newSession) {
      this.data.totals.sessions++;
    }
    for (const r of results) {
      this.data.totals.blanks++;
      if (r.correct) {
        this.data.totals.correct++;
      }
      const stat = (this.data.concepts[r.concept] ??= { attempts: 0, correct: 0, hinted: 0 });
      stat.attempts++;
      if (r.correct) {
        stat.correct++;
      }
      if (r.hintsUsed > 0) {
        stat.hinted++;
      }

      const id = sha1(`${r.path}\n${r.answer}\n${r.concept}`).slice(0, 16);
      let card = this.data.cards.find((c) => c.id === id);
      if (!card && (!r.correct || r.hintsUsed > 0)) {
        card = {
          id,
          path: r.path,
          startLine: r.startLine,
          endLine: r.endLine,
          concept: r.concept,
          snippet: r.snippet,
          answer: r.answer,
          hints: r.hints,
          why: r.why,
          choices: r.choices,
          box: 0,
          due: now,
          attempts: 0,
          lapses: 0,
          lastTs: now,
        };
        this.data.cards.push(card);
      }
      if (card) {
        const box = nextBox(card.box, r.correct, r.hintsUsed);
        if (!r.correct) {
          card.lapses++;
        }
        card.box = box;
        card.due = now + (INTERVAL_DAYS[box] ?? 0) * DAY;
        card.attempts++;
        card.lastTs = now;
        card.snippet = r.snippet;
        card.why = r.why ?? card.why;
        card.choices = r.choices ?? card.choices;
        card.startLine = r.startLine;
        card.endLine = r.endLine;
      }
    }
    if (this.data.cards.length > MAX_CARDS) {
      // 習熟(高box)かつ古いものから捨てる
      this.data.cards.sort((a, b) => a.box - b.box || b.lastTs - a.lastTs);
      this.data.cards.length = MAX_CARDS;
    }
    await this.store.update(KEY, this.data);
  }

  /** 選択式問題など、復習カードにしない結果を概念別の統計にだけ反映する。 */
  async recordConceptOnly(results: Array<{ concept: string; correct: boolean }>): Promise<void> {
    for (const r of results) {
      this.data.totals.blanks++;
      if (r.correct) {
        this.data.totals.correct++;
      }
      const stat = (this.data.concepts[r.concept] ??= { attempts: 0, correct: 0, hinted: 0 });
      stat.attempts++;
      if (r.correct) {
        stat.correct++;
      }
    }
    await this.store.update(KEY, this.data);
  }

  dueCards(now = Date.now(), limit = 5): ReviewCard[] {
    return this.data.cards
      .filter((c) => c.due <= now)
      .sort((a, b) => a.box - b.box || a.due - b.due)
      .slice(0, limit);
  }

  weakConcepts(limit = 5): Array<{ concept: string; attempts: number; accuracy: number }> {
    return Object.entries(this.data.concepts)
      .filter(([, s]) => s.attempts >= 2)
      .map(([concept, s]) => ({ concept, attempts: s.attempts, accuracy: s.correct / s.attempts }))
      .sort((a, b) => a.accuracy - b.accuracy || b.attempts - a.attempts)
      .slice(0, limit);
  }

  summary(now = Date.now()): {
    sessions: number;
    blanks: number;
    accuracy: number;
    dueCount: number;
    cards: number;
    weak: Array<{ concept: string; attempts: number; accuracy: number }>;
  } {
    const { totals } = this.data;
    return {
      sessions: totals.sessions,
      blanks: totals.blanks,
      accuracy: totals.blanks > 0 ? totals.correct / totals.blanks : 0,
      dueCount: this.data.cards.filter((c) => c.due <= now).length,
      cards: this.data.cards.length,
      weak: this.weakConcepts(),
    };
  }

  async reset(): Promise<void> {
    this.data = empty();
    await this.store.update(KEY, this.data);
  }
}
