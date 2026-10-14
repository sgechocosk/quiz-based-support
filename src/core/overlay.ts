import { lineMapper, type LineMapper } from "./diff";
import type { FileInfo, SyntaxChecker, WorkspacePort } from "./ports";
import { cleanCodeLines, isSameCode, locateRange } from "./quiz";
import { detectEol, splitLines } from "./text";
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

  /** 元に戻す(ステップの適用に失敗したときの巻き戻し用) */
  restore(path: string, text: string | undefined): void {
    if (text === undefined) {
      this.current.delete(path);
    } else {
      this.current.set(path, text);
    }
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

  /** このワークスペースに書き込んだ内容(書き込んでいなければ undefined)。巻き戻し用に控える */
  writtenText(path: string): string | undefined {
    return this.current.get(path);
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

/** LLM が出す編集(既存ファイルの行範囲の置き換え、または新規ファイル) */
export interface RawEdit {
  path: string;
  create: boolean;
  startLine: number;
  endLine: number;
  firstLine: string;
  lastLine: string;
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

/** 1つの編集で変えてよい行数の目安 */
const MAX_EDIT_GROWTH = 80;

/**
 * 編集を仮想ワークスペースに適用する。範囲は firstLine/lastLine の逐語一致で探し直す(行番号のずれを吸収)。
 * 適用前は構文として正しかったファイルが、適用後に構文エラーになる編集は拒否する。
 */
export async function applyRawEdit(vws: VirtualWorkspace, raw: RawEdit, syntax?: SyntaxChecker): Promise<EditResult> {
  const path = normalizeRelPath(raw?.path ?? "");
  if (!path) {
    return { ok: false, reason: `${raw?.path} はワークスペース相対パスではありません` };
  }
  const label = raw.create ? `${path}(新規)` : `${path}:${raw.startLine}-${raw.endLine}`;
  const newLines = cleanCodeLines(raw.newCode ?? "");
  let exists = true;
  let fileText = "";
  try {
    fileText = await vws.readText(path);
  } catch {
    exists = false;
  }

  if (raw.create) {
    if (exists) {
      return { ok: false, reason: `${label} は既にあります。新規作成ではなく、範囲を指定して書き換えてください` };
    }
    if (newLines.join("").trim() === "") {
      return { ok: false, reason: `${label} newCode が空です` };
    }
    const text = newLines.join("\n");
    if ((await syntax?.isValid(path, text)) === false) {
      return { ok: false, reason: `${label} 構文エラーになります` };
    }
    await vws.write(path, text);
    return { ok: true, edit: { path, created: true, startLine: 1, endLine: 1, before: "", after: text, fileBefore: "" } };
  }

  if (!exists || !(await vws.stat(path))) {
    return { ok: false, reason: `${label} を読めません(存在しないか、対象外のファイルです)。新しく作るなら create を true にしてください` };
  }
  const lines = splitLines(fileText);
  const range = locateRange(lines, Number(raw.startLine) || 1, Number(raw.endLine) || 1, raw.firstLine ?? "", raw.lastLine ?? "");
  if (!range) {
    const actual = lines[(Number(raw.startLine) || 1) - 1];
    return {
      ok: false,
      reason: `${label} 範囲を特定できません(firstLine「${raw.firstLine}」が見つからない${actual !== undefined ? `。${raw.startLine}行目の実際の内容: ${actual.trim()}` : ""})`,
    };
  }
  const beforeLines = lines.slice(range.start - 1, range.end);
  if (isSameCode(newLines.join("\n"), beforeLines.join("\n"), { loose: true })) {
    return { ok: false, reason: `${label} newCode が元のコードと同じです(変更になっていません)` };
  }
  if (newLines.length > beforeLines.length * 3 + MAX_EDIT_GROWTH) {
    return { ok: false, reason: `${label} 1つの編集が長すぎます。ステップを分けてください` };
  }
  const next = lines.slice();
  next.splice(range.start - 1, beforeLines.length, ...newLines);
  const nextText = next.join(detectEol(fileText));
  if (syntax) {
    const before = await syntax.isValid(path, fileText);
    if (before === true && (await syntax.isValid(path, nextText)) === false) {
      return { ok: false, reason: `${label} この編集を入れると構文エラーになります(括弧の対応・カンマなどを確認してください)` };
    }
  }
  await vws.write(path, nextText);
  return {
    ok: true,
    edit: {
      path,
      created: false,
      startLine: range.start,
      endLine: range.end,
      before: beforeLines.join("\n"),
      after: newLines.join("\n"),
      fileBefore: fileText,
    },
  };
}
