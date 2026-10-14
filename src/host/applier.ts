import { exec } from "node:child_process";
import * as vscode from "vscode";
import { textEdits } from "../core/diff";
import type { PlannedFile } from "../core/planTypes";
import type { VscodeWorkspace } from "./workspaceVscode";

/**
 * 変更計画の反映と取り消し。すべてのファイルを1つの WorkspaceEdit にまとめて適用する。
 * 反映前に、計画を作ったときの内容から変わっていないかを確かめる(変わっていたら反映しない)。
 */

/** 期待した内容と違うファイル(expect: "original" = 反映前 / "final" = 反映後) */
export async function changedSince(ws: VscodeWorkspace, files: PlannedFile[], expect: "original" | "final"): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    const want = expect === "original" ? f.original : f.final;
    const current = await ws.readText(f.path).catch(() => null);
    if (want === null ? current !== null : current !== want) {
      out.push(f.path);
    }
  }
  return out;
}

/** direction: "apply" = 変更前 → 変更後 / "revert" = 変更後 → 変更前 */
export async function applyPlanFiles(ws: VscodeWorkspace, files: PlannedFile[], direction: "apply" | "revert"): Promise<boolean> {
  const edit = new vscode.WorkspaceEdit();
  for (const f of files) {
    const uri = ws.uriOf(f.path);
    const from = direction === "apply" ? f.original : f.final;
    const to = direction === "apply" ? f.final : f.original;
    if (from === null) {
      edit.createFile(uri, { ignoreIfExists: false, contents: new TextEncoder().encode(to ?? "") });
      continue;
    }
    if (to === null) {
      edit.deleteFile(uri, { ignoreIfNotExists: true });
      continue;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    for (const e of textEdits(from, to)) {
      edit.replace(uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
    }
  }
  return vscode.workspace.applyEdit(edit);
}

/** 反映したファイルのうち、未保存のものを保存する */
export async function savePlanFiles(ws: VscodeWorkspace, files: PlannedFile[]): Promise<void> {
  for (const f of files) {
    const uri = ws.uriOf(f.path);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (doc?.isDirty) {
      await doc.save();
    }
  }
}

// ---------- テストの実行 ----------

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** 出力の末尾 maxLines 行 */
export function tailLines(text: string, maxLines: number): string {
  const lines = text.replace(ANSI, "").split(/\r?\n/);
  return (lines.length > maxLines ? ["…(前半は省略)", ...lines.slice(-maxLines)] : lines).join("\n").trim();
}

/** 設定されたテストコマンドをワークスペースのフォルダで実行する */
export function runTestCommand(
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; code: number | null; output: string }> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal },
      (error, stdout, stderr) => {
        const output = tailLines(`${stdout ?? ""}\n${stderr ?? ""}`, 80);
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : null) : 0;
        resolve({ ok: !error, code, output });
      },
    );
  });
}
