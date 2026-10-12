import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { Bm25Index, tokenize } from "../../core/lexical";
import { IgnoreFilter, DEFAULT_IGNORES } from "../../core/ignore";
import { IndexManager } from "../../core/indexer";
import { decodeVectors, encodeVectors, normalizeVector } from "../../core/vectorStore";
import { FakeEmbedder, makeTempDir, NodeWorkspace, writeFiles } from "./helpers/nodeWorkspace";
import { TsCompilerParser } from "./helpers/tsAst";

test("トークナイザ: camelCase/snake_case分割と日本語2-gram", () => {
  const t = tokenize("getUserName user_id ログイン処理");
  for (const expected of ["getusername", "get", "user", "name", "user_id", "id", "ログ", "グイ", "イン", "ン処", "処理"]) {
    assert.ok(t.includes(expected), `${expected} が含まれない: ${t.join(",")}`);
  }
});

test("BM25: 識別子の部分一致と順位", () => {
  const docs = ["function fetchUserProfile() {}", "const total = items.length", "class UserRepository {}"];
  const idx = new Bm25Index(docs);
  const r = idx.search("user profile", 3);
  assert.equal(r[0]!.doc, 0);
  assert.equal(idx.search("zzzz", 3).length, 0);
});

test("ベクトルのバイナリ保存は往復で一致する", () => {
  const m = new Map<string, Float32Array>([
    ["a", normalizeVector([1, 2, 3, 4])],
    ["b", normalizeVector([4, 3, 2, 1])],
  ]);
  const back = decodeVectors(encodeVectors(m));
  assert.deepEqual([...back.keys()], ["a", "b"]);
  assert.ok(Math.abs(back.get("a")![2]! - m.get("a")![2]!) < 1e-6);
  assert.throws(() => decodeVectors(Buffer.from("garbage!!")));
});

test(".gitignore風フィルタ", () => {
  const f = new IgnoreFilter([...DEFAULT_IGNORES, "# c", "/secret/", "*.log", "!keep.log", "docs/**/draft*.md"]);
  assert.ok(f.isIgnored("node_modules/x/index.js"));
  assert.ok(f.isIgnored("a/b/node_modules/x.js"));
  assert.ok(f.isIgnored("secret/key.ts"));
  assert.ok(!f.isIgnored("src/secret/key.ts"));
  assert.ok(f.isIgnored("run.log"));
  assert.ok(!f.isIgnored("keep.log"));
  assert.ok(f.isIgnored("docs/a/b/draft1.md"));
  assert.ok(!f.isIgnored("src/index.ts"));
});

const FILES = {
  "src/auth.ts": `export function login(user: string, password: string): boolean {\n  return password.length > 3 && user !== "";\n}\n\nexport function logout(user: string): void {\n  console.log("bye", user);\n}\n`,
  "src/cart.ts": `export class Cart {\n  items: number[] = [];\n  add(price: number): void {\n    this.items.push(price);\n  }\n  total(): number {\n    return this.items.reduce((a, b) => a + b, 0);\n  }\n}\n`,
  "docs/note.md": "# メモ\nログイン処理の仕様メモ\n",
  "node_modules/lib/index.js": "module.exports = 1;\n",
  "ignored.ts": "export const ignoredByGitignore = 1;\n",
  ".gitignore": "ignored.ts\n",
};

async function setup() {
  const root = await makeTempDir();
  await writeFiles(root, FILES);
  const ws = new NodeWorkspace(root);
  await ws.loadGitignore();
  const embedder = new FakeEmbedder();
  let enabled = true;
  const mgr = new IndexManager({
    dir: path.join(root, ".idx"),
    workspace: ws,
    parser: new TsCompilerParser(),
    embedder: () => (enabled ? embedder : undefined),
    embeddingModel: () => "fake-embed",
  });
  return { root, ws, embedder, mgr, setEnabled: (v: boolean) => (enabled = v) };
}

test("初回: gitignore/node_modulesを除外し、埋め込みなしでもBM25検索できる", async () => {
  const { mgr } = await setup();
  await mgr.load();
  const plan = await mgr.prepare();
  assert.equal(plan.changedFiles, 3);
  const stats = await mgr.commit(plan, { embed: false });
  assert.equal(stats.files, 3);
  assert.equal(stats.vectors, 0);
  const r = await mgr.search("login password", { k: 3, minSimilarity: 0.1 });
  assert.equal(r.semantic, false);
  assert.equal(r.hits[0]!.chunk.file, "src/auth.ts");
  const jp = await mgr.search("ログイン", { k: 3, minSimilarity: 0.1 });
  assert.equal(jp.hits[0]!.chunk.file, "docs/note.md");
});

test("差分更新: 変更ファイルだけ再処理し、行がずれただけのチャンクは再埋め込みしない", async () => {
  const { root, mgr, embedder } = await setup();
  await mgr.load();
  let plan = await mgr.prepare();
  await mgr.commit(plan, { embed: true });
  const firstTexts = embedder.texts;
  assert.ok(firstTexts > 0);

  // 変更なし → 差分ゼロ
  plan = await mgr.prepare();
  assert.equal(plan.changedFiles, 0);
  assert.equal(plan.pendingEmbeds.length, 0);

  // 先頭に空行を足して行番号だけずらす(内容は同じ)→ チャンクはキャッシュ命中
  const p = path.join(root, "src/cart.ts");
  await fs.writeFile(p, "\n\n" + FILES["src/cart.ts"]);
  const future = new Date(Date.now() + 5000);
  await fs.utimes(p, future, future);
  plan = await mgr.prepare();
  assert.equal(plan.changedFiles, 1);
  assert.equal(plan.pendingEmbeds.length, 0, "行ずれのみなら埋め込み不要のはず");
  await mgr.commit(plan, { embed: true });
  assert.equal(embedder.texts, firstTexts);

  // 内容を変更 → その分だけ埋め込み
  await fs.writeFile(p, FILES["src/cart.ts"].replace("reduce((a, b) => a + b, 0)", "reduce((a, b) => a + b, 100)"));
  const future2 = new Date(Date.now() + 9000);
  await fs.utimes(p, future2, future2);
  plan = await mgr.prepare();
  assert.ok(plan.pendingEmbeds.length >= 1 && plan.pendingEmbeds.length <= 2);
  await mgr.commit(plan, { embed: true });

  // 削除
  await fs.rm(path.join(root, "src/auth.ts"));
  plan = await mgr.prepare();
  assert.equal(plan.removedFiles, 1);
  const stats = await mgr.commit(plan, { embed: true });
  assert.equal(stats.files, 2);
  assert.equal(mgr.fileChunks("src/auth.ts").length, 0);
});

test("保存→再読込で状態が復元され、ハイブリッド検索が動く", async () => {
  const { root, ws, mgr, embedder } = await setup();
  await mgr.load();
  await mgr.commit(await mgr.prepare(), { embed: true });
  const again = new IndexManager({
    dir: path.join(root, ".idx"),
    workspace: ws,
    embedder: () => embedder,
    embeddingModel: () => "fake-embed",
  });
  await again.load();
  const stats = again.stats();
  assert.equal(stats.files, 3);
  assert.equal(stats.coverage, 1);
  const r = await again.search("add price to the cart items", { k: 3, minSimilarity: 0 });
  assert.equal(r.semantic, true);
  assert.equal(r.hits[0]!.chunk.file, "src/cart.ts");

  // 埋め込みモデルを変えるとベクトルは破棄(次元/意味が違うため)
  const other = new IndexManager({
    dir: path.join(root, ".idx"),
    workspace: ws,
    embedder: () => embedder,
    embeddingModel: () => "another-model",
  });
  await other.load();
  assert.equal(other.stats().vectors, 0);
});

test("埋め込み失敗時もチャンクと作成済みベクトルは保存され、検索はBM25にフォールバック", async () => {
  const { root, ws, mgr } = await setup();
  let calls = 0;
  const flaky = {
    async embed(texts: string[]) {
      calls++;
      if (calls >= 2) {
        throw new Error("rate limited");
      }
      return texts.map(() => [1, 0, 0]);
    },
  };
  const m = new IndexManager({
    dir: path.join(root, ".idx2"),
    workspace: ws,
    embedder: () => flaky,
    embeddingModel: () => "x",
    embedBatchSize: 1,
  });
  await m.load();
  const plan = await m.prepare();
  await assert.rejects(m.commit(plan, { embed: true }), /rate limited/);
  const st = m.stats();
  assert.equal(st.files, 3);
  assert.equal(st.vectors, 1);
  const r = await m.search("login", { k: 3, minSimilarity: 0.1 });
  assert.ok(r.hits.length > 0);
  void mgr;
});

test("リポジトリマップ: 参照されるシンボルを持つファイルが上位に来る", async () => {
  const root = await makeTempDir();
  await writeFiles(root, {
    "src/core.ts": "export function coreHelper() { return 1; }\n",
    "src/leaf.ts": "export function leafOnly() { return 2; }\n",
    "src/a.ts": "import { coreHelper } from './core';\nexport const a = coreHelper();\n",
    "src/b.ts": "import { coreHelper } from './core';\nexport const b = coreHelper();\n",
  });
  const ws = new NodeWorkspace(root);
  const m = new IndexManager({
    dir: path.join(root, ".idx"),
    workspace: ws,
    parser: new TsCompilerParser(),
    embedder: () => undefined,
    embeddingModel: () => "x",
  });
  await m.load();
  await m.commit(await m.prepare(), { embed: false });
  const map = m.repoMap(2000).split("\n");
  assert.ok(map[0]!.startsWith("src/core.ts"), map.join("|"));
  assert.ok(m.repoMap(30).length <= 30);
});
