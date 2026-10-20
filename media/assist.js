// @ts-check
/*
 * 入力補助の、画面に依存しない処理(webview とユニットテストの両方で使う)。
 * - 打った文字が候補の先頭と同じなら、残りの候補を返す
 * - 置き換え案と書きかけの差を、残る部分・足す部分・消える部分に分ける
 */
(function (root) {
  "use strict";

  /** 打った文字が候補の先頭と同じなら、残りの候補(違えば null)。base: 候補を出したときの入力、value: 今の入力 */
  function consume(base, ghost, value) {
    if (!value.startsWith(base)) {
      return null;
    }
    const typed = value.slice(base.length);
    return ghost.startsWith(typed) ? ghost.slice(typed.length) : null;
  }

  /** 残る(keep)・足す(add)・消える(del)の短い断片が細かく混ざらないよう、挟まれた短い共通部分はまとめて置き換え扱いにする */
  const MIN_KEEP = 3;

  /**
   * before(書きかけ)を after(置き換え案)にするときの差。文字単位の最長共通部分列から作り、
   * 変わる部分は「消える → 足す」の順に1か所へまとめる。戻りの text をつなぐと、keep+add は after、keep+del は before になる。
   * @returns {Array<{ text: string, kind: "keep" | "add" | "del" }>}
   */
  function diffSegments(before, after) {
    const a = Array.from(before);
    const b = Array.from(after);
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    /** @type {Array<{ text: string, kind: "keep" | "add" | "del" }>} */
    const runs = [];
    const push = (ch, kind) => {
      const last = runs[runs.length - 1];
      if (last && last.kind === kind) {
        last.text += ch;
      } else {
        runs.push({ text: ch, kind });
      }
    };
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        push(a[i], "keep");
        i++;
        j++;
      } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
        push(b[j], "add");
        j++;
      } else {
        push(a[i], "del");
        i++;
      }
    }
    // 変わる部分に挟まれた短い共通部分は、変わる部分に含める
    const marked = runs.map((r, k) => ({ ...r, change: r.kind !== "keep" || (k > 0 && k < runs.length - 1 && Array.from(r.text).length < MIN_KEEP) }));
    /** @type {Array<{ text: string, kind: "keep" | "add" | "del" }>} */
    const out = [];
    let k = 0;
    while (k < marked.length) {
      if (!marked[k].change) {
        out.push({ text: marked[k].text, kind: "keep" });
        k++;
        continue;
      }
      let del = "";
      let add = "";
      while (k < marked.length && marked[k].change) {
        const r = marked[k];
        if (r.kind === "keep") {
          del += r.text;
          add += r.text;
        } else if (r.kind === "del") {
          del += r.text;
        } else {
          add += r.text;
        }
        k++;
      }
      if (del) {
        out.push({ text: del, kind: "del" });
      }
      if (add) {
        out.push({ text: add, kind: "add" });
      }
    }
    return out;
  }

  const api = { consume, diffSegments };
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    /** @type {any} */ (root).QbsAssist = api;
  }
})(typeof self !== "undefined" ? self : this);
