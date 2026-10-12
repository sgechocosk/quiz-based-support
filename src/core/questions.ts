import type { LspPort, SymbolInfo, WorkspacePort } from "./ports";
import { shuffle, splitLines } from "./text";
import type { McqQuestion } from "./types";

/**
 * 言語サーバ(LSP)の事実だけを正解にする構造クイズ。LLMの記憶に頼らないので幻覚が入らない。
 */

const FUNCTION_KIND = /function|method|constructor/i;
const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "new", "typeof", "await", "super", "this",
  "import", "require", "console", "else", "do", "try", "throw", "case", "in", "of", "void",
]);

export function buildCallersQuestion(
  symbol: string,
  callers: string[],
  pool: string[],
  rng: () => number,
  where: { path: string; line: number },
): McqQuestion | undefined {
  const uniqueCallers = [...new Set(callers)].filter((c) => c !== symbol);
  if (uniqueCallers.length === 0) {
    return undefined;
  }
  const exclude = new Set([...uniqueCallers, symbol]);
  const distractors = shuffle([...new Set(pool)].filter((p) => !exclude.has(p)), rng);
  const correct = shuffle(uniqueCallers, rng).slice(0, 2);
  const need = 4 - correct.length;
  if (distractors.length < Math.min(need, 2)) {
    return undefined;
  }
  const options = shuffle([...correct, ...distractors.slice(0, need)], rng);
  return {
    id: `callers:${where.path}:${symbol}`,
    prompt: `「${symbol}」を呼び出している(参照している)関数・メソッドを、すべて選んでください(正解は${correct.length}個)。`,
    options,
    correct: correct.map((c) => options.indexOf(c)).sort((a, b) => a - b),
    explanation: `言語サーバが返した参照元: ${uniqueCallers.join("、")}。`,
    concept: "呼び出し関係",
    path: where.path,
    line: where.line,
  };
}

export function buildDefinedInQuestion(
  callee: string,
  definedPath: string,
  poolPaths: string[],
  rng: () => number,
  where: { path: string; line: number },
): McqQuestion | undefined {
  const ext = definedPath.slice(definedPath.lastIndexOf("."));
  const same = poolPaths.filter((p) => p !== definedPath && p.endsWith(ext));
  const others = poolPaths.filter((p) => p !== definedPath && !p.endsWith(ext));
  const distractors = shuffle(same, rng).concat(shuffle(others, rng)).slice(0, 3);
  if (distractors.length < 2) {
    return undefined;
  }
  const options = shuffle([definedPath, ...distractors], rng);
  return {
    id: `defined:${where.path}:${callee}`,
    prompt: `${where.path} の中で呼ばれている「${callee}」は、どのファイルで定義されていますか?`,
    options,
    correct: [options.indexOf(definedPath)],
    explanation: `言語サーバによると「${callee}」の定義は ${definedPath} にあります。`,
    concept: "モジュール構成",
    path: where.path,
    line: where.line,
  };
}

function innermost(symbols: SymbolInfo[], startLine: number, endLine: number): SymbolInfo | undefined {
  let best: SymbolInfo | undefined;
  for (const s of symbols) {
    if (!FUNCTION_KIND.test(s.kind)) {
      continue;
    }
    const overlaps = s.startLine <= endLine && s.endLine >= startLine;
    if (overlaps && (!best || s.endLine - s.startLine < best.endLine - best.startLine)) {
      best = s;
    }
  }
  return best;
}

async function withTimeout<T>(task: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function buildStructureQuestions(
  deps: { ws: WorkspacePort; lsp: LspPort },
  range: { path: string; startLine: number; endLine: number },
  rng: () => number,
  timeoutMs = 6000,
): Promise<McqQuestion[]> {
  const work = async (): Promise<McqQuestion[]> => {
    const { ws, lsp } = deps;
    const questions: McqQuestion[] = [];
    const symbols = await lsp.documentSymbols(range.path);
    const target = innermost(symbols, range.startLine, range.endLine);

    if (target) {
      const refs = await lsp.references(range.path, target.nameLine, target.nameChar);
      const cache = new Map<string, SymbolInfo[]>([[range.path, symbols]]);
      const callers: string[] = [];
      for (const ref of refs.slice(0, 30)) {
        if (ref.path === range.path && ref.line === target.nameLine) {
          continue;
        }
        if (!cache.has(ref.path)) {
          cache.set(ref.path, await lsp.documentSymbols(ref.path).catch(() => []));
        }
        const enclosing = innermost(cache.get(ref.path) ?? [], ref.line, ref.line);
        if (enclosing && enclosing.name !== target.name) {
          callers.push(enclosing.name);
        }
      }
      let pool = (await lsp.workspaceSymbols("").catch(() => []))
        .filter((s) => FUNCTION_KIND.test(s.kind))
        .map((s) => s.name);
      if (pool.length < 3) {
        const ext = range.path.slice(range.path.lastIndexOf("."));
        const others = (await ws.listFiles()).filter((f) => f.path !== range.path && f.path.endsWith(ext)).slice(0, 6);
        for (const f of others) {
          const syms = await lsp.documentSymbols(f.path).catch(() => []);
          pool.push(...syms.filter((s) => FUNCTION_KIND.test(s.kind)).map((s) => s.name));
        }
        pool = [...new Set(pool)];
      }
      const q = buildCallersQuestion(target.name, callers, pool, rng, { path: range.path, line: target.nameLine });
      if (q) {
        questions.push(q);
      }
    }

    const text = await ws.readText(range.path);
    const lines = splitLines(text);
    const callRe = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
    let tried = 0;
    outer: for (let i = range.startLine - 1; i < Math.min(range.endLine, lines.length); i++) {
      callRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(lines[i]!)) !== null) {
        const name = m[1]!;
        if (KEYWORDS.has(name) || name === target?.name || /^(function|class)\b/.test(lines[i]!.trim())) {
          continue;
        }
        if (++tried > 6) {
          break outer;
        }
        const defs = await lsp.definition(range.path, i + 1, m.index).catch(() => []);
        const def = defs[0];
        if (def && def.path !== range.path && !def.path.includes("node_modules") && !def.path.endsWith(".d.ts")) {
          const pool = (await ws.listFiles()).map((f) => f.path);
          const q = buildDefinedInQuestion(name, def.path, pool, rng, { path: range.path, line: i + 1 });
          if (q) {
            questions.push(q);
          }
          break outer;
        }
      }
    }
    return questions;
  };
  try {
    return await withTimeout(work(), timeoutMs, []);
  } catch {
    return [];
  }
}
