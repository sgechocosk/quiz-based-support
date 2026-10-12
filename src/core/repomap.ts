import type { HybridIndex } from "./search";

/**
 * Aider の repo map に倣った簡易版。
 * 各ファイルが定義するシンボルが他の場所でどれだけ言及されているか(文書頻度)でファイルを順位付けし、
 * トークン予算内に「パス — シンボル一覧」だけを並べる。LLMに全体像を与えて探索の初手を良くする。
 */
export function buildRepoMap(index: HybridIndex, budgetChars: number): string {
  const symbolsByFile = new Map<string, Set<string>>();
  for (const chunk of index.chunks) {
    if (chunk.symbols.length === 0) {
      continue;
    }
    let set = symbolsByFile.get(chunk.file);
    if (!set) {
      set = new Set();
      symbolsByFile.set(chunk.file, set);
    }
    for (const s of chunk.symbols) {
      set.add(s);
    }
  }

  const rows = [...symbolsByFile].map(([file, set]) => {
    const symbols = [...set];
    const scored = symbols
      .map((name) => ({ name, score: Math.min(Math.max(index.documentFrequency(name.toLowerCase()) - 1, 0), 20) }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const total = scored.reduce((sum, s) => sum + s.score, 0);
    return { file, names: scored.slice(0, 8).map((s) => s.name), total };
  });
  rows.sort((a, b) => b.total - a.total || a.file.localeCompare(b.file));

  const lines: string[] = [];
  let used = 0;
  for (const row of rows) {
    const line = `${row.file} — ${row.names.join(", ")}`;
    if (used + line.length + 1 > budgetChars) {
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}
