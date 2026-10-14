// @ts-check
/* global acquireVsCodeApi */
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

  /** 表示用のテキストはすべて textContent / createTextNode で入れる(innerHTML は使わない)。 */
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key === "class") {
        node.className = value;
      } else if (key === "text") {
        node.textContent = value;
      } else if (key in node) {
        node[key] = value;
      } else {
        node.setAttribute(key, value);
      }
    }
    for (const child of children) {
      if (child) {
        node.append(child);
      }
    }
    return node;
  }

  const messages = $("messages");
  const live = el("div", { id: "live", class: "hidden" });
  messages.after(live);
  const queryInput = /** @type {HTMLInputElement} */ ($("query"));
  const sendBtn = /** @type {HTMLButtonElement} */ ($("btn-send"));
  const cancelBtn = $("btn-cancel");
  const modeSelect = /** @type {HTMLSelectElement} */ ($("mode"));

  let state = { hasKey: false, hasWorkspace: true, busy: false, index: null, learning: null };
  /** @type {Map<string, any>} */
  const quizzes = new Map();

  function scrollDown() {
    messages.scrollTop = messages.scrollHeight;
  }

  function addMessage(kind, text) {
    const node = el("div", { class: `message ${kind}`, text });
    messages.append(node);
    scrollDown();
    return node;
  }

  function setLive(text) {
    live.textContent = text ? `⏳ ${text}` : "";
    live.classList.toggle("hidden", !text);
  }

  // ---------- 状態表示 ----------

  const confirmApi = /** @type {HTMLInputElement} */ ($("confirm-api"));
  confirmApi.addEventListener("change", () => vscode.postMessage({ type: "setConfirmApi", value: confirmApi.checked }));

  function renderState() {
    const s = state;
    const ready = s.hasKey && s.hasWorkspace && !s.busy;
    confirmApi.checked = !!s.confirmApi;
    queryInput.disabled = !ready;
    sendBtn.disabled = !ready;
    modeSelect.disabled = !ready;
    cancelBtn.classList.toggle("hidden", !s.busy);
    queryInput.placeholder = !s.hasWorkspace
      ? "フォルダを開いてください"
      : !s.hasKey
        ? "「APIキー」を設定してください"
        : s.busy
          ? "処理中..."
          : "例: ログイン処理はどう動く? / ○○機能を追加したい";
    if (!s.busy) {
      setLive("");
    }
    const idx = s.index;
    $("index-status").textContent = idx
      ? `索引: ${idx.files}ファイル / ${idx.chunks}チャンク ・ ` +
        (idx.semantic ? `意味検索 ${Math.round(idx.coverage * 100)}%` : "キーワード検索のみ")
      : s.hasWorkspace
        ? "索引: 準備中..."
        : "";
    if (!$("log-box").classList.contains("hidden")) {
      renderLog();
    }
    renderLevel();
  }

  // ---------- 学習レベル ----------

  const levelSelect = /** @type {HTMLSelectElement} */ ($("level"));
  levelSelect.addEventListener("change", () => vscode.postMessage({ type: "setLevel", level: levelSelect.value }));

  function renderLevel() {
    const levels = state.levels || [];
    if (levelSelect.options.length !== levels.length) {
      levelSelect.replaceChildren(...levels.map((l) => el("option", { value: l.id, text: l.label, title: l.description })));
    }
    if (state.level) {
      levelSelect.value = state.level;
    }
    const current = levels.find((l) => l.id === state.level);
    levelSelect.title = current ? current.description : "";

    // 初回は、出題の前にレベルを選んでもらう
    const box = $("level-box");
    box.classList.toggle("hidden", !!state.levelChosen || levels.length === 0);
    if (state.levelChosen || box.childElementCount > 0) {
      return;
    }
    box.append(
      el("h4", { text: "はじめに: 学習レベルを選んでください" }),
      el("div", { class: "muted", text: "レベルに合わせて、問題の難しさ・用語の説明・解説の細かさを調整します。あとから上の「学習レベル」でいつでも変えられます。" }),
    );
    for (const l of levels) {
      const btn = el("button", { class: "level-choice" }, el("strong", { text: l.label }), el("span", { text: l.description }));
      btn.onclick = () => vscode.postMessage({ type: "setLevel", level: l.id });
      box.append(btn);
    }
  }

  function renderLog() {
    const box = $("log-box");
    box.replaceChildren();
    const l = state.learning;
    box.append(el("h4", { text: "学習記録(このワークスペース)" }));
    if (!l || l.blanks === 0) {
      box.append(el("div", { class: "muted", text: "まだ記録がありません。クイズに答えるとここに溜まります。" }));
    } else {
      box.append(el("div", { text: `解答 ${l.sessions}回 / 空欄 ${l.blanks}個 / 正答率 ${Math.round(l.accuracy * 100)}%` }));
      if (l.weak.length > 0) {
        box.append(el("div", { text: "苦手な概念(正答率の低い順)" }));
        for (const w of l.weak) {
          box.append(el("div", { class: "muted", text: `・${w.concept}: ${Math.round(w.accuracy * 100)}%(${w.attempts}問)` }));
        }
      }
    }
    const row = el("div", { class: "row" });
    const review = el("button", { text: `復習する(${l ? l.dueCount : 0}件)` });
    review.disabled = !l || l.dueCount === 0 || state.busy;
    review.onclick = () => {
      vscode.postMessage({ type: "startReview" });
      box.classList.add("hidden");
    };
    const reset = el("button", { class: "secondary", text: "記録を消す" });
    reset.onclick = () => vscode.postMessage({ type: "resetLog" });
    const close = el("button", { class: "secondary", text: "閉じる" });
    close.onclick = () => box.classList.add("hidden");
    row.append(review, reset, close);
    box.append(row);
  }

  function renderPlan(m) {
    const box = $("plan-box");
    box.replaceChildren();
    box.classList.remove("hidden");
    box.append(el("h4", { text: "インデックスの更新" }));
    const none = m.files === 0 && m.removed === 0;
    box.append(
      el("div", {
        text: none
          ? "変更はありません。"
          : `変更 ${m.files}ファイル(削除 ${m.removed}) / 新規チャンク ${m.chunks}` +
            (m.truncated ? "\n※ファイル数が上限を超えたため一部のみ対象です(設定 quizSupport.maxFiles)。" : ""),
      }),
    );
    box.append(
      el("div", {
        class: "muted",
        text:
          "キーワード検索のインデックスはAPIを使わず無料で作れます。意味検索を有効にすると、" +
          `未計算の ${m.pendingEmbeds} チャンク(約 ${m.tokens.toLocaleString()} トークン)の埋め込みをOpenAI APIで作成します。`,
      }),
    );
    const row = el("div", { class: "row" });
    const lexical = el("button", { class: "secondary", text: "キーワードのみ更新" });
    lexical.onclick = () => {
      vscode.postMessage({ type: "confirmIndex", embed: false });
      box.classList.add("hidden");
    };
    const embed = el("button", { text: m.semantic ? "意味検索も更新" : "意味検索を有効化して更新" });
    embed.disabled = !m.hasKey;
    embed.title = m.hasKey ? "" : "APIキーを設定してください";
    embed.onclick = () => {
      vscode.postMessage({ type: "confirmIndex", embed: true });
      box.classList.add("hidden");
    };
    const clear = el("button", { class: "secondary", text: "索引を削除" });
    clear.onclick = () => {
      vscode.postMessage({ type: "clearIndex" });
      box.classList.add("hidden");
    };
    const close = el("button", { class: "secondary", text: "閉じる" });
    close.onclick = () => box.classList.add("hidden");
    row.append(lexical, embed, clear, close);
    box.append(row);
  }

  // ---------- クイズ ----------

  /** ワークスペース内の場所を開くリンク(text を渡すと、開くときにその内容の行を探し直す) */
  function codeLink(path, line, label, text) {
    const link = el("a", { class: "file-link", href: "#", text: label || `${path}:${line}` });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      vscode.postMessage({ type: "open", path, line, text });
    });
    return link;
  }

  /** 折りたたみ(見出しをクリックで開く) */
  function details(summary, children, open = false) {
    const box = el("details", { class: "fold-box" }, el("summary", { text: summary }));
    box.open = open;
    for (const c of children) {
      box.append(c);
    }
    return box;
  }

  /** "+ " / "- " / "  " 始まりの行を色分けして表示する */
  function diffBlock(text) {
    const pre = el("pre", { class: "code" });
    for (const line of text.split("\n")) {
      const cls = line.startsWith("+ ") ? "add" : line.startsWith("- ") ? "del" : line.startsWith("…") ? "skip" : "";
      pre.append(el("div", { class: `code-line ${cls}`, text: line || " " }));
    }
    return pre;
  }

  /** 参考コード・手がかり(場所 + なぜ見るか) */
  function refLine(prefix, ref) {
    return el(
      "div",
      { class: "ref" },
      document.createTextNode(prefix),
      codeLink(ref.path, ref.line),
      ref.note ? document.createTextNode(` — ${ref.note}`) : null,
    );
  }

  /**
   * 穴埋め問題1件(コード・空欄・選択肢・段階ヒント)。クイズと実装の手順で共通。
   * locked() が true の間は選択を変えられない(採点後)。
   */
  function renderItem(item, locked, options = {}) {
    const block = el("div", { class: "quiz-item" });
    const link = codeLink(item.path, item.startLine, `${item.path}:${item.startLine}-${item.endLine}`);
    if (!options.noHead) {
      block.append(
        el("div", { class: "quiz-head" }, link, el("span", { class: "badge", text: item.kind === "change" ? "実装" : "読解" })),
      );
    }
    if (item.task) {
      block.append(el("div", { class: "task", text: `${item.kind === "change" ? "課題" : "読みどころ"}: ${item.task}` }));
    }
    if (item.newNames && item.newNames.length > 0) {
      const names = el("div", { class: "names" }, el("div", { class: "muted", text: "この問題で新しく作る名前" }));
      for (const n of item.newNames) {
        names.append(el("div", {}, el("code", { text: n.name }), n.role ? document.createTextNode(` — ${n.role}`) : null));
      }
      block.append(names);
    }
    if (item.refs && item.refs.length > 0) {
      const refs = el("div", { class: "refs" }, el("div", { class: "muted", text: "参考にするコード" }));
      item.refs.forEach((r) => refs.append(refLine("・", r)));
      block.append(refs);
    }

    /** コード中の空欄(選んだ選択肢がここにはまる) */
    const slots = [];
    const pre = el("pre", { class: "code" });
    // 折りたたむ行 → その範囲の [開始, 終了]
    const foldAt = new Map((item.folds || []).map((f) => [f[0], f]));
    /** @type {HTMLElement[]} */
    let foldedRows = [];
    item.code.split("\n").forEach((line, lineIndex) => {
      const fold = foldAt.get(lineIndex);
      if (fold) {
        const count = fold[1] - fold[0] + 1;
        const rows = [];
        foldedRows = rows;
        const toggle = el("div", { class: "code-fold", text: `⋯ ${count}行省略(クリックで表示)`, title: "空欄と直接関係しない行" });
        toggle.addEventListener("click", () => {
          rows.forEach((r) => r.classList.remove("hidden"));
          toggle.remove();
        });
        pre.append(toggle);
      }
      const row = el("div", { class: "code-line" });
      if ((item.folds || []).some((f) => lineIndex >= f[0] && lineIndex <= f[1])) {
        row.classList.add("hidden");
        foldedRows.push(row);
      }
      const parts = line.split("___BLANK___");
      parts.forEach((part, i) => {
        if (part) {
          row.append(document.createTextNode(part));
        }
        if (i < parts.length - 1) {
          const n = slots.length + 1;
          const slot = el("span", { class: "slot", text: `［ ${n} ］`, title: `空欄${n}: 下の選択肢から選んでください`, tabIndex: 0 });
          slots.push(slot);
          row.append(slot);
        }
      });
      if (!line) {
        row.append(document.createTextNode(" "));
      }
      pre.append(row);
    });
    block.append(pre);

    const levels = item.blanks.map(() => 0);
    const picked = item.blanks.map(() => -1);
    const groups = [];
    item.blanks.forEach((blank, k) => {
      const slot = slots[k];
      const buttons = blank.options.map((code, o) => {
        const b = el("button", { class: "choice", title: "この選択肢を空欄に入れる" }, el("code", { text: code }));
        b.onclick = () => {
          if (locked() || b.disabled) {
            return;
          }
          picked[k] = o;
          buttons.forEach((x, i) => x.classList.toggle("selected", i === o));
          // 選んだコードを空欄にはめて、前後とつながるかを見ながら考えられるようにする
          slot.textContent = code;
          slot.classList.add("filled");
        };
        return b;
      });
      const notes = blank.options.map(() => el("div", { class: "choice-note hidden" }));

      // ヒントの段階: 概念 → 考え方 → 手がかりの場所(あれば) → 誤りの選択肢を1つ消す(あれば)
      const steps = blank.hints.filter((h) => h && h.trim()).map((h) => () => document.createTextNode(h));
      if (blank.clue) {
        steps.push(() => refLine("この場所を読んでみよう: ", blank.clue));
      }
      if (blank.eliminate) {
        steps.push(() => {
          const e = blank.eliminate;
          const b = buttons[e.index];
          b.disabled = true;
          b.classList.add("eliminated");
          if (picked[k] === e.index) {
            picked[k] = -1;
            b.classList.remove("selected");
            slot.textContent = `［ ${k + 1} ］`;
            slot.classList.remove("filled");
          }
          return document.createTextNode(`選択肢「${blank.options[e.index]}」は誤りです。${e.note ? `理由: ${e.note}` : ""}`);
        });
      }
      const text = el("div", { class: "hint-text" });
      const hintBtn = el("button", { class: "link", text: steps.length ? "ヒント" : "ヒントなし" });
      hintBtn.disabled = steps.length === 0;
      hintBtn.onclick = () => {
        if (levels[k] < steps.length) {
          const step = steps[levels[k]];
          levels[k]++;
          text.append(el("div", {}, document.createTextNode(`ヒント${levels[k]}: `), step()));
          hintBtn.textContent = levels[k] < steps.length ? `次のヒント(${levels[k]}/${steps.length})` : "ヒントは以上";
          hintBtn.disabled = levels[k] >= steps.length;
        }
      };
      const list = el("div", { class: "choices" });
      buttons.forEach((b, o) => list.append(el("div", { class: "choice-row" }, b, notes[o])));
      const result = el("div", { class: "result" });
      const group = el(
        "div",
        { class: "hint-row" },
        el("div", { class: "hint-head" }, el("span", { class: "hint-label", text: `空欄${k + 1}` }), el("span", { class: "concept", text: blank.concept }), hintBtn),
        list,
        text,
        result,
      );
      slot.addEventListener("click", () => group.scrollIntoView({ behavior: "smooth", block: "nearest" }));
      groups.push({ buttons, notes, result, slot });
      block.append(group);
    });
    const after = el("div", { class: "after" });
    block.append(after);
    return { block, state: { picked, levels, groups, after, kind: item.kind, index: item.index } };
  }

  /** 採点結果を空欄・選択肢に書き込む */
  function markItemGrades(it, grades) {
    grades.forEach((g, k) => {
      const group = it.groups[k];
      if (!group) {
        return;
      }
      group.buttons.forEach((b) => (b.disabled = true));
      group.slot.classList.add(g.correct ? "correct" : "incorrect");
      if (!group.slot.classList.contains("filled")) {
        group.slot.textContent = "(未選択)";
      }
      group.buttons.forEach((b, o) => {
        if (o === g.correctIndex) {
          b.classList.add("right");
        } else if (o === g.chosen) {
          b.classList.add("wrong");
        }
        // 選んだ誤答には「なぜ違うか」を出す(他の誤答の解説は情報が多くなりすぎるので出さない)
        if (o === g.chosen && o !== g.correctIndex && g.notes[o]) {
          group.notes[o].textContent = `なぜ違う: ${g.notes[o]}`;
          group.notes[o].classList.remove("hidden");
        }
      });
      const out = group.result;
      out.replaceChildren();
      out.className = `result ${g.correct ? "ok" : "ng"}`;
      out.append(document.createTextNode(g.correct ? "○ 正解" : g.note === "未選択" ? "× 未選択" : "× 不正解"));
      if (!g.correct) {
        out.append(document.createTextNode("  正解: "), el("code", { text: g.expected }));
      }
      if (g.why) {
        out.append(el("div", { class: "why-blank", text: `なぜ: ${g.why}` }));
      }
    });
  }

  function renderQuiz(q) {
    const root = el("div", { class: "message bot quiz" });
    root.append(el("div", { class: "quiz-title", text: q.review ? "復習" : "クイズ" }));
    if (q.goal) {
      root.append(el("p", { class: "goal", text: q.goal }));
    }
    const entry = { id: q.id, root, items: [], questions: [], prediction: null, graded: false, gradeBtn: null };

    if (!q.review) {
      // 予想メモは任意。入力の負担を増やさないよう、開いたときだけ表示する
      const prediction = el("textarea", { class: "prediction hidden", rows: 2, placeholder: "このコードは何をしていそう?(自分の言葉で一言)" });
      const toggle = el("button", { class: "link", text: "先に予想をメモする(任意)" });
      toggle.onclick = () => {
        prediction.classList.remove("hidden");
        toggle.remove();
        prediction.focus();
      };
      entry.prediction = prediction;
      root.append(toggle, prediction);
    }

    for (const item of q.items) {
      const { block, state } = renderItem(item, () => entry.graded);
      entry.items.push(state);
      root.append(block);
    }

    for (const question of q.questions) {
      const set = el("fieldset", { class: "mcq" }, el("legend", { text: `構造クイズ ${question.index + 1}` }), el("div", { text: question.prompt }));
      const name = `q-${q.id}-${question.index}`;
      const labels = question.options.map((option, i) => {
        const input = el("input", { type: question.multi ? "checkbox" : "radio", name, value: String(i) });
        const label = el("label", {}, input, document.createTextNode(option));
        set.append(label);
        return { input, label };
      });
      const why = el("div", { class: "why" });
      set.append(why);
      entry.questions.push({ labels, why });
      root.append(set);
    }

    const gradeBtn = el("button", { text: "採点する" });
    const unanswered = el("span", { class: "muted" });
    gradeBtn.onclick = () => {
      const left = entry.items.reduce((n, it) => n + it.picked.filter((p) => p < 0).length, 0);
      if (left > 0 && !unanswered.textContent) {
        // 1回目は知らせるだけ。もう一度押せば未選択のまま採点する
        unanswered.textContent = `  未選択の空欄が${left}個あります(このまま採点するにはもう一度押してください)`;
        return;
      }
      entry.graded = true;
      gradeBtn.disabled = true;
      gradeBtn.textContent = "採点中...";
      unanswered.textContent = "";
      for (const it of entry.items) {
        it.groups.forEach((g) => g.buttons.forEach((b) => (b.disabled = true)));
      }
      for (const qu of entry.questions) {
        qu.labels.forEach((l) => (l.input.disabled = true));
      }
      vscode.postMessage({
        type: "grade",
        quizId: q.id,
        blanks: entry.items.map((it) => it.picked),
        hints: entry.items.map((it) => it.levels),
        choices: entry.questions.map((qu) => qu.labels.flatMap((l, i) => (l.input.checked ? [i] : []))),
      });
    };
    entry.gradeBtn = gradeBtn;
    root.append(el("div", {}, gradeBtn, unanswered));
    quizzes.set(q.id, entry);
    messages.append(root);
    scrollDown();
  }

  function onGraded(m) {
    const entry = quizzes.get(m.quizId);
    if (!entry) {
      return;
    }
    m.items.forEach((res, i) => {
      const it = entry.items[i];
      markItemGrades(it, res.grades);
      if (res.explanation) {
        it.after.append(el("div", { class: "explain", text: res.explanation }));
      }
      if (res.completed) {
        it.after.append(
          el("div", { class: "muted", text: "変更点(- 削除 / + 追加。変更のない行は省略)" }),
          diffBlock(res.completed),
        );
      }
      if (res.canApply) {
        const apply = el("button", { class: "secondary", text: "正解コードをファイルに反映(確認あり)" });
        apply.onclick = () => vscode.postMessage({ type: "apply", quizId: m.quizId, itemIndex: i });
        it.after.append(apply);
      }
    });

    m.questions.forEach((res, i) => {
      const qu = entry.questions[i];
      qu.labels.forEach(({ label }, idx) => {
        if (res.correctIndexes.includes(idx)) {
          label.classList.add("right");
        } else if (res.chosen.includes(idx)) {
          label.classList.add("wrong");
        }
      });
      qu.why.textContent = `${res.correct ? "○ 正解" : "× 不正解"}  ${res.explanation}`;
    });

    entry.gradeBtn.textContent = "採点済み";
    const tail = el("div", { class: "explain" });
    tail.append(el("div", { class: "score", text: `結果: ${m.score.total}問中 ${m.score.correct}問正解` }));
    const mine = entry.prediction && entry.prediction.value.trim();
    if (mine) {
      tail.append(el("div", { text: `\nあなたの予想:\n${mine}` }));
    }
    if (m.overall) {
      tail.append(el("div", { text: `\n全体の解説:\n${m.overall}` }));
    }
    entry.root.append(tail);
    scrollDown();
  }

  // ---------- 要件の確認 ----------

  /** 回答待ちの確認カード(新しい質問をしたら無効にする) */
  let openClarify = null;

  function closeClarify(note) {
    if (!openClarify) {
      return;
    }
    openClarify.disable(note);
    openClarify = null;
  }

  /** 大きな変更・複数案がある実装依頼で、出題の前に要件を選んでもらうカード */
  function renderClarify(id, c) {
    closeClarify("(新しい確認が届いたため無効になりました)");
    const root = el("div", { class: "message bot clarify" });
    root.append(el("div", { class: "quiz-title", text: "実装の前に確認させてください" }));
    if (c.understanding) {
      root.append(el("p", { class: "goal", text: `依頼の理解: ${c.understanding}` }));
    }
    const scale = c.estimatedFiles || c.estimatedLines ? `(見込み: 約${c.estimatedFiles}ファイル・約${c.estimatedLines}行の変更)` : "";
    if (c.reason || scale) {
      root.append(el("div", { class: "muted", text: `${c.reason}${scale}` }));
    }

    const inputs = c.questions.map((q, qi) => {
      const set = el("fieldset", { class: "mcq clarify-q" }, el("legend", { text: `質問${qi + 1}` }), el("div", { class: "clarify-question", text: q.question }));
      if (q.why) {
        set.append(el("div", { class: "muted", text: q.why }));
      }
      const name = `clarify-${id}-${qi}`;
      const radios = q.options.map((o, oi) => {
        const input = el("input", { type: "radio", name, value: String(oi) });
        const body = el("span", { class: "clarify-option" }, el("strong", { text: o.label }), o.recommended ? el("span", { class: "badge", text: "おすすめ" }) : null);
        if (o.detail) {
          body.append(el("span", { class: "muted", text: o.detail }));
        }
        set.append(el("label", {}, input, body));
        return input;
      });
      const note = el("input", { type: "text", class: "clarify-note", placeholder: "補足・その他の案(任意)" });
      set.append(note);
      root.append(set);
      return { radios, note };
    });

    const submit = el("button", { text: "この内容で出題する" });
    const skip = el("button", { class: "secondary", text: "確認せずに進める", title: "出題側の判断で、依頼のまま実装問題を作ります" });
    const footer = el("div", { class: "muted" });
    const disable = (note) => {
      inputs.forEach((q) => {
        q.radios.forEach((r) => (r.disabled = true));
        q.note.disabled = true;
      });
      submit.disabled = true;
      skip.disabled = true;
      footer.textContent = note;
    };
    const answer = (skipped) => {
      if (state.busy) {
        footer.textContent = "前の処理が終わってから押してください";
        return;
      }
      const answers = inputs.map((q) => {
        const option = q.radios.findIndex((r) => r.checked);
        return { option: option >= 0 ? option : undefined, text: q.note.value.trim() };
      });
      if (!skipped && answers.every((a) => a.option === undefined && !a.text)) {
        footer.textContent = "どれかの質問に答えてください(答えずに進めるなら「確認せずに進める」)";
        return;
      }
      openClarify = null;
      disable(skipped ? "確認せずに進めました" : "回答しました");
      const summary = skipped
        ? "確認せずに進める"
        : c.questions
            .map((q, qi) => {
              const a = answers[qi];
              const picked = a.option !== undefined ? q.options[a.option].label : "";
              const text = [picked, a.text].filter(Boolean).join(" / ");
              return text ? `${q.question} → ${text}` : "";
            })
            .filter(Boolean)
            .join("\n");
      addMessage("user", summary);
      vscode.postMessage({ type: "clarifyAnswer", id, answers, skip: skipped });
    };
    submit.onclick = () => answer(false);
    skip.onclick = () => answer(true);
    root.append(el("div", { class: "row" }, submit, skip), footer);
    openClarify = { disable };
    messages.append(root);
    scrollDown();
  }

  // ---------- 実装の手順 ----------

  /** @type {Map<string, any>} */
  const lessons = new Map();

  /**
   * 実装の手順: 地図(サブゴールの一覧)を先に見せ、1ステップずつ
   * 「なぜここを変えるか → 穴埋め → 次に確認すべき場所の予想 → 答え合わせ(見つけ方と判断)」の順に進める。
   */
  function renderLesson(l) {
    const root = el("div", { class: "message bot lesson" });
    root.append(el("div", { class: "quiz-title", text: "実装の手順" }));
    if (l.goal) {
      root.append(el("p", { class: "goal", text: l.goal }));
    }
    if (l.criteria && l.criteria.length > 0) {
      const list = el("ol", { class: "criteria" });
      l.criteria.forEach((c) => list.append(el("li", { text: c })));
      root.append(el("div", { class: "muted", text: "受け入れ条件(実装できたかを確かめる基準)" }), list);
    }
    const map = el("ol", { class: "step-map" });
    const mapItems = l.steps.map((s) => {
      const li = el("li", { class: "todo", text: s.label });
      map.append(li);
      return li;
    });
    root.append(el("div", { class: "muted", text: `手順の地図(全${l.steps.length}ステップ・依存される側から順に)` }), map);
    const body = el("div", { class: "lesson-steps" });
    root.append(body);
    const entry = { id: l.id, root, body, mapItems, steps: new Map(), final: null };
    lessons.set(l.id, entry);
    messages.append(root);
    renderLessonStep(entry, l.step);
  }

  function renderLessonStep(entry, s) {
    entry.mapItems.forEach((li, i) => (li.className = i < s.index ? "done" : i === s.index ? "current" : "todo"));
    const block = el("div", { class: "lesson-step" });
    block.append(
      el(
        "div",
        { class: "step-head" },
        el("span", { class: "step-no", text: `ステップ ${s.number}/${s.total}` }),
        el("strong", { text: s.label }),
        el("span", { class: "badge", text: s.kind }),
        s.mechanical ? el("span", { class: "badge quiet", text: "考えどころの少ない変更" }) : null,
      ),
    );
    const files = el("div", { class: "refs" });
    for (const f of s.files) {
      files.append(
        el(
          "div",
          {},
          document.createTextNode("変更する場所: "),
          f.created ? el("span", { class: "file-link", text: `${f.path}(新規作成)` }) : codeLink(f.path, f.line, `${f.path}:${f.line}`, f.text),
        ),
      );
    }
    block.append(files);
    if (s.why) {
      block.append(el("div", { class: "task why-box", text: `なぜ: ${s.why}` }));
    }
    if (s.contract) {
      block.append(el("div", { class: "contract", text: `約束の変化: ${s.contract}` }));
    }
    const state = { answered: false, item: null, q: null, reveal: null, btn: null };
    if (s.item) {
      const { block: itemBlock, state: itemState } = renderItem(s.item, () => state.answered, { noHead: true });
      state.item = itemState;
      block.append(itemBlock);
    }
    if (s.diffs && s.diffs.length > 0) {
      const label = s.item ? "このステップのほかの変更" : "このステップの変更";
      block.append(
        details(
          `${label}(${s.diffs.length}件)`,
          s.diffs.flatMap((d) => [el("div", { class: "muted", text: `${d.path}${d.created ? "(新規)" : ""}` }), diffBlock(d.diff)]),
          !s.item,
        ),
      );
    }
    if (s.question) {
      const set = el(
        "fieldset",
        { class: "mcq next-check" },
        el("legend", { text: "予想: 次に確認すべき場所" }),
        el("div", { text: s.question.prompt }),
      );
      const name = `next-${entry.id}-${s.index}`;
      const labels = s.question.options.map((option, i) => {
        const input = el("input", { type: s.question.multi ? "checkbox" : "radio", name, value: String(i) });
        const label = el("label", {}, input, document.createTextNode(option));
        set.append(label);
        return { input, label };
      });
      if (s.question.hint) {
        const hint = el("div", { class: "hint-text hidden", text: `探し方のヒント\n${s.question.hint}` });
        const hintBtn = el("button", { class: "link", text: "探し方のヒント" });
        hintBtn.onclick = () => {
          hint.classList.remove("hidden");
          hintBtn.remove();
        };
        set.append(hintBtn, hint);
      }
      const why = el("div", { class: "why" });
      set.append(why);
      state.q = { labels, why };
      block.append(set);
    }
    state.reveal = el("div", { class: "after" });
    block.append(state.reveal);
    const last = s.index + 1 >= s.total;
    const nothingToAnswer = !s.item && !s.question;
    const btn = el("button", {
      text: nothingToAnswer ? (last ? "確認してまとめへ" : "確認して次へ") : last ? "答え合わせ" : "答え合わせして次へ",
    });
    const warn = el("span", { class: "muted" });
    btn.onclick = () => {
      if (state.answered) {
        return;
      }
      const left = state.item ? state.item.picked.filter((p) => p < 0).length : 0;
      const noChoice = state.q && !state.q.labels.some((l) => l.input.checked);
      if ((left > 0 || noChoice) && !warn.textContent) {
        // 1回目は知らせるだけ。もう一度押せば未回答のまま答え合わせする
        warn.textContent = "  未回答があります(このまま答え合わせするにはもう一度押してください)";
        return;
      }
      state.answered = true;
      btn.disabled = true;
      btn.textContent = "答え合わせ中...";
      warn.textContent = "";
      if (state.q) {
        state.q.labels.forEach((l) => (l.input.disabled = true));
      }
      vscode.postMessage({
        type: "lessonAnswer",
        lessonId: entry.id,
        index: s.index,
        blanks: state.item ? state.item.picked : [],
        hints: state.item ? state.item.levels : [],
        choices: state.q ? state.q.labels.flatMap((l, i) => (l.input.checked ? [i] : [])) : [],
      });
    };
    state.btn = btn;
    block.append(el("div", {}, btn, warn));
    entry.steps.set(s.index, state);
    entry.body.append(block);
    block.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /** 確認した場所1件(変更した/不要/要対応) */
  function resultLine(prefix, r) {
    return el(
      "div",
      { class: "result-line" },
      document.createTextNode(`${prefix} `),
      codeLink(r.path, r.line, r.label, r.text),
      document.createTextNode(`${r.step ? `(→ ステップ${r.step})` : ""}: ${r.reason}`),
    );
  }

  /** 答え合わせの後: 変更の全体・確認が必要になった場所(見つけ方と判断) */
  function renderReveal(box, rv) {
    box.replaceChildren();
    if (rv.explanation) {
      box.append(el("div", { class: "explain", text: rv.explanation }));
    }
    if (rv.diffs.length > 0) {
      box.append(
        details(
          "このステップの変更(- 削除 / + 追加)",
          rv.diffs.flatMap((d) => [el("div", { class: "muted", text: `${d.path}${d.created ? "(新規)" : ""}` }), diffBlock(d.diff)]),
        ),
      );
    }
    if (rv.checks.length === 0) {
      box.append(el("div", { class: "muted", text: "この変更で、ほかに確認が必要になった場所はありませんでした。" }));
      return;
    }
    box.append(el("div", { class: "checks-title", text: "この変更で確認が必要になった場所(見つけ方と判断)" }));
    for (const c of rv.checks) {
      const card = el("div", { class: "check" });
      card.append(el("div", {}, el("span", { class: "badge", text: c.pattern }), document.createTextNode(` きっかけ: ${c.trigger}`)));
      card.append(el("div", { class: "muted", text: `探し方: ${c.query}` }));
      card.append(el("div", { class: "muted", text: `判断基準: ${c.criterion}` }));
      const changed = c.results.filter((r) => r.changed);
      const action = c.results.filter((r) => r.needsAction);
      const kept = c.results.filter((r) => !r.changed && !r.needsAction);
      changed.forEach((r) => card.append(resultLine(r.auto ? "✓ 変更済み" : "✏ 変更", r)));
      action.forEach((r) => card.append(resultLine("⚠ 要対応", r)));
      if (kept.length > 0) {
        // 「変えなかった理由」は判断の手本になるが、量が多いので折りたたむ
        card.append(details(`変更不要と判断した場所(${kept.length})`, kept.map((r) => resultLine("– 変更不要", r))));
      }
      (c.pending || []).forEach((p) => card.append(resultLine("⚠ 判断できなかった", { ...p, reason: c.error || "自動では判断できませんでした" })));
      if (c.more > 0) {
        card.append(el("div", { class: "muted", text: `ほかに ${c.more} か所(表示を省略)` }));
      }
      box.append(card);
    }
  }

  function onLessonStep(m) {
    const entry = lessons.get(m.lessonId);
    const state = entry && entry.steps.get(m.index);
    if (!state) {
      return;
    }
    const r = m.result;
    if (state.item && r.grades) {
      markItemGrades(state.item, r.grades);
    }
    if (state.q && r.question) {
      state.q.labels.forEach(({ label }, idx) => {
        if (r.question.correctIndexes.includes(idx)) {
          label.classList.add("right");
        } else if (r.question.chosen.includes(idx)) {
          label.classList.add("wrong");
        }
      });
      state.q.why.textContent = r.question.correct ? "○ 正解" : "× 不正解(下の「確認が必要になった場所」で、見つけ方と判断を確かめましょう)";
    }
    renderReveal(state.reveal, r.reveal);
    state.btn.textContent = "答え合わせ済み";
    if (m.next) {
      renderLessonStep(entry, m.next);
    } else {
      entry.mapItems.forEach((li) => (li.className = "done"));
    }
    if (m.final) {
      renderLessonFinal(entry, m.final);
    }
  }

  function renderLessonFinal(entry, f) {
    const box = el("div", { class: "lesson-final explain" });
    box.append(el("div", { class: "score", text: `結果: ${f.score.total}問中 ${f.score.correct}問正解` }));
    if (f.overall) {
      box.append(el("div", { class: "overall", text: f.overall }));
    }
    const files = el("div", { class: "refs" }, el("div", { class: "muted", text: "反映するファイル" }));
    f.files.forEach((x) => files.append(el("div", { text: `・${x.path}(+${x.added} / -${x.removed})${x.created ? " 新規作成" : ""}` })));
    box.append(files);
    if (f.typecheck.available) {
      if (f.typecheck.remaining.length > 0) {
        box.append(el("div", { class: "warn", text: `⚠ 解消できなかった型エラー(${f.typecheck.remaining.length}件)\n${f.typecheck.remaining.join("\n")}` }));
      } else {
        box.append(el("div", { class: "ok-line", text: "✓ 型検査: 変更による新しいエラーはありません" }));
      }
    } else if (f.typecheck.note) {
      box.append(el("div", { class: "muted", text: f.typecheck.note }));
    }
    if (f.unresolved.length > 0) {
      box.append(el("div", { class: "warn", text: `⚠ 手で確認が必要なこと\n${f.unresolved.map((u) => `・${u}`).join("\n")}` }));
    }
    if (f.warnings.length > 0) {
      box.append(details(`計画を作るときの注意(${f.warnings.length})`, f.warnings.map((w) => el("div", { class: "muted", text: `・${w}` }))));
    }
    const apply = el("button", { text: "すべての変更をファイルに反映(確認あり)" });
    const revert = el("button", { class: "secondary hidden", text: "反映を取り消す" });
    const test = el("button", { class: "secondary hidden", text: `テストを実行(${f.testCommand || ""})` });
    const testBox = el("div", { class: "test-box" });
    apply.onclick = () => vscode.postMessage({ type: "lessonApply", lessonId: entry.id });
    revert.onclick = () => vscode.postMessage({ type: "lessonRevert", lessonId: entry.id });
    test.onclick = () => {
      testBox.replaceChildren(el("div", { class: "muted", text: "テストを実行しています..." }));
      vscode.postMessage({ type: "lessonTest", lessonId: entry.id });
    };
    box.append(el("div", { class: "row" }, apply, revert, test), testBox);
    entry.final = { apply, revert, test, testBox, canTest: !!f.canTest };
    entry.root.append(box);
    scrollDown();
  }

  function onLessonApplied(m) {
    const f = lessons.get(m.lessonId)?.final;
    if (!f) {
      return;
    }
    f.apply.disabled = true;
    f.apply.textContent = "反映済み(未保存)";
    f.revert.classList.remove("hidden");
    f.test.classList.toggle("hidden", !m.canTest);
  }

  function onLessonReverted(m) {
    const f = lessons.get(m.lessonId)?.final;
    if (!f) {
      return;
    }
    f.apply.disabled = false;
    f.apply.textContent = "すべての変更をファイルに反映(確認あり)";
    f.revert.classList.add("hidden");
    f.test.classList.add("hidden");
    f.testBox.replaceChildren();
  }

  function onLessonTest(m) {
    const f = lessons.get(m.lessonId)?.final;
    if (!f) {
      return;
    }
    f.testBox.replaceChildren(
      el("div", { class: m.ok ? "ok-line" : "warn", text: m.ok ? `✓ テストが通りました(${m.command})` : `× テストが失敗しました(${m.command}・終了コード ${m.code ?? "?"})` }),
      el("pre", { class: "code test-output", text: m.output || "(出力なし)" }),
    );
    if (!m.ok) {
      // 失敗の内容を依頼文の下書きにする(送るかどうかは利用者が決める)
      const line = (m.output || "").split("\n").find((l) => /error|fail|✘|not ok|expected/i.test(l)) || "";
      const fix = el("button", { class: "secondary", text: "失敗の内容で修正を依頼する(入力欄に下書き)" });
      fix.onclick = () => {
        queryInput.value = `テスト(${m.command})が失敗したので直したい: ${line.trim().slice(0, 200)}`;
        queryInput.focus();
      };
      f.testBox.append(fix);
    }
  }

  // ---------- 入出力 ----------

  function send() {
    const text = queryInput.value.trim();
    if (!text || queryInput.disabled) {
      return;
    }
    closeClarify("(新しい質問をしたため無効になりました)");
    addMessage("user", text);
    queryInput.value = "";
    vscode.postMessage({ type: "ask", query: text, mode: modeSelect.value });
  }

  sendBtn.addEventListener("click", send);
  queryInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  cancelBtn.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
  $("btn-key").addEventListener("click", () => vscode.postMessage({ type: "setApiKey" }));
  $("btn-index").addEventListener("click", () => vscode.postMessage({ type: "planIndex" }));
  $("btn-log").addEventListener("click", () => {
    const box = $("log-box");
    box.classList.toggle("hidden");
    if (!box.classList.contains("hidden")) {
      renderLog();
    }
  });

  window.addEventListener("message", (event) => {
    const m = event.data;
    switch (m.type) {
      case "state":
        state = m;
        renderState();
        break;
      case "status":
        if (m.live) {
          setLive(m.text);
        } else {
          addMessage("status", m.text);
        }
        break;
      case "error":
        setLive("");
        addMessage("error", m.text);
        break;
      case "quiz":
        setLive("");
        renderQuiz(m.quiz);
        break;
      case "graded":
        setLive("");
        onGraded(m);
        break;
      case "clarify":
        setLive("");
        renderClarify(m.id, m.clarification);
        break;
      case "lesson":
        setLive("");
        renderLesson(m.lesson);
        break;
      case "lessonStep":
        onLessonStep(m);
        break;
      case "lessonApplied":
        onLessonApplied(m);
        break;
      case "lessonReverted":
        onLessonReverted(m);
        break;
      case "lessonTest":
        setLive("");
        onLessonTest(m);
        break;
      case "plan":
        setLive("");
        renderPlan(m);
        break;
      case "showLog":
        $("log-box").classList.remove("hidden");
        renderLog();
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
