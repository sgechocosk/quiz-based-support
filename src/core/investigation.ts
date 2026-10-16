import { normalizeRelPath, type CodeIndex, type EvidenceStore } from "./tools";

/**
 * 「何を知る必要があるか」から調査を進め、材料が足りたかを判断して終える仕組み。
 * 1) 調べることを決める: 要求に答える(実装する)ために知る必要があることを、種類つきの項目にする
 * 2) 調べる: 項目に沿ってツールで確かめる(呼び出し回数は上限であって目安ではない)
 * 3) 足りたかを判断する: 項目ごとに「分かった(根拠の範囲)/不要(理由)/まだ」を答えさせ、
 *    根拠の範囲を実際に読んだかをシステムが確かめる。まだの項目があれば、それを伝えて調査を続ける
 * LLM は「全体として十分か」の判断が苦手なので、項目ごとの判断に分け、根拠は機械的に確かめる。
 */

/** 調べることの種類 */
export type NeedKind = "change_site" | "core" | "example" | "definition" | "caller" | "data" | "other";

export const NEED_KINDS: NeedKind[] = ["change_site", "core", "example", "definition", "caller", "data", "other"];

export const NEED_LABEL: Record<NeedKind, string> = {
  change_site: "変更する場所",
  core: "中心の処理",
  example: "手本",
  definition: "定義",
  caller: "呼び出し元・入口",
  data: "データ・画面・設定",
  other: "その他",
};

/** 参照コードに並べる順(小さいほど先) */
const KIND_RANK: Record<NeedKind, number> = {
  change_site: 0,
  core: 0,
  example: 1,
  definition: 2,
  data: 3,
  caller: 4,
  other: 5,
};

export interface CodeSpan {
  path: string;
  startLine: number;
  endLine: number;
}

export interface InfoNeed {
  id: string;
  /** 何が分かればよいか(問いの形) */
  need: string;
  kind: NeedKind;
  /** それが分からないと何が決められないか */
  why: string;
  /** 探し方(候補のファイル・識別子・キーワード) */
  hints: string;
  status: "open" | "found" | "not_needed";
  /** 分かった根拠の範囲(実際に読んだことを確かめたもの) */
  locations: CodeSpan[];
  /** 分かったこと / 不要な理由 / 何がまだ分からないか */
  note: string;
}

/** 計画で作る項目の上限 */
const MAX_PLANNED = 6;
/** 調査中に足した項目を含めた上限 */
export const MAX_NEEDS = 10;
/** 根拠の範囲のうち、この割合以上を読んでいれば「読んだ」とみなす */
const GROUNDED_RATIO = 0.5;
/** 長い範囲を根拠にしたときは、この行数以上を読んでいれば「読んだ」とみなす */
const GROUNDED_LINES = 40;

const STRING = { type: "string" } as const;
const INTEGER = { type: "integer" } as const;

const NEED_ITEM = {
  type: "object",
  properties: { need: STRING, kind: { type: "string", enum: NEED_KINDS }, why: STRING, hints: STRING },
  required: ["need", "kind", "why", "hints"],
  additionalProperties: false,
} as const;

export const NEEDS_SCHEMA = {
  name: "investigation_plan",
  schema: {
    type: "object",
    properties: { needs: { type: "array", items: NEED_ITEM } },
    required: ["needs"],
    additionalProperties: false,
  },
} as const;

export const REVIEW_SCHEMA = {
  name: "sufficiency",
  schema: {
    type: "object",
    properties: {
      needs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: STRING,
            status: { type: "string", enum: ["found", "not_needed", "missing"] },
            locations: {
              type: "array",
              items: {
                type: "object",
                properties: { path: STRING, startLine: INTEGER, endLine: INTEGER },
                required: ["path", "startLine", "endLine"],
                additionalProperties: false,
              },
            },
            note: STRING,
          },
          required: ["id", "status", "locations", "note"],
          additionalProperties: false,
        },
      },
      newNeeds: { type: "array", items: NEED_ITEM },
      summary: STRING,
    },
    required: ["needs", "newNeeds", "summary"],
    additionalProperties: false,
  },
} as const;

export interface RawNeed {
  need?: string;
  kind?: string;
  why?: string;
  hints?: string;
}

export interface RawReview {
  needs?: Array<{ id?: string; status?: string; locations?: Array<Partial<CodeSpan>>; note?: string }>;
  newNeeds?: RawNeed[];
  summary?: string;
}

export interface ReviewOutcome {
  /** すべての項目が分かった(または不要と分かった)うえで、必須の項目が根拠つきで分かった */
  sufficient: boolean;
  /** まだ分かっていない項目 */
  open: InfoNeed[];
  /** 「分かった」の根拠にされたが、読んでいなかった範囲 */
  unread: string[];
  summary: string;
}

/** 依頼の種類ごとに、必ず確かめる項目の種類(実装依頼は変更する場所、仕組みの質問は中心の処理) */
function requiredKind(change: boolean): NeedKind {
  return change ? "change_site" : "core";
}

function blankNeed(kind: NeedKind, need: string, why: string): InfoNeed {
  return { id: "", need, kind, why, hints: "", status: "open", locations: [], note: "" };
}

function requiredNeed(change: boolean): InfoNeed {
  return change
    ? blankNeed("change_site", "要求を満たすために変更する(足す)関数・ブロックはどこか", "変更を書く場所が決まらない")
    : blankNeed("core", "質問の答えになる中心の処理はどれか", "何を説明すればよいかが決まらない");
}

/** 計画を作れなかったときに使う項目 */
export function defaultNeeds(change: boolean): InfoNeed[] {
  const needs = change
    ? [
        requiredNeed(true),
        blankNeed("example", "同じ種類のことをしている既存の実装(手本)はどれか", "新しいコードの書き方と名前の付け方を合わせられない"),
      ]
    : [requiredNeed(false), blankNeed("caller", "その処理はどこから呼ばれるか", "処理が始まるきっかけを説明できない")];
  return numbered(needs);
}

function numbered(needs: InfoNeed[]): InfoNeed[] {
  needs.forEach((n, i) => (n.id = `n${i + 1}`));
  return needs;
}

function toNeed(raw: RawNeed | undefined): InfoNeed | undefined {
  const need = raw?.need?.trim();
  if (!need) {
    return undefined;
  }
  const kind = NEED_KINDS.includes(raw?.kind as NeedKind) ? (raw!.kind as NeedKind) : "other";
  return { ...blankNeed(kind, need, raw?.why?.trim() ?? ""), hints: raw?.hints?.trim() ?? "" };
}

/** 計画の出力を項目にする。必須の種類が無ければ先頭に足す。項目が無ければ既定の項目にする */
export function parseNeeds(raw: { needs?: RawNeed[] } | undefined, change: boolean): InfoNeed[] {
  const needs = (raw?.needs ?? [])
    .map(toNeed)
    .filter((n): n is InfoNeed => n !== undefined)
    .slice(0, MAX_PLANNED);
  if (needs.length === 0) {
    return defaultNeeds(change);
  }
  if (!needs.some((n) => n.kind === requiredKind(change))) {
    needs.unshift(requiredNeed(change));
  }
  return numbered(needs);
}

function describeNeed(n: InfoNeed): string {
  return `- ${n.id} [${NEED_LABEL[n.kind]}] ${n.need}${n.hints ? `(探し方: ${n.hints})` : ""}`;
}

export function formatSpan(s: CodeSpan): string {
  return `${s.path}:${s.startLine}-${s.endLine}`;
}

/** 調べることを決めてもらう依頼(調査の会話の続きとして、ツールを使わずに JSON で答えさせる) */
export function planRequest(change: boolean): string {
  return [
    "調べ始める前に、この要求に答える(実装する)ために何を知る必要があるかを決めてください。ツールは使わず、指定のJSONで答えます。",
    "",
    "【調べることの決め方】",
    ...(change
      ? [
          "- change_site(変更する場所): 要求を満たすために、どの関数・ブロックを変える(足す)か。必ず1つ以上。",
          "- example(手本): 同じ種類のことをしている既存の実装(似た機能・同じ仕組みの別の使い方)。新しいコードの書き方と名前の付け方を合わせるため。",
          "- definition(定義): 新しいコードが呼ぶ関数・使う型・設定の定義。",
          "- caller(呼び出し元・入口): 変更する処理がどこから呼ばれるか、操作がどこから始まるか(画面・コマンド・メッセージ)。",
          "- data(データ・画面・設定): 要求が画面・メッセージ・設定・保存データに及ぶなら、その送る側と受ける側。",
        ]
      : [
          "- core(中心の処理): 質問の答えになる処理そのもの。必ず1つ以上。",
          "- caller(呼び出し元・入口): その処理がどこから始まり、誰から呼ばれるか。",
          "- definition(定義): 中心の処理が使う関数・型・データの定義。",
        ]),
    `- 要求に関係しない項目は作らない。小さな依頼なら2〜3項目、画面や複数の仕組みにまたがる依頼なら4〜${MAX_PLANNED}項目が目安。`,
    "- need: 何が分かればよいかを、答えられる形の問いで1文(例:「設定を読み込んで反映している関数はどれか」)。",
    "- why: それが分からないと何が決められないか。",
    "- hints: 探し方(候補のファイル・識別子・英語のキーワード・grep のパターン)。概観や手がかりから具体的に。",
  ].join("\n");
}

/** 調べ始めるときの指示 */
export function startMessage(needs: InfoNeed[], budget: number): string {
  return [
    "次の項目を、ツールで調べて確かめてください。",
    ...needs.map(describeNeed),
    "",
    `- ツール呼び出しは最大${budget}回(目安ではなく上限)。全部の項目が分かったら、上限を待たずにツールを呼ばずに終えてください。`,
    "- 互いに関係しない呼び出し(別々のファイルを読む・別々の名前を探す)は、1回の応答でまとめて呼べます。",
  ].join("\n");
}

/** 材料が足りたかを判断してもらう依頼 */
export function reviewRequest(needs: InfoNeed[], opts: { final: boolean; remaining: number; gaps: string[] }): string {
  const prior = (n: InfoNeed): string =>
    n.status === "found" ? "(前回: 分かった)" : n.status === "not_needed" ? "(前回: 不要)" : n.note ? `(前回: まだ — ${n.note})` : "";
  const lines = [
    opts.final
      ? "ツール呼び出しの上限に達しました。ここまでに読んだコードで、各項目が分かったかを判断してください。ツールは使わず、指定のJSONで答えます。"
      : "ここまでに集めた材料で足りるかを確認します。ツールは使わず、指定のJSONで答えてください。",
    "",
    "【項目】",
    ...needs.map((n) => `${describeNeed(n)}${prior(n)}`),
    "",
    "【判断のしかた】",
    "- found: その項目に答えるコードを read_file などで実際に読んで確かめた。locations に、根拠の範囲(表示された行番号のとおり)を1〜3件書く。",
    "  名前や検索結果の一部を見ただけで中身を読んでいなければ missing にする(読んでいない範囲を根拠にすると、システムが missing に戻します)。",
    "- not_needed: 読んだ結果、この要求には関係しない・既存のままでよいと分かった。note に理由を書く。",
    "- missing: まだ分からない。note に、何が分からないか・次にどこを調べるかを書く。",
    "- note: found なら、そこで分かったこと(何を受け取り、何を返し、誰から呼ばれるか)を1文で。",
    opts.final
      ? "- newNeeds は空配列にする。"
      : "- newNeeds: 読んで初めて分かった、調べる必要のある項目(例: 送る側に対応する受ける側、変更する処理を呼ぶ別の場所)。すでにある項目と同じものは書かない。無ければ空配列。",
    "- summary: 要求に関係する重要な場所と役割を、短い箇条書きで(ファイル名:行 と、なぜ重要か)。",
    ...(opts.gaps.length > 0
      ? [
          "",
          "【参考: 変更する場所・中心の処理で使っているが、定義をまだ読んでいない名前】",
          ...opts.gaps.map((g) => `- ${g}`),
          opts.final
            ? "これらの振る舞いが分からないまま扱う項目は、note にそのことを書いてください。"
            : "新しいコードでこれらを使う・振る舞いを左右するなら、newNeeds(definition)に加えてください。",
        ]
      : []),
  ];
  if (!opts.final) {
    lines.push("", `(残りのツール呼び出し: ${opts.remaining}回)`);
  }
  return lines.join("\n");
}

/** まだ分かっていない項目を伝えて、調査を続けてもらう */
export function continueMessage(outcome: ReviewOutcome, remaining: number): string {
  return [
    `まだ分かっていない項目があります。ツールで調べてください(残りのツール呼び出し: ${remaining}回)。`,
    ...outcome.open.map((n) => `${describeNeed(n)}${n.note ? ` — ${n.note}` : ""}`),
    outcome.unread.length > 0
      ? `読んでいない範囲を根拠にしていました: ${outcome.unread.join(", ")}(read_file で読んでから判断してください)`
      : "",
    "調べた結果、不要と分かった項目は次の確認で not_needed にしてかまいません。分かったら、ツールを呼ばずに終えてください。",
  ]
    .filter(Boolean)
    .join("\n");
}

function toSpan(raw: Partial<CodeSpan> | undefined): CodeSpan | undefined {
  const path = normalizeRelPath(String(raw?.path ?? ""));
  const start = Math.trunc(Number(raw?.startLine));
  const end = Math.trunc(Number(raw?.endLine));
  if (!path || !Number.isFinite(start) || start < 1) {
    return undefined;
  }
  return { path, startLine: start, endLine: Number.isFinite(end) && end >= start ? end : start };
}

/** 範囲を実際に読んだか(短い範囲は半分以上、長い範囲は一定の行数以上) */
function isGrounded(span: CodeSpan, evidence: Pick<EvidenceStore, "coverage">): boolean {
  const ratio = evidence.coverage(span.path, span.startLine, span.endLine);
  return ratio >= GROUNDED_RATIO || ratio * (span.endLine - span.startLine + 1) >= GROUNDED_LINES;
}

function sameNeed(a: InfoNeed, b: InfoNeed): boolean {
  const squash = (s: string) => s.replace(/[\s、。・「」()()]/g, "");
  return a.kind === b.kind && squash(a.need) === squash(b.need);
}

/**
 * 材料の確認の結果を項目に反映し、足りたかを判定する。
 * - found は、根拠の範囲を実際に読んでいるときだけ認める(読んでいなければ「まだ」に戻す)
 * - 新しく分かった項目は「まだ」として足す(上限 MAX_NEEDS)
 * - 必須の種類(実装依頼は変更する場所、仕組みの質問は中心の処理)が根拠つきで分かっていなければ足りない
 */
export function applyReview(
  needs: InfoNeed[],
  raw: RawReview | undefined,
  evidence: Pick<EvidenceStore, "coverage">,
  opts: { change: boolean; final: boolean },
): ReviewOutcome {
  const unread: string[] = [];
  for (const r of raw?.needs ?? []) {
    const need = needs.find((n) => n.id === r?.id?.trim());
    if (!need) {
      continue;
    }
    const note = r.note?.trim() ?? "";
    if (r.status === "not_needed") {
      Object.assign(need, { status: "not_needed", locations: [], note });
      continue;
    }
    if (r.status === "found") {
      const spans = (r.locations ?? []).map(toSpan).filter((s): s is CodeSpan => s !== undefined);
      const grounded = spans.filter((s) => isGrounded(s, evidence));
      const missing = spans.filter((s) => !grounded.includes(s)).map(formatSpan);
      unread.push(...missing);
      if (grounded.length > 0) {
        Object.assign(need, { status: "found", locations: grounded.slice(0, 3), note });
      } else {
        Object.assign(need, {
          status: "open",
          locations: [],
          note: missing.length > 0 ? `${missing.join(", ")} はまだ読んでいない` : "根拠の場所が示されていない",
        });
      }
      continue;
    }
    Object.assign(need, { status: "open", locations: [], note: note || need.note });
  }
  if (!opts.final) {
    for (const rawNeed of raw?.newNeeds ?? []) {
      const n = toNeed(rawNeed);
      if (needs.length >= MAX_NEEDS) {
        break;
      }
      if (n && !needs.some((x) => sameNeed(x, n))) {
        n.id = `n${needs.length + 1}`;
        needs.push(n);
      }
    }
  }
  const kind = requiredKind(opts.change);
  if (!needs.some((n) => n.kind === kind && n.status === "found")) {
    const target = needs.find((n) => n.kind === kind);
    if (target) {
      if (target.status !== "open") {
        Object.assign(target, { status: "open", locations: [], note: `${NEED_LABEL[kind]}が根拠つきで1つも確かめられていない` });
      }
    } else if (needs.length < MAX_NEEDS) {
      needs.push({ ...requiredNeed(opts.change), id: `n${needs.length + 1}` });
    }
  }
  const open = needs.filter((n) => n.status === "open");
  return { sufficient: open.length === 0, open, unread, summary: raw?.summary?.trim() ?? "" };
}

const NOT_NAMES = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "typeof", "await", "new", "super", "this", "constructor",
  "console", "require", "import", "export", "async", "Promise", "Array", "Object", "String", "Number", "Boolean",
  "Map", "Set", "JSON", "Math", "Date", "Error", "RegExp", "Symbol", "parseInt", "parseFloat", "setTimeout",
  "clearTimeout", "push", "map", "filter", "slice", "join", "split", "replace", "includes", "some", "every",
  "find", "forEach", "reduce", "sort", "trim", "test", "then", "get", "set", "has", "keys", "values", "entries",
]);

/** 行の中で呼んでいる関数・使っている型の名前(定義をまだ読んでいないものを見つけるのに使う) */
export function usedNames(lines: string[]): string[] {
  const names = new Set<string>();
  for (const line of lines) {
    const code = line.replace(/\/\/.*$/, "").replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
    for (const m of code.matchAll(/(?<![\w$])([A-Za-z_$][\w$]{2,})\s*(?:<[^<>()]*>)?\s*\(/g)) {
      names.add(m[1]!);
    }
    for (const m of code.matchAll(/(?::|\bnew|\bextends|\bimplements)\s+([A-Z][\w$]{2,})/g)) {
      names.add(m[1]!);
    }
  }
  return [...names].filter((n) => !NOT_NAMES.has(n));
}

/**
 * 分かった「変更する場所・中心の処理・手本」の範囲で使っているのに、定義をまだ読んでいない名前(「名前(定義の場所)」)。
 * 計画で既存の関数を正しく使うための材料が欠けていないかを、機械的に見つける。
 */
export function definitionGaps(
  needs: InfoNeed[],
  evidence: Pick<EvidenceStore, "coverage" | "linesIn">,
  index: Pick<CodeIndex, "findSymbols">,
  limit = 5,
): string[] {
  const gaps: string[] = [];
  const seen = new Set<string>();
  for (const need of needs) {
    if (need.status !== "found" || !["change_site", "core", "example"].includes(need.kind)) {
      continue;
    }
    for (const span of need.locations) {
      for (const name of usedNames(evidence.linesIn(span.path, span.startLine, span.endLine))) {
        if (seen.has(name)) {
          continue;
        }
        seen.add(name);
        const def = index.findSymbols(name, 50).find((c) => c.symbols.includes(name));
        if (!def || (def.file === span.path && def.startLine <= span.endLine && def.endLine >= span.startLine)) {
          continue;
        }
        if (evidence.coverage(def.file, def.startLine, Math.min(def.endLine, def.startLine + 30)) >= 0.3) {
          continue;
        }
        gaps.push(`${name}(${def.file}:${def.startLine})`);
        if (gaps.length >= limit) {
          return gaps;
        }
      }
    }
  }
  return gaps;
}

/** 調査で確かめた場所を、計画・出題に渡す参照コードで優先する */
export function markKeyLocations(needs: InfoNeed[], evidence: Pick<EvidenceStore, "markKey">): void {
  for (const n of needs) {
    if (n.status === "found") {
      for (const s of n.locations) {
        evidence.markKey(s.path, s.startLine, s.endLine, KIND_RANK[n.kind]);
      }
    }
  }
}

/** 調査メモ(計画・出題・要件の整理に渡す)。要点に、確かめた場所・不要と判断したこと・調べきれなかったことを添える */
export function formatNotes(needs: InfoNeed[], summary: string): string {
  const found = needs.filter((n) => n.status === "found").sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  const skipped = needs.filter((n) => n.status === "not_needed" && n.note);
  const open = needs.filter((n) => n.status === "open");
  const parts = [summary.trim()];
  if (found.length > 0) {
    parts.push(
      ["【調査で確かめた場所】", ...found.map((n) => `- [${NEED_LABEL[n.kind]}] ${n.locations.map(formatSpan).join(", ")} — ${n.note || n.need}`)].join("\n"),
    );
  }
  if (skipped.length > 0) {
    parts.push(["【調べて不要と判断したこと】", ...skipped.map((n) => `- ${n.need} — ${n.note}`)].join("\n"));
  }
  if (open.length > 0) {
    parts.push(
      [
        "【調べきれなかったこと(推測で補わず、確かめた範囲で扱う)】",
        ...open.map((n) => `- [${NEED_LABEL[n.kind]}] ${n.need}${n.note ? ` — ${n.note}` : ""}`),
      ].join("\n"),
    );
  }
  return parts.filter(Boolean).join("\n\n");
}

/** 次に材料を確かめるまでのツール呼び出しの回数(まだの項目1つにつき、探す + 読むの2回程度) */
export function checkpointAfter(openCount: number): number {
  return Math.max(3, openCount * 2 + 1);
}
