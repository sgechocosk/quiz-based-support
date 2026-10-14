/**
 * 宣言(関数・メソッド・クラス・型など)を行単位の正規表現で大まかに拾う(TS/JS/Java を想定)。
 * 「どの宣言のシグネチャが変わったか」「変更がどの宣言の中か」を、言語サーバに頼らず判定するのに使う。
 */

export type DeclKind = "function" | "method" | "class" | "interface" | "type" | "enum";

export interface Declaration {
  name: string;
  kind: DeclKind;
  /** 宣言の先頭行(0始まり) */
  line: number;
  /** シグネチャ部分(空白を除いた、本体の { より前)。変更の有無の比較に使う */
  header: string;
  /** シグネチャが終わる行(0始まり) */
  headerEnd: number;
}

const IDENT = "[A-Za-z_$][\\w$]*";
const CONTROL = new Set([
  "if", "for", "while", "switch", "catch", "return", "new", "typeof", "await", "else", "do", "try", "throw", "case",
  "super", "this", "import", "yield", "delete", "void", "in", "of", "throws",
]);

const RULES: Array<{ kind: DeclKind; re: RegExp }> = [
  { kind: "function", re: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${IDENT})`) },
  {
    kind: "class",
    re: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:(?:public|private|protected|static|final|abstract|sealed)\\s+)*class\\s+(${IDENT})`),
  },
  { kind: "interface", re: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:public\\s+)?interface\\s+(${IDENT})`) },
  { kind: "enum", re: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const\\s+)?(?:public\\s+)?enum\\s+(${IDENT})`) },
  { kind: "type", re: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?type\\s+(${IDENT})\\s*(?:<[^=]*>)?\\s*=`) },
  // const f = (...) => / const f = async function / const f = async (
  {
    kind: "function",
    re: new RegExp(
      `^\\s*(?:export\\s+)?(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*(?::[^=]+)?=>|${IDENT}\\s*=>|\\(\\s*$)`,
    ),
  },
  // メソッド(TS/Java): [修飾子] [型] name(...)
  {
    kind: "method",
    re: new RegExp(
      `^\\s*(?:(?:public|private|protected|static|async|override|readonly|abstract|get|set|final|synchronized|native)\\s+)*(?:[\\w<>\\[\\],.?]+\\s+)?(${IDENT})\\s*(?:<[^>()]*>)?\\s*\\(`,
    ),
  },
];

function stripCode(line: string): string {
  return line
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""')
    .replace(/\/\/.*$/, "")
    .replace(/\/\*.*?\*\//g, "");
}

/** その行が宣言の先頭なら、名前と種類 */
export function declarationAt(line: string): { name: string; kind: DeclKind } | undefined {
  const trimmed = line.trim();
  const first = trimmed.split(/[\s(<]/)[0] ?? "";
  if (CONTROL.has(first) || /^(?:[}*]|\/\/|export\s*[{*])/.test(trimmed)) {
    return undefined;
  }
  for (const rule of RULES) {
    const m = rule.re.exec(line);
    if (m && !CONTROL.has(m[1]!)) {
      return { name: m[1]!, kind: rule.kind };
    }
  }
  return undefined;
}

/**
 * i 行目から始まる宣言のシグネチャ(括弧の外にある本体の { / => / ; の手前まで、最大8行)。
 * - 型の別名(type X = ...)は = までをシグネチャ、その後ろを本体とみなす
 * - メソッドの形をしていても、括弧の外の ; , で終わるもの(関数呼び出し)は宣言でないので undefined
 * body は本体の開き括弧 { の位置(stripCode 後の列)。本体が { で始まらなければ undefined。
 */
function headerOf(
  lines: string[],
  i: number,
  kind: DeclKind,
): { header: string; end: number; body?: { line: number; col: number } } | undefined {
  /** at 列より後ろで最初の空白以外が { なら、その位置 */
  const braceAfter = (k: number, at: number): { line: number; col: number } | undefined => {
    for (let line = k; line < Math.min(lines.length, k + 2); line++) {
      const code = stripCode(lines[line]!);
      const rest = line === k ? code.slice(at) : code;
      const m = /\S/.exec(rest);
      if (m) {
        return m[0] === "{" ? { line, col: (line === k ? at : 0) + m.index } : undefined;
      }
    }
    return undefined;
  };
  if (kind === "type") {
    const code = stripCode(lines[i]!);
    const eq = code.indexOf("=");
    return { header: squash(code.slice(0, eq + 1)), end: i, body: braceAfter(i, eq + 1) };
  }
  let text = "";
  let depth = 0;
  for (let k = i; k < Math.min(lines.length, i + 8); k++) {
    const code = stripCode(lines[k]!);
    for (let c = 0; c < code.length; c++) {
      const ch = code[c]!;
      if (ch === "(" || ch === "[") {
        depth++;
      } else if (ch === ")" || ch === "]") {
        depth--;
        if (depth < 0) {
          return undefined; // 外側の呼び出しの引数の中だった
        }
      } else if (depth === 0) {
        if (ch === "{") {
          return { header: squash(text + code.slice(0, c)), end: k, body: { line: k, col: c } };
        }
        if (ch === "=" && code[c + 1] === ">") {
          return { header: squash(text + code.slice(0, c + 2)), end: k, body: braceAfter(k, c + 2) };
        }
        if (ch === ";") {
          // インターフェースのメソッド宣言(name(x): T;)は宣言、文としての呼び出しは宣言でない
          const sig = text + code.slice(0, c);
          return kind === "method" && /\)\s*:\s*\S/.test(sig) ? { header: squash(sig), end: k } : undefined;
        }
        if (ch === "," && (kind === "method" || kind === "function")) {
          return undefined; // 引数の並びの中の呼び出し
        }
      }
    }
    text += code;
  }
  return undefined;
}

function squash(s: string): string {
  return s.replace(/\s+/g, "").replace(/;$/, "");
}

/** ファイル全体の宣言 */
export function declarationsOf(lines: string[]): Declaration[] {
  const out: Declaration[] = [];
  for (let i = 0; i < lines.length; i++) {
    const d = declarationAt(lines[i]!);
    if (!d) {
      continue;
    }
    const h = headerOf(lines, i, d.kind);
    if (!h) {
      continue;
    }
    out.push({ name: d.name, kind: d.kind, line: i, header: h.header, headerEnd: h.end });
  }
  return out;
}

/**
 * 宣言の終わりの行(0始まり)。
 * 本体が { で始まるなら、その { から数えて閉じたところ。そうでなければ(型の別名・式のアロー関数・メソッド宣言)、; で終わる行。
 */
function blockEnd(lines: string[], header: { end: number; body?: { line: number; col: number } }): number {
  if (!header.body) {
    for (let k = header.end; k < Math.min(lines.length, header.end + 200); k++) {
      if (/;\s*$/.test(stripCode(lines[k]!))) {
        return k;
      }
    }
    return header.end;
  }
  let depth = 0;
  for (let k = header.body.line; k < lines.length && k - header.body.line <= 5000; k++) {
    const code = stripCode(lines[k]!);
    for (let c = k === header.body.line ? header.body.col : 0; c < code.length; c++) {
      if (code[c] === "{") {
        depth++;
      } else if (code[c] === "}") {
        depth--;
        if (depth === 0) {
          return k;
        }
      }
    }
  }
  return lines.length - 1;
}

/** start〜end 行(0始まり)をすべて含む、いちばん内側の宣言 */
export function enclosingDeclaration(lines: string[], start: number, end: number): (Declaration & { end: number }) | undefined {
  for (let i = Math.min(start, lines.length - 1); i >= 0 && start - i <= 600; i--) {
    const d = declarationAt(lines[i]!);
    if (!d) {
      continue;
    }
    const h = headerOf(lines, i, d.kind);
    if (!h) {
      continue;
    }
    const last = blockEnd(lines, h);
    if (last >= end) {
      return { name: d.name, kind: d.kind, line: i, header: h.header, headerEnd: h.end, end: last };
    }
  }
  return undefined;
}

/** 行がその宣言のシグネチャ部分(先頭〜本体の { の行)に入っているか */
export function inHeader(decl: Declaration, line: number): boolean {
  return line >= decl.line && line <= decl.headerEnd;
}
