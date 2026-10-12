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
  changedLineIndexes,
  declaredNames,
  unguessableCalls,
  compactDiff,
  compactItem,
  foldRanges,
  validateRawItem,
  type RawBlank,
  type RawItem,
} from "../../core/quiz";
import { answerSkeleton, maskAnswers, revealsAnswer } from "../../core/leak";
import type { KeyValueStore } from "../../core/ports";
import { detectIntent, quizSystemPrompt, requiresChange } from "../../core/agent";
import { coerceLevel } from "../../core/level";
import { splitLines } from "../../core/text";
import type { QuizItem } from "../../core/types";

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

const blank = (line: number, target: string, over: Partial<RawBlank> = {}): RawBlank => ({
  line,
  target,
  concept: "条件式",
  hintConcept: "c",
  hintApproach: "a",
  hintSyntax: "s",
  why: "w",
  cluePath: "",
  clueLine: 0,
  clueNote: "",
  ...over,
});

const raw = (over: Partial<RawItem> = {}): RawItem => ({
  kind: "read",
  path: "src/x.ts",
  startLine: 3,
  endLine: 9,
  firstLine: "export function check(a: number, b: number): boolean {",
  lastLine: "}",
  task: "t",
  newCode: "",
  blanks: [blank(4, "a < 2 && b > 0"), blank(5, "a !== b", { concept: "比較" })],
  refs: [],
  newNames: [],
  explanation: "e",
  ...over,
});

/** FILE の 3〜9 行目を、指定の行だけ差し替えた変更後コード */
const changed = (replace: Record<number, string>): string =>
  FILE.split("\n")
    .slice(2, 9)
    .map((l, i) => replace[i + 3] ?? l)
    .join("\n");

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

test("read問題: quizCode は実コードから組み立てるので、正解で埋めると必ず原文に戻る", async () => {
  const v = validateRawItem(raw(), FILE);
  assert.ok(v.ok, v.ok ? "" : v.reason);
  if (!v.ok) {
    return;
  }
  assert.equal(resolveBlanks(v.item.quizCode, v.item.blanks.map((b) => b.answer)), v.item.original);
  assert.match(v.item.quizCode, /if \(___BLANK___\) \{\n {4}return ___BLANK___;/);
  assert.deepEqual(
    v.item.blanks.map((b) => [b.answer, b.why]),
    [
      ["a < 2 && b > 0", "w"],
      ["a !== b", "w"],
    ],
  );
  // <, >, & を含む答えも壊れず採点できる
  const grades = await gradeBlanks(v.item, ["a<2 && b>0", "a !== b"]);
  assert.deepEqual(
    grades.map((g) => g.correct),
    [true, true],
  );
});

test("read問題: 空欄の文字列の空白ゆれ・行番号ずれ・行番号プレフィックス混入を吸収する", () => {
  const v = validateRawItem(raw({ blanks: [blank(2, "L4| a<2&&b>0"), blank(9, "a!==b")] }), FILE);
  assert.ok(v.ok, v.ok ? "" : v.reason);
  if (v.ok) {
    assert.deepEqual(
      v.item.blanks.map((b) => b.answer),
      ["a < 2 && b > 0", "a !== b"],
      "答えは実コードの表記になる",
    );
    assert.equal(v.warnings.length, 0);
  }
  // blanks の順序が逆でも、出現順に並べ直す
  const rev = validateRawItem(raw({ blanks: [blank(5, "a !== b"), blank(4, "b > 0")] }), FILE);
  assert.ok(rev.ok);
  if (rev.ok) {
    assert.deepEqual(
      rev.item.blanks.map((b) => b.answer),
      ["b > 0", "a !== b"],
    );
  }
  // 同じ行に同じ文字列が2回あれば、2つ目の空欄は次の出現位置になる
  const dup = validateRawItem(raw({ blanks: [blank(3, "number"), blank(3, "number")] }), FILE);
  assert.ok(dup.ok);
  if (dup.ok) {
    assert.match(dup.item.quizCode, /a: ___BLANK___, b: ___BLANK___\)/);
  }
});

test("read問題: 実コードに無い空欄(幻覚)はその空欄だけ外し、全部無ければ不採用", () => {
  const partial = validateRawItem(raw({ blanks: [blank(4, "a < 2 && b > 0"), blank(5, "a === b")] }), FILE);
  assert.ok(partial.ok);
  if (partial.ok) {
    assert.equal(partial.item.blanks.length, 1);
    assert.match(partial.warnings[0]!, /見つかりません/);
  }
  const none = validateRawItem(raw({ blanks: [blank(5, "a === b")] }), FILE);
  assert.ok(!none.ok);
  assert.match(none.ok ? "" : none.reason, /見つかりません.*実際の内容: return a !== b;/);
  // 複数行・記号1文字の空欄は使わない
  const bad = validateRawItem(raw({ blanks: [blank(4, "{\n}"), blank(4, "(")] }), FILE);
  assert.ok(!bad.ok);
});

test("read問題: firstLine の写し間違いでも、指定範囲に空欄が全部あれば採用する", () => {
  const v = validateRawItem(raw({ firstLine: "export function check(a, b) {" }), FILE);
  assert.ok(v.ok, v.ok ? "" : v.reason);
  const wrong = validateRawItem(raw({ firstLine: "nope", startLine: 1, endLine: 2 }), FILE);
  assert.ok(!wrong.ok);
});

test("change問題: newCode から空欄を作り、反映は生テキストで比較される", () => {
  const v = validateRawItem(raw({ kind: "change", newCode: changed({ 5: "    return a === b;" }), blanks: [blank(3, "a === b")] }), FILE);
  assert.ok(v.ok, v.ok ? "" : v.reason);
  if (!v.ok) {
    return;
  }
  assert.ok(!v.item.original.includes("```"));
  const after = applyItemToText(FILE, v.item);
  assert.ok(after.includes("return a === b;"));
  assert.ok(after.includes("if (a < 2 && b > 0)"));
  assert.ok(!/&lt;|&gt;|&amp;|```/.test(after), "HTMLエンティティ/フェンスが混入している");
  // ファイルが変わっていたら安全のため中止
  assert.throws(() => applyItemToText(FILE.replace("a < 2", "a < 3"), v.item), /変更されています/);
});

test("change問題: ```フェンス付きの newCode も受け付け、CRLFを保持して反映する", () => {
  const crlf = FILE.replace(/\n/g, "\r\n");
  const v = validateRawItem(
    raw({ kind: "change", newCode: "```ts\n" + changed({ 5: "    return true;" }) + "\n```", blanks: [blank(3, "true")] }),
    crlf,
  );
  assert.ok(v.ok, v.ok ? "" : v.reason);
  if (!v.ok) {
    return;
  }
  const after = applyItemToText(crlf, v.item);
  assert.ok(after.includes("return true;"));
  assert.ok(!/[^\r]\n/.test(after), "LF単独の改行が混ざっている");
});

test("change問題: 変更が無い・変更行に空欄が無いものは不採用", () => {
  const same = validateRawItem(raw({ kind: "change", newCode: changed({}) }), FILE);
  assert.ok(!same.ok);
  assert.match(same.ok ? "" : same.reason, /同じ/);
  const noBlankOnChange = validateRawItem(
    raw({ kind: "change", newCode: changed({ 5: "    return a === b;" }), blanks: [blank(2, "a < 2")] }),
    FILE,
  );
  assert.ok(!noBlankOnChange.ok);
  assert.match(noBlankOnChange.ok ? "" : noBlankOnChange.reason, /変更した行\(3行目\)に空欄がありません/);
});

test("変更行の検出(LCS)", () => {
  assert.deepEqual([...changedLineIndexes(["a", "b", "c"], ["a", "x", "b", "  c", "y"])], [1, 4]);
  assert.deepEqual([...changedLineIndexes(["a"], ["a", ""])], [], "空行の追加は変更とみなさない");
});

test("検証: LLMの行番号ずれを firstLine で補正する(近傍に無ければ全体から探す)", () => {
  const v = validateRawItem(raw({ startLine: 1, endLine: 7 }), FILE);
  assert.ok(v.ok);
  if (v.ok) {
    assert.equal(v.item.startLine, 3);
    assert.equal(v.item.endLine, 9);
  }
  const lines = FILE.split("\n");
  assert.deepEqual(locateRange(lines, 1, 7, lines[2]!, "}"), { start: 3, end: 9 });
  assert.equal(locateRange(lines, 1, 7, "no such line", "}"), undefined);
  assert.deepEqual(locateRange(lines, 1, 2, "export function check(a: number,b: number): boolean {", "", 0), { start: 3, end: 4 });
});

test("答え漏れ: 答えそのもの・材料の識別子を全部言うヒントを検出する", () => {
  assert.ok(revealsAnswer("password.length > 3 のように書く", "password.length>3"));
  assert.ok(revealsAnswer("password の length を使う", "password.length > 3"));
  assert.ok(!revealsAnswer("password の長さを比べる", "password.length > 3"));
  assert.ok(revealsAnswer("boolean 型を返す", "boolean"));
  assert.ok(!revealsAnswer("真偽値を返す型", "boolean"));
  assert.ok(revealsAnswer("cache を参照する", "this.cache"));
  assert.ok(!revealsAnswer("EvidenceStore の仕組み", "evidence"), "識別子の一部一致は漏れではない");
  assert.ok(!revealsAnswer("login 関数を呼ぶ", "login(u, p)"), "引数まで分からなければ漏れではない");
  assert.ok(!revealsAnswer("", "x"));
});

test("答え漏れ: 伏せ字と、答えの形だけを示すヒント", () => {
  assert.equal(maskAnswers("password.length > 3 を返す", ["password.length > 3"]), "〇〇 を返す");
  assert.ok(!revealsAnswer(maskAnswers("password と length を使う", ["password.length > 3"]), "password.length > 3"));
  const shape = answerSkeleton("await this.cache.get(key)");
  assert.match(shape, /await this\.___\.___\(___\)/);
  assert.ok(!revealsAnswer(shape, "await this.cache.get(key)"));
  assert.match(answerSkeleton("count"), /1つの語/);
  assert.match(answerSkeleton('a === "x"'), /___ === \(文字列\)/);
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

const LONG = Array.from({ length: 30 }, (_, i) => `  line${i + 1}();`);
const longItem = (over: Partial<QuizItem>): QuizItem => ({
  kind: "read",
  path: "a.ts",
  startLine: 1,
  endLine: 30,
  original: LONG.join("\n"),
  quizCode: LONG.join("\n"),
  blanks: [{ answer: "x", concept: "c", hints: [] }],
  explanation: "",
  ...over,
});

test("表示量: read問題は空欄の前後3行まで範囲を切り詰める", () => {
  const q = LONG.slice();
  q[14] = "  ___BLANK___();";
  const item = compactItem(longItem({ quizCode: q.join("\n"), blanks: [{ answer: "line15", concept: "c", hints: [] }] }));
  assert.deepEqual([item.startLine, item.endLine], [12, 18]);
  assert.equal(splitLines(item.quizCode).length, 7);
  assert.equal(resolveBlanks(item.quizCode, ["line15"]), item.original);
});

test("表示量: change問題は元と同じ先頭・末尾だけ削り、反映結果は変わらない", () => {
  const after = LONG.slice();
  after.splice(20, 0, "  if (___BLANK___) return;");
  const file = LONG.join("\n");
  const full = longItem({ kind: "change", quizCode: after.join("\n"), blanks: [{ answer: "done", concept: "c", hints: [] }] });
  const item = compactItem(full);
  assert.deepEqual([item.startLine, item.endLine], [18, 23]);
  assert.equal(applyItemToText(file, item), applyItemToText(file, full));
  const diff = compactDiff(item.original, resolveBlanks(item.quizCode, ["done"]));
  assert.match(diff, /^ {4}line19\(\);\n {4}line20\(\);\n\+ {3}if \(done\) return;\n {4}line21\(\);/m);
  assert.ok(diff.split("\n").length <= 7, diff);
});

test("表示量: 空欄・変更行から離れた行を折りたたむ / 差分は変更の周辺だけ", () => {
  const q = LONG.slice();
  q[2] = "  ___BLANK___();";
  q[25] = "  ___BLANK___();";
  assert.deepEqual(foldRanges({ kind: "read", quizCode: q.join("\n"), original: "" }), [[5, 22]]);
  const diff = compactDiff(LONG.join("\n"), LONG.map((l, i) => (i === 15 ? "  changed();" : l)).join("\n"));
  assert.deepEqual(diff.split("\n"), [
    "… (13行省略)",
    "    line14();",
    "    line15();",
    "-   line16();",
    "+   changed();",
    "    line17();",
    "    line18();",
    "… (12行省略)",
  ]);
});

test("意図判定: 実装・修正の依頼か、仕組みの質問か", () => {
  assert.equal(detectIntent("ログアウト機能を追加したい"), "change");
  assert.equal(detectIntent("パスワードが短いときエラーを出すようにしたい"), "change");
  assert.equal(detectIntent("implement retry for fetch"), "change");
  assert.equal(detectIntent("ログイン処理はどう動く?"), "read");
  assert.equal(detectIntent("検索のインデックスはどこで作られる?"), "read");
  assert.ok(requiresChange("auto", "change"));
  assert.ok(!requiresChange("auto", "read"));
  assert.ok(!requiresChange("read", "change"));
  assert.ok(requiresChange("change", "read"));
});

// ---------- 新しい名前・学習レベル ----------

const SERVICE = [
  "export class TokenService {",
  "  private tokens = new Map<string, number>();",
  "",
  "  issue(user: string): string {",
  "    const token = user + Date.now();",
  "    this.tokens.set(token, Date.now() + 60_000);",
  "    return token;",
  "  }",
  "}",
].join("\n");

const serviceChange = (over: Partial<RawItem> = {}): RawItem =>
  raw({
    kind: "change",
    path: "src/token.ts",
    startLine: 1,
    endLine: 9,
    firstLine: "export class TokenService {",
    lastLine: "}",
    newCode: [
      ...SERVICE.split("\n").slice(0, 8),
      "",
      "  isExpired(token: string): boolean {",
      "    const expiresAt = this.tokens.get(token) ?? 0;",
      "    return expiresAt < Date.now();",
      "  }",
      "}",
    ].join("\n"),
    newNames: [{ name: "isExpired", role: "トークンの期限切れを判定するメソッド" }],
    blanks: [blank(11, "this.tokens.get(token)"), blank(12, "expiresAt < Date.now()")],
    ...over,
  });

test("新しい名前: newCode で定義される名前を拾う(TS/Java)", () => {
  const names = declaredNames([
    "  isExpired(token: string): boolean {",
    "    const expiresAt = this.tokens.get(token) ?? 0;",
    "    const { a, b: c } = obj;",
    "    list.map((item, i) => item.id);",
    "  public boolean isValid(Token t) {",
    "    String label = t.name();",
    "  if (ok) {",
  ]);
  for (const n of ["isExpired", "token", "expiresAt", "a", "item", "i", "isValid", "t", "label"]) {
    assert.ok(names.has(n), `${n} が拾えていない: ${[...names].join(",")}`);
  }
  assert.ok(!names.has("if"));
});

test("新しい名前: 申告と自動検出をまとめて解答前に示し、既存の名前は含めない", () => {
  const v = validateRawItem(serviceChange({ newNames: [] }), SERVICE);
  assert.ok(v.ok, v.ok ? "" : v.reason);
  if (!v.ok) {
    return;
  }
  const names = (v.item.newNames ?? []).map((n) => n.name);
  assert.ok(names.includes("isExpired") && names.includes("expiresAt"), names.join(","));
  assert.ok(!names.includes("token"), "既存ファイルにある名前は新しい名前ではない");
  const declared = validateRawItem(serviceChange(), SERVICE);
  assert.ok(declared.ok);
  if (declared.ok) {
    assert.deepEqual(declared.item.newNames![0], { name: "isExpired", role: "トークンの期限切れを判定するメソッド" });
  }
});

test("新しい名前: 名前そのものの空欄と、どこにも無い関数を答えにする空欄は外す", () => {
  const v = validateRawItem(serviceChange({ blanks: [blank(10, "isExpired"), blank(12, "expiresAt < Date.now()")] }), SERVICE);
  assert.ok(v.ok, v.ok ? "" : v.reason);
  if (v.ok) {
    assert.deepEqual(v.item.blanks.map((b) => b.answer), ["expiresAt < Date.now()"]);
    assert.match(v.warnings.join("\n"), /新しく作る名前そのものは空欄にしません/);
  }
  const ghost = serviceChange({
    newCode: serviceChange().newCode.replace("this.tokens.get(token) ?? 0", "lookupExpiry(token)"),
    blanks: [blank(11, "lookupExpiry(token)")],
  });
  const g = validateRawItem(ghost, SERVICE);
  assert.ok(!g.ok);
  assert.match(g.ok ? "" : g.reason, /lookupExpiry は既存コードにも表示中のコードにも無く/);
  // 調査で読んだ別ファイルにある関数なら推測できるので残す
  const known = validateRawItem(ghost, SERVICE, { knownText: "export function lookupExpiry(t: string) {}" });
  assert.ok(known.ok);
  // 標準の関数・メソッド呼び出しは対象外
  assert.deepEqual(unguessableCalls("Math.max(parseInt(x), arr.filter(f).length)", new Set()), []);
});

test("答え漏れ: 解答前に示す新しい名前は、漏れの判定材料にしない", () => {
  // 課題文で「isExpired は token を受け取る」と仕様を示しても、どう使うか(三項演算子の中身)までは分からない
  const spec = "isExpired は token を受け取るメソッドです";
  assert.ok(revealsAnswer(spec, "isExpired(token) ? 401 : 200"));
  assert.ok(!revealsAnswer(spec, "isExpired(token) ? 401 : 200", new Set(["isExpired"])));
  assert.ok(revealsAnswer("isExpired で token を調べる", "isExpired(token)", new Set(["isExpired"])), "呼び出し方まで言えば漏れ");
  assert.ok(revealsAnswer("isExpired(token) を書く", "isExpired(token)", new Set(["isExpired"])), "答えそのものは漏れ");
});

test("学習レベル: レベルごとに用語・空欄数・解説の方針が変わり、飛躍を避ける指示は共通", () => {
  const beginner = quizSystemPrompt("auto", "read", "beginner");
  const advanced = quizSystemPrompt("auto", "read", "advanced");
  assert.match(beginner, /初学者・学生/);
  assert.match(beginner, /初出で短く言い換える/);
  assert.match(advanced, /不変条件/);
  assert.ok(!advanced.includes("初出で短く言い換える"));
  for (const p of [beginner, advanced, quizSystemPrompt("auto", "read")]) {
    assert.match(p, /途中の段階を省かない/);
    assert.match(p, /newNames に \{name, role\}/);
  }
  assert.match(quizSystemPrompt("auto", "read"), /実務エンジニア/, "既定は実務レベル");
  assert.match(quizSystemPrompt("auto", "change"), /kind="read" を最大2問含めてよい/);
  assert.equal(coerceLevel("advanced"), "advanced");
  assert.equal(coerceLevel("expert"), "intermediate");
});
