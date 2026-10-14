import { buildLineStarts, offsetToLine, splitLines, toPosix } from "./text";

/** tree-sitter の Node と構造的に互換な最小インターフェース */
export interface AstNode {
  type: string;
  startIndex: number;
  endIndex: number;
  children: ReadonlyArray<AstNode | null>;
  childForFieldName(name: string): AstNode | null;
}

export interface ParsedTree {
  root: AstNode;
  hasError: boolean;
  dispose(): void;
}

export type AstLanguage = "javascript" | "typescript" | "tsx" | "java";

export interface ParserProvider {
  parse(language: AstLanguage, text: string): Promise<ParsedTree | undefined>;
}

export interface ChunkDraft {
  startLine: number;
  endLine: number;
  text: string;
  scope: string;
  symbols: string[];
  kind: string;
}

export interface ChunkOptions {
  /** 空白を除いた文字数の上限(cAST論文と同様、行数ではなく中身の量で測る) */
  maxChars: number;
  lineChunk: number;
  lineOverlap: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  maxChars: 1500,
  lineChunk: 60,
  lineOverlap: 10,
};

export interface LanguageInfo {
  language: string;
  ast?: AstLanguage;
  /** false: 検索(grep)の対象にはするが、索引(チャンク・埋め込み)には入れない */
  index?: boolean;
}

const EXTENSIONS: Record<string, LanguageInfo> = {
  ".ts": { language: "typescript", ast: "typescript" },
  ".mts": { language: "typescript", ast: "typescript" },
  ".cts": { language: "typescript", ast: "typescript" },
  ".tsx": { language: "tsx", ast: "tsx" },
  ".js": { language: "javascript", ast: "javascript" },
  ".jsx": { language: "javascript", ast: "javascript" },
  ".mjs": { language: "javascript", ast: "javascript" },
  ".cjs": { language: "javascript", ast: "javascript" },
  ".java": { language: "java", ast: "java" },
  ".py": { language: "python" },
  ".go": { language: "go" },
  ".rs": { language: "rust" },
  ".c": { language: "c" },
  ".h": { language: "c" },
  ".cpp": { language: "cpp" },
  ".hpp": { language: "cpp" },
  ".cs": { language: "csharp" },
  ".kt": { language: "kotlin" },
  ".swift": { language: "swift" },
  ".rb": { language: "ruby" },
  ".php": { language: "php" },
  ".vue": { language: "vue" },
  ".html": { language: "html" },
  ".htm": { language: "html" },
  ".css": { language: "css" },
  ".scss": { language: "scss" },
  ".less": { language: "less" },
  ".sql": { language: "sql" },
  ".sh": { language: "shell" },
  ".md": { language: "markdown" },
  // 設定ファイル(package.json の設定キー登録など、文字列でつながる結合を見つけるため)。索引には入れない
  ".json": { language: "json", index: false },
};

export function languageForPath(filePath: string): LanguageInfo | undefined {
  const posix = toPosix(filePath);
  const dot = posix.lastIndexOf(".");
  if (dot < 0 || dot < posix.lastIndexOf("/")) {
    return undefined;
  }
  return EXTENSIONS[posix.slice(dot).toLowerCase()];
}

/** 索引(チャンク・埋め込み)の対象か */
export function isIndexable(filePath: string): boolean {
  const info = languageForPath(filePath);
  return !!info && info.index !== false;
}

export function supportedExtensions(): string[] {
  return Object.keys(EXTENSIONS).map((e) => e.slice(1));
}

export function embeddingTextOf(
  file: string,
  chunk: Pick<ChunkDraft, "scope" | "symbols" | "text">,
): string {
  const header = [`file: ${file}`];
  if (chunk.scope) {
    header.push(`scope: ${chunk.scope}`);
  }
  if (chunk.symbols.length > 0) {
    header.push(`symbols: ${chunk.symbols.join(", ")}`);
  }
  return `${header.join("\n")}\n${chunk.text}`;
}

export async function chunkFile(
  filePath: string,
  text: string,
  parser: ParserProvider | undefined,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): Promise<ChunkDraft[]> {
  const info = languageForPath(filePath);
  if (!info) {
    return [];
  }
  if (info.ast && parser) {
    try {
      const tree = await parser.parse(info.ast, text);
      if (tree) {
        try {
          const chunks = chunkByAst(tree.root, text, options);
          if (chunks.length > 0) {
            return chunks;
          }
        } finally {
          tree.dispose();
        }
      }
    } catch {
      // パーサ不調時は行ベースへフォールバック(インデックス作成自体は止めない)
    }
  }
  return chunkByLines(text, options);
}

export function chunkByLines(text: string, options: ChunkOptions): ChunkDraft[] {
  const lines = splitLines(text);
  const chunks: ChunkDraft[] = [];
  const step = Math.max(1, options.lineChunk - options.lineOverlap);
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + options.lineChunk, lines.length);
    const body = lines.slice(start, end).join("\n");
    if (body.trim()) {
      chunks.push({
        startLine: start + 1,
        endLine: end,
        text: body,
        scope: "",
        symbols: [],
        kind: "lines",
      });
    }
    if (end >= lines.length) {
      break;
    }
  }
  return chunks;
}

interface Atom {
  start: number;
  end: number;
  scope: string;
}

interface Decl {
  name: string;
  kind: string;
  start: number;
}

function realChildren(node: AstNode): AstNode[] {
  return node.children.filter((c): c is AstNode => c !== null && c !== undefined);
}

function kindOf(type: string): string {
  if (/class/.test(type)) {
    return "class";
  }
  if (/interface/.test(type)) {
    return "interface";
  }
  if (/enum/.test(type)) {
    return "enum";
  }
  if (/type_alias/.test(type)) {
    return "type";
  }
  if (/method|constructor/.test(type)) {
    return "method";
  }
  if (/function/.test(type)) {
    return "function";
  }
  if (/lexical|variable/.test(type)) {
    return "variable";
  }
  return "code";
}

function declOf(node: AstNode, text: string): { name: string; kind: string } | undefined {
  const type = node.type;
  if (type === "export_statement") {
    const inner = node.childForFieldName("declaration");
    return inner ? declOf(inner, text) : undefined;
  }
  if (type === "lexical_declaration" || type === "variable_declaration") {
    for (const child of realChildren(node)) {
      if (child.type === "variable_declarator") {
        const nameNode = child.childForFieldName("name");
        if (nameNode && nameNode.endIndex - nameNode.startIndex <= 80) {
          return { name: text.slice(nameNode.startIndex, nameNode.endIndex), kind: "variable" };
        }
      }
    }
    return undefined;
  }
  if (/_(declaration|definition|signature)$/.test(type)) {
    const nameNode = node.childForFieldName("name");
    if (nameNode && nameNode.endIndex - nameNode.startIndex <= 80) {
      return { name: text.slice(nameNode.startIndex, nameNode.endIndex), kind: kindOf(type) };
    }
  }
  return undefined;
}

function isScopeType(type: string): boolean {
  return /class|interface|enum|namespace|module|function|method|constructor/.test(type);
}

/**
 * cAST 方式の split-then-merge。
 * 1. 木を上から辿り、サイズ予算に収まる最大の部分木を「原子」として集める(収まらなければ子へ再帰)
 * 2. 文書順に隣接する原子を予算内で貪欲に連結する
 * こうして構文境界を保ったまま、巨大クラスも欠落なくメソッド単位に近い塊へ分割できる。
 */
export function chunkByAst(root: AstNode, text: string, options: ChunkOptions): ChunkDraft[] {
  const max = options.maxChars;
  const prefix = new Uint32Array(text.length + 1);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 13;
    prefix[i + 1] = prefix[i]! + (ws ? 0 : 1);
  }
  const size = (start: number, end: number): number => prefix[end]! - prefix[start]!;

  const atoms: Atom[] = [];
  const decls: Decl[] = [];

  const splitLeaf = (start: number, end: number, scope: string): void => {
    let pieceStart = start;
    let acc = 0;
    let pos = start;
    while (pos < end) {
      let lineEnd = text.indexOf("\n", pos);
      lineEnd = lineEnd < 0 || lineEnd >= end ? end : lineEnd + 1;
      const lineSize = size(pos, lineEnd);
      if (acc > 0 && acc + lineSize > max) {
        atoms.push({ start: pieceStart, end: pos, scope });
        pieceStart = pos;
        acc = 0;
      }
      acc += lineSize;
      pos = lineEnd;
    }
    if (pos > pieceStart) {
      atoms.push({ start: pieceStart, end: pos, scope });
    }
  };

  // 予算内に収まった塊の中にある宣言名も(浅く)拾う。小さなファイルでもシンボル検索/repo map が効くように。
  let budgetNodes = 20000;
  const collectNested = (node: AstNode, depth: number): void => {
    if (depth > 8) {
      return;
    }
    for (const kid of realChildren(node)) {
      if (--budgetNodes < 0) {
        return;
      }
      const d = declOf(kid, text);
      if (d) {
        decls.push({ name: d.name, kind: d.kind, start: kid.startIndex });
      }
      collectNested(kid, depth + 1);
    }
  };

  const visit = (node: AstNode, scope: string[]): void => {
    const decl = declOf(node, text);
    if (decl) {
      decls.push({ name: decl.name, kind: decl.kind, start: node.startIndex });
    }
    const nodeScope = scope.join(".");
    if (size(node.startIndex, node.endIndex) <= max) {
      atoms.push({ start: node.startIndex, end: node.endIndex, scope: nodeScope });
      collectNested(node, 0);
      return;
    }
    const kids = realChildren(node);
    if (kids.length === 0) {
      splitLeaf(node.startIndex, node.endIndex, nodeScope);
      return;
    }
    const childScope = decl && isScopeType(node.type) ? [...scope, decl.name] : scope;
    for (const kid of kids) {
      visit(kid, childScope);
    }
  };

  visit(root, []);
  atoms.sort((a, b) => a.start - b.start);

  const lineStarts = buildLineStarts(text);
  const chunks: ChunkDraft[] = [];
  let group: Atom[] = [];
  let groupSize = 0;

  const flush = (): void => {
    if (group.length === 0) {
      return;
    }
    const rawStart = group[0]!.start;
    const rawEnd = group[group.length - 1]!.end;
    let start = rawStart;
    let end = rawEnd;
    // 先頭・末尾の空白行を落とし、開始位置を行頭(インデント込み)にそろえる
    const lead = text.slice(start, end).search(/\S/);
    if (lead < 0) {
      group = [];
      groupSize = 0;
      return;
    }
    const firstLineStart = lineStarts[offsetToLine(lineStarts, start + lead) - 1]!;
    start = Math.max(start, firstLineStart);
    end = start + text.slice(start, end).trimEnd().length;
    const body = text.slice(start, end);
    if (body.trim()) {
      const inside = decls.filter((d) => d.start >= rawStart && d.start < rawEnd);
      const names: string[] = [];
      for (const d of inside) {
        if (!names.includes(d.name)) {
          names.push(d.name);
        }
      }
      const deepest = group.reduce((best, a) => (a.scope.length > best.length ? a.scope : best), "");
      chunks.push({
        startLine: offsetToLine(lineStarts, start),
        endLine: offsetToLine(lineStarts, Math.max(start, end - 1)),
        text: body,
        scope: deepest,
        symbols: names.slice(0, 8),
        kind: inside[0]?.kind ?? "code",
      });
    }
    group = [];
    groupSize = 0;
  };

  for (const atom of atoms) {
    const atomSize = size(atom.start, atom.end);
    if (group.length > 0 && groupSize + atomSize > max) {
      flush();
    }
    group.push(atom);
    groupSize += atomSize;
  }
  flush();
  return chunks;
}
