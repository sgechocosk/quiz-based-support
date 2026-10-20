import { execFileSync } from "node:child_process";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { GitHistory } from "../../host/gitHistory";
import { buildOverview, OVERVIEW_CHARS, summarizeDoc, summarizePackage, summarizeTree } from "../../core/overview";
import { makeTempDir, NodeWorkspace, writeFiles } from "./helpers/nodeWorkspace";

test("文書の要点: 冒頭の説明と見出しの一覧(コードブロックの中の見出しは除く)", () => {
  const md = "# 題名\n\nこれは説明です。\n\n```\n# コメント\n```\n\n## 使い方\n## 設定\n";
  const out = summarizeDoc(md);
  assert.match(out, /これは説明です。/);
  assert.match(out, /見出し: 題名 \/ 使い方 \/ 設定/);
  assert.ok(!out.includes("コメント"));
});

test("package.json の要点: 名前・説明・スクリプト・VS Code のコマンドと設定キー。壊れていれば空", () => {
  const out = summarizePackage(
    JSON.stringify({ name: "x", displayName: "拡張", description: "説明", scripts: { test: "t" }, contributes: { commands: [{ command: "x.run", title: "実行" }], configuration: { properties: { "x.a": {}, "x.b": {} } } } }),
  );
  assert.match(out, /拡張 \/ x: 説明/);
  assert.match(out, /スクリプト: test/);
  assert.match(out, /x\.run\(実行\)/);
  assert.match(out, /設定キー: x\.a, x\.b/);
  assert.equal(summarizePackage("{broken"), "");
});

test("ディレクトリ構成: 上位2階層のファイル数", () => {
  assert.equal(summarizeTree(["src/core/a.ts", "src/core/b.ts", "src/host/c.ts", "README.md"]), "src/core/(2) (直下)(1) src/host/(1)");
});

test("全体像: README・package.json・プロジェクトの約束・構成・構成の地図を集め、上限に収める。無いファイルは飛ばす", async () => {
  const root = await makeTempDir();
  await writeFiles(root, {
    "README.md": "# 拡張\n\nコードを調べて変更を組み立てる。\n\n## 動作の流れ\n",
    "package.json": JSON.stringify({ name: "x", description: "説明" }),
    ".quiz-support/patterns.json": JSON.stringify([{ name: "設定の登録", when: { literal: "^x\\." }, check: ["package.json"], criterion: "設定を足したら package.json にも書く" }]),
    "src/a.ts": "export const a = 1;\n",
  });
  const out = await buildOverview(new NodeWorkspace(root), "src/a.ts — a");
  for (const needle of ["【プロジェクト】", "x: 説明", "【README.mdの要点】", "動作の流れ", "【プロジェクトの約束", "設定の登録", "【ディレクトリ構成", "【構成の地図", "src/a.ts — a"]) {
    assert.ok(out.includes(needle), needle);
  }
  assert.ok(!out.includes("CLAUDE.md"));
  const empty = await makeTempDir();
  assert.equal(await buildOverview(new NodeWorkspace(empty), ""), "");
  assert.ok((await buildOverview(new NodeWorkspace(root), "x".repeat(20_000))).length <= OVERVIEW_CHARS);
});

test("未コミットの変更があるファイル: 変更・新規・名前の変更を、ワークスペース相対で返す", async () => {
  const root = await makeTempDir();
  await writeFiles(root, { "a.ts": "1\n", "b.ts": "2\n" });
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  await writeFiles(root, { "a.ts": "changed\n", "c.ts": "new\n" });
  git("mv", "b.ts", "d.ts");
  assert.deepEqual((await new GitHistory(root).changedFiles()).sort(), ["a.ts", "c.ts", "d.ts"]);
  assert.deepEqual(await new GitHistory(await makeTempDir()).changedFiles(), [], "git のフォルダでなければ空");
});
