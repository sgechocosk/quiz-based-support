import * as assert from "node:assert/strict";
import { test } from "node:test";
import { LearnerLog, nextBox, INTERVAL_DAYS } from "../../core/learnerLog";
import {
  applyItemToText,
  countBlanks,
  gradeBlanks,
  isolateBlank,
  isSameCode,
  locateRange,
  resolveBlanks,
  tokenizeCode,
  validateRawItem,
  type RawItem,
} from "../../core/quiz";
import type { KeyValueStore } from "../../core/ports";

const FILE = [
  "import { a } from './a';",
  "",
  "export function check(a: number, b: number): boolean {",
  "  if (a < 2 && b > 0) {",
  "    return a !== b;",
  "  }",
  "  const url = 'http://example.com'; // not a comment in string",
  "  return false;",
  "}",
].join("\n");

const raw = (over: Partial<RawItem> = {}): RawItem => ({
  kind: "read",
  path: "src/x.ts",
  startLine: 3,
  endLine: 9,
  firstLine: "export function check(a: number, b: number): boolean {",
  lastLine: "}",
  quizCode: [
    "export function check(a: number, b: number): boolean {",
    "  if (___BLANK___) {",
    "    return ___BLANK___;",
    "  }",
    "  const url = 'http://example.com'; // not a comment in string",
    "  return false;",
    "}",
  ].join("\n"),
  blanks: [
    { answer: "a < 2 && b > 0", concept: "条件式", hintConcept: "c1", hintApproach: "a1", hintSyntax: "s1" },
    { answer: "a !== b", concept: "比較", hintConcept: "c2", hintApproach: "a2", hintSyntax: "s2" },
  ],
  explanation: "e",
  ...over,
});

test("resolveBlanks は $& などの特殊置換パターンを解釈しない", () => {
  assert.equal(resolveBlanks("x = ___BLANK___;", ["$& + $1"]), "x = $& + $1;");
  assert.equal(countBlanks("___BLANK___ and ___BLANK___"), 2);
  assert.equal(isolateBlank("a ___BLANK___ b ___BLANK___", ["X", "Y"], 1), "a X b ___BLANK___");
});

test("トークン比較: 空白・末尾セミコロン・引用符の違いは同一、意味の違いは別", () => {
  assert.ok(isSameCode("a<2&&b>0", "a < 2 && b > 0"));
  assert.ok(isSameCode("await foo(1, 'x');", "await foo(1,\"x\")"));
  assert.ok(isSameCode("x => x + 1", "x=>x+1"));
  assert.ok(!isSameCode("a < 2", "a <= 2"));
  assert.ok(!isSameCode("a && b", "a || b"));
  // 文字列中の // をコメントと誤認しない
  assert.deepEqual(tokenizeCode("const u = 'http://x.y'; // note"), ["const", "u", "=", '"http://x.y"']);
});

test("回帰: <, >, & を含む答えも壊れず採点・反映できる(旧実装はHTMLエスケープで破損)", async () => {
  const v = validateRawItem(raw(), FILE);
  assert.ok(v.ok, v.ok ? "" : v.reason);
  if (!v.ok) {
    return;
  }
  const grades = await gradeBlanks(v.item, ["a<2 && b>0", "a !== b"]);
  assert.deepEqual(
    grades.map((g) => g.correct),
    [true, true],
  );
  const change = { ...v.item, kind: "change" as const, quizCode: v.item.quizCode.replace("a !== b", "___BLANK___ && b > 1") };
  change.blanks = [v.item.blanks[0]!, { ...v.item.blanks[1]!, answer: "a !== b" }];
  const applied = applyItemToText(FILE, change);
  assert.ok(applied.includes("if (a < 2 && b > 0)"), applied);
  assert.ok(!/&lt;|&gt;|&amp;|```/.test(applied), "HTMLエンティティ/フェンスが混入している");
});

test("回帰: 反映の検証は生テキストと比較される(旧実装は ``` 付きで常に不一致)", () => {
  const v = validateRawItem(raw({ kind: "change", quizCode: raw().quizCode.replace("a !== b", "___BLANK___"), blanks: [raw().blanks[0]!, { ...raw().blanks[1]!, answer: "a === b" }] }), FILE);
  assert.ok(v.ok, v.ok ? "" : v.reason);
  if (!v.ok) {
    return;
  }
  assert.ok(!v.item.original.includes("```"));
  const after = applyItemToText(FILE, v.item);
  assert.ok(after.includes("return a === b;"));
  // ファイルが変わっていたら安全のため中止
  assert.throws(() => applyItemToText(FILE.replace("a < 2", "a < 3"), v.item), /変更されています/);
});

test("CRLFファイルでは改行コードを保持して反映する", () => {
  const crlf = FILE.replace(/\n/g, "\r\n");
  const v = validateRawItem(raw({ kind: "change", quizCode: raw().quizCode.replace("a !== b", "___BLANK___"), blanks: [raw().blanks[0]!, { ...raw().blanks[1]!, answer: "true" }] }), crlf);
  assert.ok(v.ok);
  if (!v.ok) {
    return;
  }
  const after = applyItemToText(crlf, v.item);
  assert.ok(after.includes("return true;"));
  assert.ok(!/[^\r]\n/.test(after), "LF単独の改行が混ざっている");
});

test("検証: LLMの行番号ずれを firstLine で補正する", () => {
  const v = validateRawItem(raw({ startLine: 1, endLine: 7 }), FILE);
  assert.ok(v.ok);
  if (v.ok) {
    assert.equal(v.item.startLine, 3);
    assert.equal(v.item.endLine, 9);
  }
  const lines = FILE.split("\n");
  assert.deepEqual(locateRange(lines, 1, 7, lines[2]!, "}"), { start: 3, end: 9 });
  assert.equal(locateRange(lines, 1, 7, "no such line", "}"), undefined);
});

test("検証: read問題は正解で埋めた結果が実コードと一致しないと不採用(幻覚の遮断)", () => {
  const bad = raw({ blanks: [raw().blanks[0]!, { ...raw().blanks[1]!, answer: "a === b" }] });
  const v = validateRawItem(bad, FILE);
  assert.ok(!v.ok);
  assert.match(v.ok ? "" : v.reason, /一致しません/);
  const mismatch = validateRawItem(raw({ quizCode: raw().quizCode + "\n___BLANK___" }), FILE);
  assert.ok(!mismatch.ok);
});

test("検証: change問題は変更がないものを不採用", () => {
  const v = validateRawItem(raw({ kind: "change" }), FILE);
  assert.ok(!v.ok);
  assert.match(v.ok ? "" : v.reason, /同じ/);
});

test("意味的採点: 厳密不一致でも判定器が同値と認めれば正解、判定器が落ちても採点は続く", async () => {
  const v = validateRawItem(raw(), FILE);
  assert.ok(v.ok);
  if (!v.ok) {
    return;
  }
  const judge = async (cases: Array<{ given: string }>) =>
    cases.map((c) => ({ equivalent: c.given === "b < 2 === false", reason: "同値" }));
  const g1 = await gradeBlanks(v.item, ["b < 2 === false", "x"], judge);
  assert.deepEqual(g1.map((g) => [g.correct, g.via]), [[true, "semantic"], [false, "none"]]);
  const g2 = await gradeBlanks(v.item, ["zzz", ""], async () => {
    throw new Error("api down");
  });
  assert.deepEqual(g2.map((g) => g.correct), [false, false]);
  assert.equal(g2[1]!.note, "未入力");
});

class MemStore implements KeyValueStore {
  m = new Map<string, unknown>();
  get<T>(k: string): T | undefined {
    return this.m.get(k) as T | undefined;
  }
  async update(k: string, v: unknown): Promise<void> {
    this.m.set(k, JSON.parse(JSON.stringify(v)));
  }
}

test("ライトナー: 間違いでbox0、ヒント無し正解で昇格、ヒント使用は据え置き", () => {
  assert.equal(nextBox(3, false, 0), 0);
  assert.equal(nextBox(2, true, 0), 3);
  assert.equal(nextBox(2, true, 1), 2);
  assert.equal(nextBox(INTERVAL_DAYS.length - 1, true, 0), INTERVAL_DAYS.length - 1);
});

test("学習記録: 間違いが復習カードになり、再正解で間隔が空き、弱点概念が集計される", async () => {
  const store = new MemStore();
  const log = new LearnerLog(store);
  const t0 = 1_000_000_000_000;
  const base = { path: "a.ts", startLine: 1, endLine: 5, concept: "非同期処理", snippet: "await ___BLANK___;", answer: "foo()", hints: ["h1", "h2", "h3"] };
  await log.record([{ ...base, correct: false, hintsUsed: 2 }, { ...base, concept: "型", answer: "number", correct: true, hintsUsed: 0 }], t0);
  assert.equal(log.snapshot().cards.length, 1, "正解・ヒント無しはカードにならない");
  assert.equal(log.dueCards(t0).length, 1);
  await log.record([{ ...base, correct: true, hintsUsed: 0 }], t0 + 1000);
  const card = log.snapshot().cards[0]!;
  assert.equal(card.box, 1);
  assert.equal(log.dueCards(t0 + 2000).length, 0, "1日後まで出題されない");
  assert.equal(log.dueCards(t0 + 2 * 86_400_000).length, 1);
  await log.record([{ ...base, correct: false, hintsUsed: 0 }], t0 + 3 * 86_400_000);
  assert.equal(log.snapshot().cards[0]!.box, 0);
  assert.equal(log.snapshot().cards[0]!.lapses, 2);
  const weak = log.weakConcepts();
  assert.equal(weak[0]!.concept, "非同期処理");
  // 永続化の往復
  const again = new LearnerLog(store);
  assert.equal(again.snapshot().cards.length, 1);
  assert.equal(again.summary(t0 + 4 * 86_400_000).sessions, 3);
});
