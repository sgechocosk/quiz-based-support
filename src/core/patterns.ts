import { matchGlob } from "./tools";

/**
 * 「変更したら何を確認するか」の型(変更伝播パターン)。
 * 熟練者が暗黙に行っている判断に名前を付け、きっかけ・探し方・判断基準をそろえて示す。
 */
export type PatternId =
  | "caller-follow"
  | "behavior-callers"
  | "data-shape"
  | "branch-cover"
  | "protocol-pair"
  | "test-follow"
  | "co-change"
  | "type-error"
  | "project-rule";

export interface PatternInfo {
  name: string;
  /** どんな変更がきっかけか */
  trigger: string;
  /** 影響する場所の探し方 */
  howToFind: string;
  /** 変更が必要かの判断基準 */
  criterion: string;
}

export const PATTERNS: Record<PatternId, PatternInfo> = {
  "caller-follow": {
    name: "呼び出し元の追従",
    trigger: "関数・メソッドの引数や戻り値(シグネチャ)を変えた、または削除した",
    howToFind: "そのシンボルの参照(呼び出し元)を、言語サーバの参照検索ですべて探す",
    criterion: "新しい引数を渡しているか、戻り値の使い方が新しい形に合っているか",
  },
  "behavior-callers": {
    name: "振る舞いの変化の確認",
    trigger: "関数の戻り値の意味や、エラー(例外)になる条件を変えた",
    howToFind: "呼び出し元を参照検索し、戻り値や例外で分岐している箇所を見る",
    criterion: "呼び出し元が、変更前の振る舞いを前提にしていないか",
  },
  "data-shape": {
    name: "データ形状の追従",
    trigger: "型・インターフェース・クラスのフィールドを足した/変えた/消した",
    howToFind: "その型の参照(値を作る・読み書きする・変換する・保存する箇所)を探す",
    criterion: "新しいフィールドを設定・読み取り・保存する必要があるか、古いデータも読めるか",
  },
  "branch-cover": {
    name: "分岐の網羅",
    trigger: "列挙値・ユニオン型など「種類」の値を足した/変えた",
    howToFind: "その型を参照している switch / if(種類で分岐している箇所)を探す",
    criterion: "新しい値に対応する分岐が要るか、既定の分岐(default)で足りるか",
  },
  "protocol-pair": {
    name: "キーの対応(送る側と受ける側)",
    trigger: "メッセージの種類・設定キー・イベント名などの文字列キーを足した/変えた/消した",
    howToFind: "同じキー、または同じ種類の既存のキーを、文字列として検索する(参照検索では見つからない)",
    criterion: "送る側と受ける側、登録する側と使う側がそろっているか",
  },
  "test-follow": {
    name: "テストの追従",
    trigger: "テストから使われている関数・型を変えた",
    howToFind: "そのシンボルの参照のうち、テストファイルにあるものを見る",
    criterion: "テストが新しい引数・振る舞いに合っているか、新しい振る舞いを確かめるテストが要るか",
  },
  "co-change": {
    name: "一緒に変わってきたファイル",
    trigger: "過去のコミットで、今回変えたファイルと一緒に変更されることが多い",
    howToFind: "変更履歴(git log)で、同じコミットで変更された頻度を数える",
    criterion: "今回の変更でも同じように手を入れる必要があるか(説明文・設定・テストなど)",
  },
  "type-error": {
    name: "型エラーの解消",
    trigger: "変更後のコードを型検査したら、新しいエラーが出た",
    howToFind: "型検査(コンパイラ)のエラー一覧を見る",
    criterion: "エラーの原因が今回の変更の追従漏れか(元の変更を取り消して直さない)",
  },
  "project-rule": {
    name: "プロジェクトの約束",
    trigger: "このプロジェクトで決められた「これを変えたらあれも変える」に当てはまる",
    howToFind: ".quiz-support/patterns.json に書かれた確認先を見る",
    criterion: "約束に書かれた判断基準",
  },
};

// ---------- プロジェクト固有の約束(.quiz-support/patterns.json) ----------

/**
 * 例:
 * [{ "name": "設定の登録", "when": { "literal": "^quizSupport\\." }, "check": ["package.json", "README.md"],
 *    "criterion": "設定を足したら package.json の contributes.configuration と README の表にも書く" }]
 */
export interface ProjectRule {
  name: string;
  /** 変更したファイルのパスに一致する glob */
  path?: string;
  /** 追加・削除した文字列キーに一致する正規表現 */
  literal?: RegExp;
  /** 確認するファイル(パスまたは glob) */
  check: string[];
  criterion: string;
  howToFind?: string;
}

export const PROJECT_RULES_PATH = ".quiz-support/patterns.json";

/** 約束のファイルを読み取る。不正な項目は捨て、理由を errors に入れる。 */
export function parseProjectRules(text: string): { rules: ProjectRule[]; errors: string[] } {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { rules: [], errors: [`${PROJECT_RULES_PATH} を JSON として読めません: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!Array.isArray(raw)) {
    return { rules: [], errors: [`${PROJECT_RULES_PATH} は配列にしてください`] };
  }
  const rules: ProjectRule[] = [];
  raw.forEach((entry: any, i) => {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    const check = Array.isArray(entry?.check) ? entry.check.filter((c: unknown) => typeof c === "string" && c.trim()) : [];
    const when = entry?.when ?? {};
    const path = typeof when.path === "string" && when.path.trim() ? when.path.trim() : undefined;
    let literal: RegExp | undefined;
    if (typeof when.literal === "string" && when.literal.trim()) {
      try {
        literal = new RegExp(when.literal);
      } catch {
        errors.push(`${i + 1}件目: when.literal の正規表現が不正です`);
        return;
      }
    }
    if (!name || check.length === 0 || (!path && !literal)) {
      errors.push(`${i + 1}件目: name・check・when(path か literal)が必要です`);
      return;
    }
    rules.push({
      name,
      path,
      literal,
      check: check.map((c: string) => c.trim()),
      criterion: typeof entry.criterion === "string" ? entry.criterion.trim() : "",
      howToFind: typeof entry.howToFind === "string" ? entry.howToFind.trim() : undefined,
    });
  });
  return { rules, errors };
}

/** 変更したファイル・キーに当てはまる約束 */
export function matchingRules(rules: ProjectRule[], changedPath: string, literals: string[]): Array<{ rule: ProjectRule; literal?: string }> {
  const out: Array<{ rule: ProjectRule; literal?: string }> = [];
  for (const rule of rules) {
    const literal = rule.literal ? literals.find((l) => rule.literal!.test(l)) : undefined;
    const pathHit = rule.path ? matchGlob(rule.path, changedPath) : false;
    if (literal !== undefined || pathHit) {
      out.push({ rule, literal });
    }
  }
  return out;
}

/** プロンプトに載せる、約束の一覧 */
export function describeRules(rules: ProjectRule[]): string {
  return rules
    .map((r) => {
      const when = [r.path ? `${r.path} を変えたら` : "", r.literal ? `/${r.literal.source}/ に当てはまるキーを足す・変えたら` : ""]
        .filter(Boolean)
        .join("、または");
      return `- ${r.name}: ${when} ${r.check.join(", ")} を確認する。${r.criterion}`;
    })
    .join("\n");
}
