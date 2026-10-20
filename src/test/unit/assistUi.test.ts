import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";

/** media/assist.js(webview とテストで共用する入力補助の処理) */
interface AssistUi {
  consume(base: string, ghost: string, value: string): string | null;
  diffSegments(before: string, after: string): Array<{ text: string; kind: "keep" | "add" | "del" }>;
}

const ui = require(path.join(__dirname, "..", "..", "..", "media", "assist.js")) as AssistUi;

const join = (segs: Array<{ text: string; kind: string }>, kinds: string[]) => segs.filter((s) => kinds.includes(s.kind)).map((s) => s.text).join("");

test("打った文字が候補の先頭と同じなら縮め、食い違ったら捨てる", () => {
  assert.equal(ui.consume("索引の更新", "は、どう流れる?", "索引の更新は、"), "どう流れる?");
  assert.equal(ui.consume("索引の更新", "は、どう流れる?", "索引の更新は、どう流れる?"), "");
  assert.equal(ui.consume("索引の更新", "は、どう流れる?", "索引の更新を"), null);
  assert.equal(ui.consume("索引の更新", "は", "索引の更"), null);
});

test("置き換え案の差: 残る部分(keep)・足す部分(add)・消える部分(del)。つなぐと案と書きかけに戻る", () => {
  const before = "テストの表示を直したい。";
  const after = "`onLessonTest` で、テストが失敗したときの表示を直したい。";
  const segs = ui.diffSegments(before, after);
  assert.equal(join(segs, ["keep", "add"]), after);
  assert.equal(join(segs, ["keep", "del"]), before);
  assert.ok(segs[0]!.kind === "add" && segs[0]!.text.startsWith("`onLessonTest`"));
  assert.ok(segs.some((s) => s.kind === "keep" && s.text.includes("の表示を直したい。")));
});

test("置き換え案の差: 変わらなければ keep だけ。変わる部分に挟まれた短い共通部分は変わる部分にまとめる", () => {
  assert.deepEqual(ui.diffSegments("同じ文", "同じ文"), [{ text: "同じ文", kind: "keep" }]);
  const segs = ui.diffSegments("ログインを直す", "ログアウトを足す");
  assert.equal(join(segs, ["keep", "add"]), "ログアウトを足す");
  assert.equal(join(segs, ["keep", "del"]), "ログインを直す");
  assert.ok(segs.every((s, i) => i === 0 || s.kind !== segs[i - 1]!.kind), "同じ種類が連続しない");
});
