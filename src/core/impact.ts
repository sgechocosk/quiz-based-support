import { keyDelta, quotedLiteralPattern, siblingKeys, type KeyLiteral } from "./coupling";
import { declarationAt, declarationsOf, enclosingDeclaration, type Declaration } from "./declarations";
import { changedCurrentLines, lineMapper, type LineMapper } from "./diff";
import type { PlanEdit, VirtualWorkspace } from "./overlay";
import { matchingRules, PROJECT_RULES_PATH, type PatternId, type ProjectRule } from "./patterns";
import type { Obligation, PlanStep, Site, Verdict } from "./planTypes";
import type { LocationInfo, LspPort } from "./ports";
import { splitLines, truncate } from "./text";
import { grepWorkspace, matchGlob, normalizeRelPath } from "./tools";

/**
 * 変更の影響を機械的に洗い出す(変更伝播パターンの適用)。
 * ステップの編集から「何の約束が変わったか」を判定し、その種類ごとの探し方で、確認が必要な場所(確認事項)を作る。
 */

export interface ImpactContext {
  vws: VirtualWorkspace;
  lsp?: LspPort;
  rules: ProjectRule[];
  newId: () => string;
}

/** 1つの確認事項に載せる場所の上限(残りは数だけ示す) */
export const MAX_SITES = 6;
/** これより多く出てくる文字列キーは、ありふれていて手がかりにならないので扱わない */
const MAX_KEY_HITS = 40;

const TEST_FILE = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordRegExp(name: string): RegExp {
  return new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);
}

/** 約束が変わったシンボル */
interface Subject {
  name: string;
  pattern: PatternId;
  /** 宣言があるファイル */
  path: string;
  /** 何が変わったか(探し方の説明に使う) */
  what: string;
}

/** 編集の前後の宣言を比べて、約束が変わったシンボルを返す */
export function changedSubjects(edit: PlanEdit): Subject[] {
  if (edit.created) {
    return [];
  }
  const beforeLines = splitLines(edit.fileBefore);
  const afterRange = splitLines(edit.after);
  const afterLines = [...beforeLines.slice(0, edit.startLine - 1), ...afterRange, ...beforeLines.slice(edit.endLine)];
  const s = edit.startLine - 1;
  const e = edit.endLine - 1;
  const afterEnd = s + afterRange.length - 1;
  const overlaps = (d: Declaration, from: number, to: number): boolean => d.line <= to && d.headerEnd >= from;
  const before = declarationsOf(beforeLines).filter((d) => overlaps(d, s, e));
  const afterAll = declarationsOf(afterLines);
  const after = afterAll.filter((d) => overlaps(d, s, afterEnd));
  const out: Subject[] = [];
  const push = (subject: Subject): void => {
    if (subject.name && !out.some((o) => o.name === subject.name && o.pattern === subject.pattern)) {
      out.push(subject);
    }
  };

  for (const b of before) {
    const a =
      after.find((x) => x.name === b.name && x.kind === b.kind) ?? afterAll.find((x) => x.name === b.name && x.kind === b.kind);
    if (a && a.header === b.header) {
      continue;
    }
    let name = b.name;
    if (name === "constructor") {
      // コンストラクタの変更は、クラスを new している場所に影響する
      name = enclosingDeclaration(beforeLines, Math.max(0, b.line - 1), b.line)?.name ?? "";
    }
    const pattern: PatternId =
      b.kind === "interface" || b.kind === "type" ? "data-shape" : b.kind === "enum" ? "branch-cover" : "caller-follow";
    push({ name, pattern, path: edit.path, what: a ? "シグネチャを変えた" : "削除した" });
  }
  if (before.length > 0) {
    return out;
  }

  // 宣言の頭に触れていない変更: どの宣言の中身を変えたか
  const enc = enclosingDeclaration(beforeLines, s, e);
  if (!enc) {
    return out;
  }
  const changedText = `${edit.before}\n${edit.after}`;
  const name = enc.name === "constructor" ? (enclosingDeclaration(beforeLines, Math.max(0, enc.line - 1), enc.line)?.name ?? "") : enc.name;
  switch (enc.kind) {
    case "interface":
      push({ name, pattern: "data-shape", path: edit.path, what: "メンバーを変えた" });
      break;
    case "enum":
      push({ name, pattern: "branch-cover", path: edit.path, what: "値を変えた" });
      break;
    case "type":
      push({ name, pattern: /\|/.test(changedText) ? "branch-cover" : "data-shape", path: edit.path, what: "定義を変えた" });
      break;
    case "class": {
      // メソッドの追加だけなら既存の利用者には影響しない。フィールドの変更はデータの形の変更
      const field = /^\s*(?:(?:public|private|protected|readonly|static|declare)\s+)*[A-Za-z_$][\w$]*\s*[?!]?\s*[:=]/m;
      const declaresMethod = declarationsOf(afterRange).length > 0;
      if (!declaresMethod && (field.test(edit.before) || field.test(edit.after))) {
        push({ name, pattern: "data-shape", path: edit.path, what: "フィールドを変えた" });
      }
      break;
    }
    default:
      if (/\b(?:return|throw)\b|\b(?:resolve|reject)\(/.test(changedText)) {
        push({ name, pattern: "behavior-callers", path: edit.path, what: "戻り値・エラーの扱いを変えた" });
      }
  }
  return out;
}

/** 確認事項を組み立てる途中の入れ物(同じパターン・対象のものはまとめる) */
class Collector {
  private readonly byKey = new Map<string, Obligation>();

  constructor(
    private readonly step: PlanStep,
    private readonly newId: () => string,
  ) {}

  add(
    pattern: PatternId,
    subject: string,
    query: string,
    sites: Site[],
    autos: Verdict[] = [],
    extra: Pick<Obligation, "ruleName" | "criterion"> = {},
  ): void {
    if (sites.length === 0 && autos.length === 0) {
      return;
    }
    const key = `${pattern}|${subject}`;
    let o = this.byKey.get(key);
    if (!o) {
      o = {
        id: this.newId(),
        pattern,
        fromStep: this.step.id,
        subject,
        query,
        sites: [],
        more: 0,
        status: "open",
        verdicts: [],
        attempts: 0,
        ...extra,
      };
      this.byKey.set(key, o);
    }
    for (const site of sites) {
      if (o.sites.some((x) => x.path === site.path && x.line === site.line)) {
        continue;
      }
      if (o.sites.length >= MAX_SITES) {
        o.more++;
      } else {
        o.sites.push(site);
      }
    }
    o.verdicts.push(...autos.filter((a) => !o!.verdicts.some((v) => v.path === a.path && v.line === a.line)));
  }

  result(): Obligation[] {
    return [...this.byKey.values()].map((o) => (o.sites.length === 0 ? { ...o, status: "done" as const } : o));
  }
}

/** 現在の内容の行(行番号は1始まり)と、その行を含む宣言の名前 */
export async function siteAt(vws: VirtualWorkspace, path: string, line: number, note?: string): Promise<Site> {
  const lines = splitLines(await vws.readText(path).catch(() => ""));
  const enclosing = enclosingDeclaration(lines, line - 1, line - 1);
  const site: Site = { path, line, text: truncate((lines[line - 1] ?? "").trim(), 200) };
  if (enclosing) {
    site.symbol = enclosing.name;
  }
  if (note) {
    site.note = note;
  }
  return site;
}

/**
 * シンボルの参照を探し、現在の行番号の場所にする。
 * - 言語サーバ(変更前の内容での位置)→ 計画を重ねた現在の位置に読み替える
 * - 言語サーバが使えない・見つからないときは単語の検索で代わりにする
 * - このステップで書き換えた行は除き、計画内の別のステップで書き換え済みの行は「確認済み」とする
 */
async function referenceSites(
  subject: Subject,
  own: Map<string, Set<number>>,
  preStep: ReadonlyMap<string, string | null>,
  ctx: ImpactContext,
): Promise<{ sites: Site[]; autos: Verdict[]; query: string }> {
  const { vws, lsp } = ctx;
  const sites: Site[] = [];
  const autos: Verdict[] = [];
  const keepImport = subject.what === "削除した";
  const skipLine = (text: string): boolean => !keepImport && /^\s*(?:import\b|export\s*\{)/.test(text);

  let locs: LocationInfo[] = [];
  // 言語サーバが宣言自身を含めて何か返したら、その答えを信用する(何も返さないのは起動待ち等とみなして単語検索へ)
  let answered = false;
  const original = await vws.original(subject.path);
  if (lsp && original) {
    const lines = splitLines(original);
    const decl = declarationsOf(lines).find((d) => d.name === subject.name);
    if (decl) {
      const ch = lines[decl.line]!.search(wordRegExp(subject.name));
      try {
        const all = await lsp.references(subject.path, decl.line + 1, Math.max(ch, 0));
        answered = all.length > 0;
        locs = all.filter((l) => !(l.path === subject.path && l.line === decl.line + 1));
      } catch {
        locs = [];
      }
    }
  }

  if (answered) {
    const preMappers = new Map<string, LineMapper>();
    for (const loc of locs.slice(0, 80)) {
      const mapper = await vws.mapper(loc.path);
      const current = mapper.toCurrent(loc.line);
      const originalText = splitLines((await vws.original(loc.path)) ?? "")[loc.line - 1] ?? "";
      if (skipLine(originalText)) {
        continue;
      }
      if (current === undefined) {
        // 変更前の行が書き換わっている: このステップの変更か、計画内の別のステップの変更か
        if (!preMappers.has(loc.path)) {
          const pre = preStep.has(loc.path) ? (preStep.get(loc.path) ?? "") : await vws.readText(loc.path).catch(() => "");
          preMappers.set(loc.path, lineMapper((await vws.original(loc.path)) ?? "", pre));
        }
        if (preMappers.get(loc.path)!.toCurrent(loc.line) === undefined) {
          autos.push({
            path: loc.path,
            line: loc.line,
            text: truncate(originalText.trim(), 200),
            changed: true,
            auto: true,
            reason: "計画内の別のステップで、この行は既に書き換えています",
          });
        }
        continue;
      }
      if (own.get(loc.path)?.has(current)) {
        continue;
      }
      sites.push(await siteAt(vws, loc.path, current));
    }
    return { sites, autos, query: `「${subject.name}」の参照を言語サーバで検索` };
  }

  const { matches } = await grepWorkspace(vws, wordRegExp(subject.name), { limit: 60 });
  for (const m of matches) {
    if (own.get(m.path)?.has(m.line) || declarationAt(m.text)?.name === subject.name || skipLine(m.text)) {
      continue;
    }
    sites.push(await siteAt(vws, m.path, m.line));
  }
  return { sites, autos, query: `単語「${subject.name}」をワークスペース全体で検索(言語サーバの参照検索が使えなかったため)` };
}

/** 文字列キーとして出てくる場所(このステップで書き換えた行を除く) */
async function literalSites(
  literal: string,
  own: Map<string, Set<number>>,
  ctx: ImpactContext,
  exceptPath?: string,
): Promise<Site[] | undefined> {
  const { matches, truncated } = await grepWorkspace(ctx.vws, quotedLiteralPattern(literal), { limit: MAX_KEY_HITS });
  if (truncated) {
    return undefined;
  }
  const out: Site[] = [];
  for (const m of matches) {
    if (m.path === exceptPath || own.get(m.path)?.has(m.line)) {
      continue;
    }
    out.push(await siteAt(ctx.vws, m.path, m.line));
  }
  return out;
}

/** 新しく足した・消した文字列キーの、相手側(送る側と受ける側・登録と利用) */
async function keyObligations(
  added: Array<KeyLiteral & { path: string }>,
  removed: Array<KeyLiteral & { path: string }>,
  own: Map<string, Set<number>>,
  ctx: ImpactContext,
  out: Collector,
): Promise<void> {
  for (const key of added) {
    const elsewhere = await literalSites(key.literal, own, ctx);
    if (elsewhere === undefined) {
      continue;
    }
    if (elsewhere.length > 0) {
      out.add("protocol-pair", `"${key.literal}"`, `文字列「"${key.literal}"」をワークスペース全体で検索`, elsewhere);
      continue;
    }
    // まだどこにも無い新しいキー: 同じ種類の既存のキーを扱っている、別のファイルの場所が相手側の候補
    const text = await ctx.vws.readText(key.path).catch(() => "");
    const siblings = siblingKeys(text, key, 3);
    const sites: Site[] = [];
    for (const sibling of siblings) {
      for (const site of (await literalSites(sibling, own, ctx, key.path)) ?? []) {
        sites.push({ ...site, note: `同じ種類のキー「${sibling}」を扱っている場所` });
      }
    }
    if (sites.length > 0) {
      out.add(
        "protocol-pair",
        `"${key.literal}"`,
        `新しいキー「"${key.literal}"」はまだ他のどこにも無いため、同じ種類の既存のキー「${siblings.join("」「")}」を文字列で検索`,
        sites,
      );
    }
  }
  for (const key of removed) {
    const current = await ctx.vws.readText(key.path).catch(() => "");
    if (quotedLiteralPattern(key.literal).test(current)) {
      continue; // ファイル内にまだ残っている(移動しただけ)
    }
    const sites = await literalSites(key.literal, own, ctx, key.path);
    if (sites && sites.length > 0) {
      out.add("protocol-pair", `"${key.literal}"`, `消したキー「"${key.literal}"」を文字列で検索`, sites);
    }
  }
}

/** プロジェクトの約束(.quiz-support/patterns.json)に当てはまる確認先 */
async function ruleObligations(
  edit: PlanEdit,
  literals: string[],
  own: Map<string, Set<number>>,
  ctx: ImpactContext,
  out: Collector,
): Promise<void> {
  for (const { rule, literal } of matchingRules(ctx.rules, edit.path, literals)) {
    const sites: Site[] = [];
    for (const target of rule.check) {
      const paths = /[*?{]/.test(target)
        ? (await ctx.vws.listFiles()).map((f) => f.path).filter((p) => matchGlob(target, p)).slice(0, 3)
        : [normalizeRelPath(target)].filter((p): p is string => !!p);
      for (const path of paths) {
        if (path === edit.path) {
          continue;
        }
        let lines: string[];
        try {
          lines = splitLines(await ctx.vws.readText(path));
        } catch {
          continue;
        }
        let at = -1;
        if (literal) {
          const re = quotedLiteralPattern(literal);
          at = lines.findIndex((l) => re.test(l));
          // まだ書かれていないキーなら、同じ接頭辞のキーが並んでいる場所を示す(例: "quizSupport.")
          const prefix = literal.replace(/[^.:/-]+$/, "");
          if (at < 0 && prefix) {
            at = lines.findIndex((l) => l.includes(prefix));
          }
        }
        if (at >= 0 && own.get(path)?.has(at + 1)) {
          continue;
        }
        sites.push(await siteAt(ctx.vws, path, at >= 0 ? at + 1 : 1, at >= 0 ? undefined : "ファイル全体を確認"));
      }
    }
    out.add(
      "project-rule",
      `${rule.name}${literal ? `(${literal})` : ""}`,
      rule.howToFind ?? `${PROJECT_RULES_PATH} の約束「${rule.name}」: ${rule.check.join(", ")} を確認`,
      sites,
      [],
      { ruleName: rule.name, criterion: rule.criterion },
    );
  }
}

/**
 * ステップの変更から確認事項を作る。
 * preStep: このステップを適用する直前の、触ったファイルの内容(新規作成は null)。
 */
export async function impactOfStep(step: PlanStep, preStep: ReadonlyMap<string, string | null>, ctx: ImpactContext): Promise<Obligation[]> {
  const { vws } = ctx;
  const out = new Collector(step, ctx.newId);
  // このステップで書き換えた行(現在の行番号)。ここに出てくる場所は確認事項にしない
  const own = new Map<string, Set<number>>();
  for (const path of new Set(step.edits.map((e) => e.path))) {
    own.set(path, changedCurrentLines(preStep.get(path) ?? "", await vws.readText(path).catch(() => "")));
  }

  const added: Array<KeyLiteral & { path: string }> = [];
  const removed: Array<KeyLiteral & { path: string }> = [];
  const subjects: Subject[] = [];
  // 「外から見た約束は変わらない」と明言した変更では、本体の戻り値の書き換えを振る舞いの変化とみなさない
  // (シグネチャ・型・キーの変化は構造から判定するので、宣言に関わらず調べる)
  const keepsContract = /変わらない|変更なし|変わりません/.test(step.contract);
  for (const edit of step.edits) {
    const delta = keyDelta(edit.created ? [] : splitLines(edit.before), splitLines(edit.after));
    added.push(...delta.added.filter((k) => !added.some((a) => a.literal === k.literal)).map((k) => ({ ...k, path: edit.path })));
    removed.push(...delta.removed.filter((k) => !removed.some((a) => a.literal === k.literal)).map((k) => ({ ...k, path: edit.path })));
    for (const s of changedSubjects(edit)) {
      if (keepsContract && s.pattern === "behavior-callers") {
        continue;
      }
      if (!subjects.some((x) => x.name === s.name && x.pattern === s.pattern)) {
        subjects.push(s);
      }
    }
  }

  for (const subject of subjects) {
    const { sites, autos, query } = await referenceSites(subject, own, preStep, ctx);
    const forTests = sites.filter((s) => isTestFile(s.path));
    const others = sites.filter((s) => !isTestFile(s.path));
    out.add(subject.pattern, subject.name, `「${subject.name}」の${subject.what}ため、${query}`, others, autos);
    out.add("test-follow", subject.name, `「${subject.name}」の${subject.what}ため、${query}(テストファイルのもの)`, forTests);
  }

  await keyObligations(added, removed, own, ctx, out);

  for (const edit of step.edits) {
    const literals = [...added, ...removed].filter((k) => k.path === edit.path).map((k) => k.literal);
    await ruleObligations(edit, literals, own, ctx, out);
  }
  return out.result();
}
