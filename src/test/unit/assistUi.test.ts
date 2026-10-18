import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";

/** media/assist.js(webview とテストで共用する入力補助の処理) */
interface AssistUi {
  meaningfulLength(text: string): number;
  consume(base: string, ghost: string, value: string): string | null;
  nextSegment(ghost: string): string;
  identifierBefore(text: string, caret: number): { start: number; prefix: string } | undefined;
  nameGhost(prefix: string, names: string[]): { text: string; count: number };
  diffSegments(before: string, after: string): Array<{ text: string; added: boolean }>;
  composeInstruction(instruction: string, questions: Array<{ slot: string }>, answers: Array<{ text: string } | undefined>, keepSlots?: boolean, intent?: string): string;
  UNDECIDED: string;
}

// out/test/unit から見たリポジトリ直下の media/assist.js
const ui = require(path.join(__dirname, "..", "..", "..", "media", "assist.js")) as AssistUi;

test("候補を打った文字で縮め、食い違ったら捨てる", () => {
  assert.equal(ui.consume("索引の更新", "は、どう流れる?", "索引の更新は、"), "どう流れる?");
  assert.equal(ui.consume("索引の更新", "は、どう流れる?", "索引の更新は、どう流れる?"), "");
  assert.equal(ui.consume("索引の更新", "は、どう流れる?", "索引の更新を"), null);
  assert.equal(ui.consume("索引の更新", "は", "索引の更"), null);
});

test("1語ずつの受け入れ: 前の記号を含めて1語、バッククォートの名前は閉じるまで", () => {
  assert.equal(ui.nextSegment("は、どう流れる?"), "は");
  assert.equal(ui.nextSegment("、どう流れる?"), "、どう");
  assert.equal(ui.nextSegment(" `IndexManager.commit` まで"), " `IndexManager.commit`");
  assert.equal(ui.nextSegment(" add a button"), " add");
  assert.equal(ui.nextSegment(""), "");
});

test("カーソルの直前の名前: 英数字3文字以上・名前の途中では出さない・a.b は最後の部分・パスは全体", () => {
  assert.deepEqual(ui.identifierBefore("索引の IndexMan", 12), { start: 4, prefix: "IndexMan" });
  assert.equal(ui.identifierBefore("索引の In", 6), undefined);
  assert.equal(ui.identifierBefore("IndexManager", 5), undefined, "名前の途中");
  assert.deepEqual(ui.identifierBefore("IndexManager.com", 16), { start: 13, prefix: "com" });
  assert.deepEqual(ui.identifierBefore("見るのは src/co", 11), { start: 5, prefix: "src/co" });
  assert.equal(ui.identifierBefore("ログイン", 4), undefined);
});

test("名前の候補: 1つなら全体、複数なら共通の先頭まで。大文字小文字が違う名前は薄く出さない", () => {
  assert.deepEqual(ui.nameGhost("hand", ["handleAsk"]), { text: "leAsk", count: 1 });
  assert.deepEqual(ui.nameGhost("hand", ["handleAsk", "handleApply", "Handler"]), { text: "leA", count: 2 });
  assert.deepEqual(ui.nameGhost("hand", ["HandleAsk"]), { text: "", count: 0 });
  assert.deepEqual(ui.nameGhost("handleAsk", ["handleAsk"]), { text: "", count: 0 });
});

test("書き直し案の差: 書きかけに無かった部分だけに印を付ける", () => {
  const seg = ui.diffSegments("テストの表示を直したい", "`onLessonTest` で、テストが失敗したときの表示を直したい");
  assert.equal(seg.map((s) => s.text).join(""), "`onLessonTest` で、テストが失敗したときの表示を直したい");
  assert.deepEqual(
    seg.filter((s) => !s.added).map((s) => s.text).join(""),
    "テストの表示を直したい",
  );
  assert.ok(seg[0]!.added);
});

test("決めることの答えを入れる: 答えたものは置き換え、答えていないものは「まだ決めていない」として送る", () => {
  const instruction = "`onLessonTest` で、テストが失敗したときに〔表示する内容〕も出すようにしたい。〔範囲〕";
  const questions = [{ slot: "〔表示する内容〕" }];
  assert.equal(
    ui.composeInstruction(instruction, questions, [{ text: "終了コード" }]),
    `\`onLessonTest\` で、テストが失敗したときに終了コードも出すようにしたい。範囲${ui.UNDECIDED}`,
  );
  assert.equal(ui.composeInstruction(instruction, questions, [undefined], true), instruction);
  assert.equal(
    ui.composeInstruction(instruction, questions, [{ text: " " }]),
    `\`onLessonTest\` で、テストが失敗したときに表示する内容${ui.UNDECIDED}も出すようにしたい。範囲${ui.UNDECIDED}`,
  );
  assert.equal(ui.meaningfulLength(" a b\nc "), 3);
  // 読み解きの質問では、答えなかった〔 〕を文から除く(送ったあとの確認が無いため)
  const read = "`IndexManager` の更新はどう流れる?(特に〔知りたいこと〕)";
  assert.equal(ui.composeInstruction(read, [{ slot: "〔知りたいこと〕" }], [undefined], false, "read"), "`IndexManager` の更新はどう流れる?");
  assert.equal(ui.composeInstruction(read, [{ slot: "〔知りたいこと〕" }], [{ text: "呼び出し元" }], false, "read"), "`IndexManager` の更新はどう流れる?(特に呼び出し元)");
  assert.equal(ui.composeInstruction("〔対象〕の流れはどう動く?", [], [], false, "read"), `対象${ui.UNDECIDED}の流れはどう動く?`, "文の中の〔 〕は除かない");
  assert.equal(ui.composeInstruction("〔したいこと〕", [{ slot: "〔したいこと〕" }], [undefined], false, "read"), `したいこと${ui.UNDECIDED}`);
});
