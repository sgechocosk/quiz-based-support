import { describeRules, parseProjectRules, PROJECT_RULES_PATH } from "./patterns";
import type { WorkspacePort } from "./ports";

/**
 * システムの全体像(入力補助が、依頼に足りない情報を見つけるための手がかり)。
 * README・package.json・ディレクトリ構成・プロジェクトの約束・構成の地図から、API を使わずに作る。
 * 変わりにくいので、プロンプトの固定の先頭に置いてキャッシュに当てる。
 */

/** 全体像の最大の長さ(文字数) */
export const OVERVIEW_CHARS = 7000;
const DOC_CHARS = 1800;
const READ_LIMIT = 60_000;
/** 概要を読むファイル(先に見つかったものから、合計が上限に収まる範囲で) */
const DOCS = ["README.md", "README.ja.md", "CLAUDE.md", "AGENTS.md"];

/** 文書から、見出しの一覧と冒頭の説明を取り出す */
export function summarizeDoc(text: string, limit = DOC_CHARS): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const headings: string[] = [];
  const intro: string[] = [];
  let inCode = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      continue;
    }
    if (/^#{1,3}\s/.test(line)) {
      headings.push(line.replace(/^#+\s*/, "").trim());
    } else if (headings.length <= 1 && line.trim() && !/^[|>!\-*]/.test(line.trim())) {
      intro.push(line.trim());
    }
  }
  const head = headings.slice(0, 40).join(" / ");
  return [intro.join("\n").slice(0, Math.floor(limit * 0.5)), head ? `見出し: ${head}` : ""].filter(Boolean).join("\n").slice(0, limit);
}

/** package.json から、名前・説明・VS Code 拡張のコマンドと設定 */
export function summarizePackage(text: string): string {
  let pkg: any;
  try {
    pkg = JSON.parse(text);
  } catch {
    return "";
  }
  const out: string[] = [];
  const name = [pkg.displayName, pkg.name].filter(Boolean).join(" / ");
  if (name || pkg.description) {
    out.push([name, pkg.description].filter(Boolean).join(": "));
  }
  const scripts = Object.keys(pkg.scripts ?? {});
  if (scripts.length > 0) {
    out.push(`スクリプト: ${scripts.slice(0, 15).join(", ")}`);
  }
  const c = pkg.contributes;
  if (c) {
    const commands = (c.commands ?? []).map((x: any) => `${x.command}(${x.title ?? ""})`).slice(0, 12);
    if (commands.length > 0) {
      out.push(`コマンド: ${commands.join(", ")}`);
    }
    const settings = Object.keys(c.configuration?.properties ?? {});
    if (settings.length > 0) {
      out.push(`設定キー: ${settings.slice(0, 40).join(", ")}`);
    }
  }
  return out.join("\n");
}

/** ディレクトリ構成(上位2階層のファイル数) */
export function summarizeTree(paths: string[], limit = 20): string {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const parts = p.split("/");
    const dir = parts.length <= 1 ? "(直下)" : parts.slice(0, Math.min(2, parts.length - 1)).join("/") + "/";
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([d, n]) => `${d}(${n})`)
    .join(" ");
}

async function readOptional(ws: WorkspacePort, path: string): Promise<string | undefined> {
  try {
    return (await ws.readText(path)).slice(0, READ_LIMIT);
  } catch {
    return undefined;
  }
}

/** 全体像を作る。repoMap は索引の「ファイル — 主な名前」の一覧 */
export async function buildOverview(ws: WorkspacePort, repoMap: string): Promise<string> {
  const files = await ws.listFiles().catch(() => []);
  const sections: string[] = [];

  const pkg = await readOptional(ws, "package.json");
  const pkgText = pkg ? summarizePackage(pkg) : "";
  if (pkgText) {
    sections.push(`【プロジェクト】\n${pkgText}`);
  }
  for (const doc of DOCS) {
    const text = await readOptional(ws, doc);
    if (text) {
      sections.push(`【${doc}の要点】\n${summarizeDoc(text)}`);
    }
  }
  const rulesText = await readOptional(ws, PROJECT_RULES_PATH);
  const { rules } = rulesText ? parseProjectRules(rulesText) : { rules: [] };
  if (rules.length > 0) {
    sections.push(`【プロジェクトの約束(これを変えたらあれも確認する)】\n${describeRules(rules)}`);
  }
  const tree = summarizeTree(files.map((f) => f.path));
  if (tree) {
    sections.push(`【ディレクトリ構成(ファイル数)】\n${tree}`);
  }
  if (repoMap) {
    sections.push(`【構成の地図(ファイル — 主な名前)】\n${repoMap}`);
  }
  return sections.join("\n\n").slice(0, OVERVIEW_CHARS);
}
