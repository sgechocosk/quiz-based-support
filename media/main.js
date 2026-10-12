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

  function renderState() {
    const s = state;
    const ready = s.hasKey && s.hasWorkspace && !s.busy;
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

  /** ワークスペース内の場所を開くリンク */
  function codeLink(path, line, label) {
    const link = el("a", { class: "file-link", href: "#", text: label || `${path}:${line}` });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      vscode.postMessage({ type: "open", path, line });
    });
    return link;
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

  function renderQuiz(q) {
    const root = el("div", { class: "message bot quiz" });
    root.append(el("div", { class: "quiz-title", text: q.review ? "復習" : "クイズ" }));
    if (q.goal) {
      root.append(el("p", { class: "goal", text: q.goal }));
    }
    const entry = { id: q.id, root, items: [], questions: [], prediction: null, graded: false, gradeBtn: null };

    if (!q.review) {
      const prediction = el("textarea", {
        class: "prediction",
        rows: 2,
        placeholder: "先に予想: このコードは何をしていそう?(任意。自分の言葉で書くと理解が定着しやすい)",
      });
      entry.prediction = prediction;
      root.append(prediction);
    }

    for (const item of q.items) {
      const block = el("div", { class: "quiz-item" });
      const link = codeLink(item.path, item.startLine, `${item.path}:${item.startLine}-${item.endLine}`);
      block.append(
        el("div", { class: "quiz-head" }, link, el("span", { class: "badge", text: item.kind === "change" ? "実装" : "読解" })),
      );
      if (item.task) {
        block.append(el("div", { class: "task", text: `${item.kind === "change" ? "課題" : "読みどころ"}: ${item.task}` }));
      }
      if (item.refs && item.refs.length > 0) {
        const refs = el("div", { class: "refs" }, el("div", { class: "muted", text: "参考にするコード" }));
        item.refs.forEach((r) => refs.append(refLine("・", r)));
        block.append(refs);
      }

      const inputs = [];
      const pre = el("pre", { class: "code" });
      for (const line of item.code.split("\n")) {
        const row = el("div", { class: "code-line" });
        const parts = line.split("___BLANK___");
        parts.forEach((part, i) => {
          if (part) {
            row.append(document.createTextNode(part));
          }
          if (i < parts.length - 1) {
            const input = el("input", { type: "text", class: "blank", placeholder: String(inputs.length + 1), spellcheck: false });
            input.addEventListener("input", () => {
              input.style.width = Math.max(8, input.value.length + 2) + "ch";
            });
            inputs.push(input);
            row.append(input);
          }
        });
        if (!line) {
          row.append(document.createTextNode(" "));
        }
        pre.append(row);
      }
      block.append(pre);

      const levels = item.blanks.map(() => 0);
      const results = [];
      item.blanks.forEach((blank, k) => {
        // 段階: 概念 → 考え方 → 手がかりの場所(あれば) → 答えの形
        const steps = blank.hints.filter((h) => h && h.trim()).map((h) => () => document.createTextNode(h));
        if (blank.clue) {
          steps.splice(Math.min(2, steps.length), 0, () => refLine("この場所を読んでみよう: ", blank.clue));
        }
        const text = el("div", { class: "hint-text" });
        const btn = el("button", { class: "link", text: steps.length ? "ヒント" : "ヒントなし" });
        btn.disabled = steps.length === 0;
        btn.onclick = () => {
          if (levels[k] < steps.length) {
            const step = steps[levels[k]];
            levels[k]++;
            text.append(el("div", {}, document.createTextNode(`ヒント${levels[k]}: `), step()));
            btn.textContent = levels[k] < steps.length ? `次のヒント(${levels[k]}/${steps.length})` : "ヒントは以上";
            btn.disabled = levels[k] >= steps.length;
          }
        };
        const result = el("div", { class: "result" });
        results.push(result);
        block.append(
          el(
            "div",
            { class: "hint-row" },
            el("div", { class: "hint-head" }, el("span", { class: "hint-label", text: `空欄${k + 1}` }), el("span", { class: "concept", text: blank.concept }), btn),
            text,
            result,
          ),
        );
      });
      const after = el("div", { class: "after" });
      block.append(after);
      entry.items.push({ inputs, levels, results, after, kind: item.kind, index: item.index });
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
    gradeBtn.onclick = () => {
      entry.graded = true;
      gradeBtn.disabled = true;
      gradeBtn.textContent = "採点中...";
      for (const it of entry.items) {
        it.inputs.forEach((i) => (i.disabled = true));
      }
      for (const qu of entry.questions) {
        qu.labels.forEach((l) => (l.input.disabled = true));
      }
      vscode.postMessage({
        type: "grade",
        quizId: q.id,
        blanks: entry.items.map((it) => it.inputs.map((i) => i.value)),
        hints: entry.items.map((it) => it.levels),
        choices: entry.questions.map((qu) => qu.labels.flatMap((l, i) => (l.input.checked ? [i] : []))),
      });
    };
    entry.gradeBtn = gradeBtn;
    root.append(gradeBtn);
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
      res.grades.forEach((g, k) => {
        const input = it.inputs[k];
        input.classList.add(g.correct ? "correct" : "incorrect");
        const out = it.results[k];
        out.replaceChildren();
        out.className = `result ${g.correct ? "ok" : "ng"}`;
        const head = g.correct ? (g.via === "semantic" ? "◎ 別解として正解" : "○ 正解") : g.note === "未入力" ? "× 未入力" : "× 不正解";
        out.append(document.createTextNode(`${head}`));
        if (!g.correct || g.via === "semantic") {
          out.append(document.createTextNode("  模範解答: "), el("code", { text: g.expected }));
        }
        if (g.given && !g.correct) {
          out.append(document.createTextNode("  あなた: "), el("code", { text: g.given }));
        }
        if (g.note && g.note !== "未入力") {
          out.append(document.createTextNode(`\n${g.note}`));
        }
        if (g.why) {
          out.append(el("div", { class: "why-blank", text: `なぜ: ${g.why}` }));
        }
      });
      if (res.syntaxNote) {
        it.after.append(el("div", { class: "result ng", text: `⚠ ${res.syntaxNote}` }));
      }
      if (res.explanation) {
        it.after.append(el("div", { class: "explain", text: res.explanation }));
      }
      if (res.completed) {
        it.after.append(
          el("div", { class: "muted", text: "完成形のコード(この範囲がこう置き換わります)" }),
          el("pre", { class: "code", text: res.completed }),
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

  // ---------- 入出力 ----------

  function send() {
    const text = queryInput.value.trim();
    if (!text || queryInput.disabled) {
      return;
    }
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
