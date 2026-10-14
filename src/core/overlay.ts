import { lineMapper, type LineMapper } from "./diff";
import { describeBlockMiss, locateBlock, trimMirroredBlanks } from "./editMatch";
import type { FileInfo, SyntaxChecker, WorkspacePort } from "./ports";
import { cleanCodeLines, isSameCode, locateRange } from "./quiz";
import { detectEol, numberLines, splitLines, toPosix, truncate } from "./text";
import { normalizeRelPath } from "./tools";

/**
 * 実ファイルに書き込まずに変更を重ねる仮想ワークスペース。
 * 変更計画はここに積み、型検査・影響の調査もこの上で行う。実ファイルへの反映は最後に一括で行う。
 */
export class VirtualWorkspace implements WorkspacePort {
  readonly id: string;
  private readonly current = new Map<string, string>();
  /** 最初に読んだときの内容(null は「存在しなかった」= 新規作成) */
  private readonly originals = new Map<string, string | null>();
  private readonly mappers = new Map<string, { text: string; mapper: LineMapper }>();
  /**
   * 変更前の内容の読み取り結果(計画を作る間は変わらない前提で使い回す)。
   * 文字列キーの検索などでワークスペース全体を何度も読むため。
   */
  private readonly baseTexts = new Map<string, Promise<string>>();
  private baseList?: Promise<FileInfo[]>;

  constructor(private readonly base: WorkspacePort) {
    this.id = base.id;
  }

  private readBase(path: string): Promise<string> {
    let text = this.baseTexts.get(path);
    if (!text) {
      text = this.base.readText(path);
      this.baseTexts.set(path, text);
      text.catch(() => this.baseTexts.delete(path));
    }
    return text;
  }

  async listFiles(): Promise<FileInfo[]> {
    this.baseList ??= this.base.listFiles();
    const files = [...(await this.baseList)];
    const known = new Set(files.map((f) => f.path));
    for (const [path, text] of this.current) {
      if (!known.has(path)) {
        files.push({ path, size: text.length, mtime: 0 });
      }
    }
    return files;
  }

  async stat(path: string): Promise<FileInfo | undefined> {
    if (this.originals.get(path) === null && this.current.has(path)) {
      return { path, size: this.current.get(path)!.length, mtime: 0 };
    }
    return this.base.stat(path);
  }

  async readText(path: string): Promise<string> {
    const text = this.current.get(path);
    if (text !== undefined) {
      return text;
    }
    return this.readBase(path);
  }

  /** 変更前の内容(存在しなかったファイルは null) */
  async original(path: string): Promise<string | null> {
    if (!this.originals.has(path)) {
      try {
        this.originals.set(path, await this.readBase(path));
      } catch {
        this.originals.set(path, null);
      }
    }
    return this.originals.get(path)!;
  }

  async write(path: string, text: string): Promise<void> {
    await this.original(path);
    this.current.set(path, text);
    this.mappers.delete(path);
  }

  /** 書き込み済み(未変更に戻ったものを除く)のファイル */
  changedPaths(): string[] {
    return [...this.current.keys()].filter((p) => this.current.get(p) !== this.originals.get(p)).sort();
  }

  isCreated(path: string): boolean {
    return this.originals.get(path) === null && this.current.has(path);
  }

  /** 変更後の内容(変更したファイルだけ) */
  overlay(): Map<string, string> {
    return new Map(this.changedPaths().map((p) => [p, this.current.get(p)!]));
  }

  /** 変更前の行番号 ↔ 現在の行番号 */
  async mapper(path: string): Promise<LineMapper> {
    const now = await this.readText(path).catch(() => "");
    const cached = this.mappers.get(path);
    if (cached && cached.text === now) {
      return cached.mapper;
    }
    const original = (await this.original(path)) ?? "";
    const mapper = lineMapper(original, now);
    this.mappers.set(path, { text: now, mapper });
    return mapper;
  }
}

/**
 * LLM が出す編集(既存ファイルの一部の置き換え、または新規ファイル)。
 * 既存ファイルは oldCode(置き換え前のコードの逐語の写し)を内容で探して置き換える。startLine は複数見つかったときの手がかり。
 * firstLine / lastLine + 行範囲の形式(以前の形式)も受け付ける。
 */
export interface RawEdit {
  path: string;
  create: boolean;
  startLine?: number;
  endLine?: number;
  oldCode?: string;
  firstLine?: string;
  lastLine?: string;
  newCode: string;
}

/** 適用済みの編集 */
export interface PlanEdit {
  path: string;
  created: boolean;
  /** 適用前のファイルでの範囲(1始まり・両端含む) */
  startLine: number;
  endLine: number;
  /** 置き換え前の行(\n 区切り) */
  before: string;
  /** 置き換え後の行(\n 区切り) */
  after: string;
  /** 適用前のファイル全体(出題の検証に使う) */
  fileBefore: string;
}

export type EditResult = { ok: true; edit: PlanEdit } | { ok: false; reason: string };

/**
 * ステップの編集をまとめて適用した結果。
 * line: 作り直しのときに今のコードを見せる中心(最も近い箇所・構文エラーの行など)。
 * alreadyApplied: 編集がすべて、既に反映済みだった(作り直しで同じ編集がもう一度返ってきたなど)。
 */
export type EditsResult =
  | { ok: true; edits: PlanEdit[]; skipped: number }
  | { ok: false; reason: string; path?: string; line?: number; alreadyApplied?: boolean };

type OneResult =
  | { ok: true; edit: PlanEdit; text: string }
  | { ok: false; reason: string; line?: number; alreadyApplied?: boolean };

/** 1つの編集で変えてよい行数の目安 */
const MAX_EDIT_GROWTH = 80;

/**
 * LLM が書いたパスをワークスペース相対にする。
 * 絶対パス(ワークスペースの中)・先頭の "/"・バックスラッシュも受け付ける。ワークスペースの外は undefined。
 */
export function toWorkspacePath(input: string, root: string): string | undefined {
  const p = toPosix(String(input ?? "")).trim();
  const r = toPosix(root ?? "").replace(/\/+$/, "");
  if (r && p.toLowerCase().startsWith(`${r.toLowerCase()}/`)) {
    return normalizeRelPath(p.slice(r.length + 1));
  }
  if (/^[A-Za-z]:/.test(p)) {
    return undefined;
  }
  return normalizeRelPath(p.replace(/^\/+/, ""));
}

/** 範囲を探す手がかりにできる行か(空白を除いて10文字以上あり、ファイル内で1か所だけ) */
function isUniqueAnchor(lines: string[], anchor: string): boolean {
  const a = anchor.replace(/\s+/g, "");
  return a.length >= 10 && lines.filter((l) => l.replace(/\s+/g, "") === a).length === 1;
}

/** 空白の違いを無視した比較用 */
function looseLine(s: string | undefined): string {
  return (s ?? "").replace(/\s+/g, "");
}

function shown(line: string): string {
  return truncate(line.trim(), 120);
}

/** ステップの中で書き換え中のファイル(null は存在しない) */
type Draft = Map<string, string | null>;

async function baseText(vws: VirtualWorkspace, path: string): Promise<string | null> {
  try {
    return await vws.readText(path);
  } catch {
    return null;
  }
}

/** 1つの編集を、ステップの書きかけ(draft)の上で計算する(仮想ワークスペースにはまだ書かない) */
async function applyOne(vws: VirtualWorkspace, draft: Draft, raw: RawEdit): Promise<OneResult> {
  const path = toWorkspacePath(raw?.path ?? "", vws.id);
  if (!path) {
    return { ok: false, reason: `${raw?.path} はワークスペース相対パスではありません` };
  }
  const hint = Number(raw.startLine) || undefined;
  const label = raw.create ? `${path}(新規)` : `${path}${hint ? `:${hint}` : ""}`;
  const newLines = cleanCodeLines(raw.newCode ?? "");
  const fileText = draft.has(path) ? draft.get(path)! : await baseText(vws, path);

  if (raw.create) {
    if (fileText !== null) {
      if (isSameCode(newLines.join("\n"), fileText, { loose: true })) {
        return { ok: false, alreadyApplied: true, reason: `${label} 同じ内容で作成済みです` };
      }
      return { ok: false, reason: `${label} は既にあります。新規作成ではなく、oldCode を指定して書き換えてください` };
    }
    if (newLines.join("").trim() === "") {
      return { ok: false, reason: `${label} newCode が空です` };
    }
    const text = newLines.join("\n");
    return { ok: true, text, edit: { path, created: true, startLine: 1, endLine: 1, before: "", after: text, fileBefore: "" } };
  }

  if (fileText === null || (!draft.has(path) && !(await vws.stat(path)))) {
    return { ok: false, reason: `${label} を読めません(存在しないか、対象外のファイルです)。新しく作るなら create を true にしてください` };
  }
  const lines = splitLines(fileText);
  let range: { start: number; end: number } | undefined;
  let replacement = newLines;

  if (typeof raw.oldCode === "string" && raw.oldCode.trim() !== "") {
    const oldLines = cleanCodeLines(raw.oldCode);
    const m = locateBlock(lines, oldLines, hint);
    if (!m.ok) {
      // 作り直しで、既に入れた編集がもう一度返ってきた(oldCode は無く、newCode がある)
      if (m.kind === "not-found" && looseLine(newLines.join("")).length >= 10 && locateBlock(lines, newLines, hint).ok) {
        return { ok: false, alreadyApplied: true, reason: `${label} この編集は既に反映されています` };
      }
      return { ok: false, ...describeBlockMiss(label, m, lines) };
    }
    range = m;
    replacement = m.reindent(trimMirroredBlanks(oldLines, newLines));
  } else {
    // 以前の形式: 行範囲 + firstLine / lastLine
    let start = Number(raw.startLine) || 1;
    let end = Number(raw.endLine) || start;
    if (end < start) {
      [start, end] = [end, start];
    }
    let lastAnchor = raw.lastLine ?? "";
    range = locateRange(lines, start, end, raw.firstLine ?? "", lastAnchor);
    if (!range && newLines.length > 0) {
      // firstLine に変更後の行を写してしまうことがある。変更後のコードの先頭・末尾(変えていない境界の行)が
      // ファイル内で一意に見つかるなら、それを手がかりに範囲を決める
      const first = newLines[0]!;
      const last = newLines[newLines.length - 1]!;
      if (isUniqueAnchor(lines, first)) {
        lastAnchor = isUniqueAnchor(lines, last) ? last : lastAnchor;
        range = locateRange(lines, start, end, first, lastAnchor);
      }
    }
    if (!range) {
      const actual = lines[start - 1];
      return {
        ok: false,
        reason: `${label} 範囲を特定できません(firstLine「${raw.firstLine}」が見つからない${actual !== undefined ? `。${start}行目の実際の内容: ${actual.trim()}` : ""})`,
        line: start,
      };
    }
    // 終わりの行が見つからないまま推測した範囲で置き換えると、閉じ括弧などを消したり残したりしてしまう
    const last = cleanCodeLines(lastAnchor)[0] ?? "";
    if (looseLine(last) !== "" && looseLine(lines[range.end - 1]) !== looseLine(last)) {
      return {
        ok: false,
        reason: `${label} 範囲の終わりを特定できません(lastLine「${shown(last)}」が${range.start}行目より後の近くに見つからない。${range.end}行目の実際の内容: ${shown(lines[range.end - 1] ?? "")})`,
        line: range.start,
      };
    }
  }

  const beforeLines = lines.slice(range.start - 1, range.end);
  if (isSameCode(replacement.join("\n"), beforeLines.join("\n"), { loose: true })) {
    return { ok: false, reason: `${label} newCode が元のコードと同じです(変更になっていません)`, line: range.start };
  }
  if (replacement.length > beforeLines.length * 3 + MAX_EDIT_GROWTH) {
    return { ok: false, reason: `${label} 1つの編集が長すぎます。ステップを分けてください`, line: range.start };
  }
  const next = lines.slice();
  next.splice(range.start - 1, beforeLines.length, ...replacement);
  return {
    ok: true,
    text: next.join(detectEol(fileText)),
    edit: {
      path,
      created: false,
      startLine: range.start,
      endLine: range.end,
      before: beforeLines.join("\n"),
      after: replacement.join("\n"),
      fileBefore: fileText,
    },
  };
}

/**
 * ステップの編集をまとめて仮想ワークスペースに適用する(すべて成功したときだけ書き込む)。
 * - 既存ファイルは oldCode を内容で探す(行番号のずれ・空白やインデントの違いを吸収)
 * - 既に反映済みの編集は飛ばす
 * - 構文は、ステップの編集をすべて入れた後で確かめる(1つのステップで「開く」「閉じる」を別の編集に分けてもよい)。
 *   適用前は構文として正しかったファイルが、適用後に構文エラーになるステップは拒否する。
 */
export async function applyEdits(vws: VirtualWorkspace, raws: RawEdit[], syntax?: SyntaxChecker): Promise<EditsResult> {
  const draft: Draft = new Map();
  const edits: PlanEdit[] = [];
  let skipped = 0;
  for (const raw of raws.filter((e) => e && typeof e === "object")) {
    const r = await applyOne(vws, draft, raw);
    if (!r.ok) {
      if (r.alreadyApplied) {
        skipped++;
        continue;
      }
      return { ok: false, reason: r.reason, path: toWorkspacePath(raw.path ?? "", vws.id), line: r.line ?? (Number(raw.startLine) || 1) };
    }
    draft.set(r.edit.path, r.text);
    edits.push(r.edit);
  }
  if (edits.length === 0) {
    return skipped > 0 ? { ok: false, alreadyApplied: true, reason: "編集はすべて既に反映されています" } : { ok: false, reason: "編集がありません" };
  }
  if (syntax) {
    for (const [path, text] of draft) {
      const before = await baseText(vws, path);
      const wasValid = before === null || (await syntax.isValid(path, before)) === true;
      if (!wasValid || text === null || (await syntax.isValid(path, text)) !== false) {
        continue;
      }
      const line = await syntax.errorLine?.(path, text);
      const at = line ? `(${line}行目付近: 「${shown(splitLines(text)[line - 1] ?? "")}」)` : "";
      return {
        ok: false,
        reason: `${path}${before === null ? "(新規)" : ""} このステップの編集をすべて入れると構文エラーになります${at}。括弧の対応・カンマと、oldCode / newCode に閉じ括弧などの境界の行を入れ忘れていないかを確認してください`,
        path,
        line: line ?? edits.find((e) => e.path === path)?.startLine,
      };
    }
  }
  for (const [path, text] of draft) {
    if (text !== null) {
      await vws.write(path, text);
    }
  }
  return { ok: true, edits, skipped };
}

/** 編集を1つ適用する(applyEdits の1件版) */
export async function applyRawEdit(vws: VirtualWorkspace, raw: RawEdit, syntax?: SyntaxChecker): Promise<EditResult> {
  const r = await applyEdits(vws, [raw], syntax);
  return r.ok ? { ok: true, edit: r.edits[0]! } : { ok: false, reason: r.reason };
}
