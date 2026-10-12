import * as assert from "node:assert/strict";
import { test } from "node:test";
import { chunkFile, DEFAULT_CHUNK_OPTIONS, languageForPath, chunkByLines } from "../../core/chunker";
import { TsCompilerParser } from "./helpers/tsAst";

const opts = { ...DEFAULT_CHUNK_OPTIONS, maxChars: 400 };
const nonWs = (s: string): string => s.replace(/\s+/g, "");

function bigClass(methods: number): string {
  const body = Array.from({ length: methods }, (_, i) =>
    [
      `  method${i}(input: number): number {`,
      `    const doubled = input * ${i + 2};`,
      `    if (doubled > 100) { return doubled - ${i}; }`,
      `    return doubled + ${i};`,
      `  }`,
    ].join("\n"),
  ).join("\n\n");
  return `import { x } from "./x";\n\nexport class Calculator {\n  private total = 0;\n\n${body}\n}\n`;
}

test("小さいファイルは1チャンクにまとまる", async () => {
  const text = "export const a = 1;\nexport function f() { return a; }\n";
  const chunks = await chunkFile("src/a.ts", text, new TsCompilerParser(), opts);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.startLine, 1);
  assert.equal(chunks[0]!.endLine, 2);
});

test("巨大クラスも欠落なく分割され、全文字が重複なく網羅される", async () => {
  const text = bigClass(30);
  const chunks = await chunkFile("src/calc.ts", text, new TsCompilerParser(), opts);
  assert.ok(chunks.length > 3, `チャンク数=${chunks.length}`);
  // 網羅性: チャンクを連結すると元の(空白除く)文字列に一致する
  assert.equal(nonWs(chunks.map((c) => c.text).join("")), nonWs(text));
  // サイズ上限
  for (const c of chunks) {
    assert.ok(nonWs(c.text).length <= opts.maxChars, `超過: ${nonWs(c.text).length}`);
  }
  // 行番号は単調増加で、テキストの行数と一致
  let last = 0;
  for (const c of chunks) {
    assert.ok(c.startLine >= last, "行番号が逆戻りしている");
    assert.equal(c.endLine - c.startLine + 1, c.text.split("\n").length);
    last = c.endLine;
  }
});

test("後続チャンクには囲むクラス名がスコープとして付く(300行超でも捨てない)", async () => {
  const chunks = await chunkFile("src/calc.ts", bigClass(30), new TsCompilerParser(), opts);
  const inner = chunks.slice(2);
  assert.ok(inner.every((c) => c.scope.includes("Calculator")), JSON.stringify(inner.map((c) => c.scope)));
  const names = chunks.flatMap((c) => c.symbols);
  assert.ok(names.includes("Calculator"));
});

test("分割できない巨大リテラルも行単位で分割される", async () => {
  const items = Array.from({ length: 200 }, (_, i) => `  "item-number-${i}-with-some-padding",`).join("\n");
  const text = `export const LIST = [\n${items}\n];\n`;
  const chunks = await chunkFile("src/list.ts", text, new TsCompilerParser(), opts);
  assert.equal(nonWs(chunks.map((c) => c.text).join("")), nonWs(text));
  assert.ok(chunks.every((c) => nonWs(c.text).length <= opts.maxChars + 80));
});

test("パーサなし/非対応言語は行ベース(オーバーラップ付き)", async () => {
  const text = Array.from({ length: 130 }, (_, i) => `line ${i + 1}`).join("\n");
  const chunks = await chunkFile("tool.py", text, undefined, DEFAULT_CHUNK_OPTIONS);
  assert.deepEqual(
    chunks.map((c) => [c.startLine, c.endLine]),
    [[1, 60], [51, 110], [101, 130]],
  );
  assert.equal(chunkByLines("", DEFAULT_CHUNK_OPTIONS).length, 0);
});

test("パーサが例外を投げても行ベースにフォールバックする", async () => {
  const broken = { parse: async () => { throw new Error("wasm load failed"); } };
  const chunks = await chunkFile("a.ts", "const a = 1;\n", broken, opts);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.kind, "lines");
});

test("拡張子判定", () => {
  assert.equal(languageForPath("a/b/c.TSX")?.ast, "tsx");
  assert.equal(languageForPath("Main.java")?.ast, "java");
  assert.equal(languageForPath("README"), undefined);
  assert.equal(languageForPath("image.png"), undefined);
});
