// @ts-check
/*
 * 入力補助の、画面に依存しない処理(webview とユニットテストの両方で使う)。
 * - 候補(薄い文字)を打った文字で縮める・1語ずつ受け入れる
 * - カーソルの直前の名前を切り出す・名前の候補から続きを決める
 * - 書き直し案と書きかけの差を出す・決めることの答えを入れる
 */
(function (root) {
  "use strict";

  /** 空白を除いた文字数 */
  function meaningfulLength(text) {
    return String(text || "").replace(/\s+/g, "").length;
  }

  /**
   * 打った文字が候補の先頭と同じなら、残りの候補を返す(違えば null)。
   * base: 候補を出したときの入力、ghost: そのときの候補、value: 今の入力
   */
  function consume(base, ghost, value) {
    if (!value.startsWith(base)) {
      return null;
    }
    const typed = value.slice(base.length);
    return ghost.startsWith(typed) ? ghost.slice(typed.length) : null;
  }

  const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("ja", { granularity: "word" }) : null;

  /** 候補の先頭から1語分(前の空白・記号を含む。バッククォートで始まる名前は閉じるまで) */
  function nextSegment(ghost) {
    if (!ghost) {
      return "";
    }
    let out = "";
    if (segmenter) {
      for (const s of segmenter.segment(ghost)) {
        out += s.segment;
        if (s.isWordLike) {
          break;
        }
      }
    } else {
      const m = /^\s*\S+/.exec(ghost);
      out = m ? m[0] : ghost;
    }
    if ((out.match(/`/g) || []).length % 2 === 1) {
      const close = ghost.indexOf("`", out.length);
      if (close >= 0) {
        out = ghost.slice(0, close + 1);
      }
    }
    return out || ghost.slice(0, 1);
  }

  /**
   * カーソルの直前の名前(補完する部分)。英数字3文字以上で、名前の途中(直後が英数字)でないときだけ。
   * a.b の形は最後の部分を、/ を含むものはパス全体を補完する
   */
  function identifierBefore(text, caret) {
    if (/[\w$]/.test(text.charAt(caret))) {
      return undefined;
    }
    const before = text.slice(0, caret);
    const path = /[\w.$-]*\/[\w.$/-]*$/.exec(before);
    if (path && /^[A-Za-z_.]/.test(path[0])) {
      return path[0].length >= 3 ? { start: caret - path[0].length, prefix: path[0] } : undefined;
    }
    const m = /[A-Za-z_$][\w$]*$/.exec(before);
    if (!m || m[0].length < 3) {
      return undefined;
    }
    return { start: caret - m[0].length, prefix: m[0] };
  }

  /** 名前の共通の先頭 */
  function commonPrefix(names) {
    if (names.length === 0) {
      return "";
    }
    let p = names[0];
    for (const n of names.slice(1)) {
      let i = 0;
      while (i < p.length && i < n.length && p[i] === n[i]) {
        i++;
      }
      p = p.slice(0, i);
    }
    return p;
  }

  /**
   * 名前の候補から、薄く出す続き。大文字小文字まで前方一致するものだけを使い、
   * 1つに決まれば名前の残り全体、複数なら共通する先頭までにする(どの名前にするかは利用者が選ぶ)
   */
  function nameGhost(prefix, names) {
    const matches = names.filter((n) => n.startsWith(prefix) && n !== prefix);
    if (matches.length === 0) {
      return { text: "", count: 0 };
    }
    const common = matches.length === 1 ? matches[0] : commonPrefix(matches);
    return { text: common.slice(prefix.length), count: matches.length };
  }

  /** 書き直し案のうち、書きかけに無かった部分に印を付ける(文字単位の最長共通部分列) */
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
    const out = [];
    const push = (ch, added) => {
      const last = out[out.length - 1];
      if (last && last.added === added) {
        last.text += ch;
      } else {
        out.push({ text: ch, added });
      }
    };
    let i = 0;
    let j = 0;
    while (j < m) {
      if (i < n && a[i] === b[j]) {
        push(b[j], false);
        i++;
        j++;
      } else if (i < n && dp[i + 1][j] >= dp[i][j + 1]) {
        i++;
      } else {
        push(b[j], true);
        j++;
      }
    }
    return out;
  }

  const UNDECIDED = "(まだ決めていない)";

  /**
   * 決めることの答えを入れた依頼文。answers[i] は { text }(選んだ案・書いた文)か undefined。
   * keepSlots=true は画面の表示用(答えていない〔 〕を残す)。送る文では、答えていない〔 〕を
   * - 変更の依頼: 「…(まだ決めていない)」にして、調べたあとの要件の確認に任せる
   * - 読み解きの質問(intent="read"): 文から除く(読み解きには送ったあとの確認が無いので、流れ・呼び出し元を中心に調べる)
   */
  function composeInstruction(instruction, questions, answers, keepSlots, intent) {
    let out = instruction;
    questions.forEach((q, i) => {
      const a = answers[i];
      const value = a && a.text ? a.text.trim() : "";
      if (value) {
        out = out.split(q.slot).join(value);
      }
    });
    if (keepSlots) {
      return out;
    }
    const undecided = (text) => text.replace(/〔([^〔〕]+)〕/g, (_m, inner) => `${inner}${UNDECIDED}`);
    if (intent === "read") {
      // 括弧の補足に入った〔 〕だけを除く。文の中の〔 〕は除くと主語や目的語が抜けるので「まだ決めていない」にする
      const removed = undecided(out.replace(/[((][^()()〔〕]*〔[^〔〕]+〕[^()()〔〕]*[))]/g, ""))
        .replace(/[ \t]{2,}/g, " ")
        .replace(/[、,]\s*(?=[。?？!！]|$)/g, "")
        .trim();
      // 除くと文が残らない(何をしたいか自体が決まっていない)ときは、決まっていないと書いて送る
      return meaningfulLength(removed.replace(/[。?？!！、,()()]/g, "")) >= 4 ? removed : undecided(out);
    }
    return undecided(out);
  }

  const api = { meaningfulLength, consume, nextSegment, identifierBefore, nameGhost, diffSegments, composeInstruction, UNDECIDED };
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    /** @type {any} */ (root).QbsAssist = api;
  }
})(typeof self !== "undefined" ? self : this);
