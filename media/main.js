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
  const live = $("live");
  const jumpBtn = $("jump-latest");
  const queryInput = /** @type {HTMLInputElement} */ ($("query"));
  const sendBtn = /** @type {HTMLButtonElement} */ ($("btn-send"));
  const cancelBtn = $("btn-cancel");
  const modeSelect = /** @type {HTMLSelectElement} */ ($("mode"));

  let state = { hasKey: false, hasWorkspace: true, busy: false, index: null, learning: null, testMode: false };
  /** @type {Map<string, any>} */
  const quizzes = new Map();

  // ---------- スクロール ----------
  //
  // - 利用者が送信したとき: いちばん下へ
  // - AI の返答(クイズ・手順・確認)が届いたとき: 返答の先頭が見える位置へ(長い返答の最後に飛ばない)
  // - 答え合わせ: 結果が見えるだけ動かす(見えていれば動かさない)
  // - お知らせ・進捗: いちばん下を見ているときだけ追いかける。上を読んでいる間は動かさず「↓ 最新へ」を出す

  const NEAR_BOTTOM = 40;
  /** 利用者がいちばん下を見ているか(見ていれば、追加された内容に追従する) */
  let pinned = true;

  function motion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  }

  function atBottom() {
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight <= NEAR_BOTTOM;
  }

  function updateJump() {
    jumpBtn.classList.toggle("hidden", atBottom());
  }

  messages.addEventListener("scroll", () => {
    pinned = atBottom();
    updateJump();
  });
  // 進捗の行やパネルの開閉で表示領域が変わっても、いちばん下を見ているなら下に留まる
  new ResizeObserver(() => {
    if (pinned) {
      messages.scrollTop = messages.scrollHeight;
    }
    updateJump();
  }).observe(messages);

  function scrollToBottom() {
    pinned = true;
    messages.scrollTop = messages.scrollHeight;
    updateJump();
  }

  /** 内容を末尾に足したあと: いちばん下を見ていれば追いかけ、そうでなければ「↓ 最新へ」を出す */
  function follow() {
    if (pinned) {
      scrollToBottom();
    } else {
      updateJump();
    }
  }

  function scrollBy(delta) {
    // 処理の結果を見せるために動かしたあとは、続けて届いたお知らせで下へ流されないようにする
    pinned = false;
    messages.scrollTo({ top: messages.scrollTop + delta, behavior: motion() });
  }

  /** node の先頭を表示領域の上端に合わせる */
  function scrollToStart(node) {
    scrollBy(node.getBoundingClientRect().top - messages.getBoundingClientRect().top - 4);
  }

  /** node が見えるだけ動かす(先頭が見えていて、収まるか長すぎるなら動かさない) */
  function ensureVisible(node) {
    const box = messages.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    const topVisible = r.top >= box.top && r.top <= box.bottom - 48;
    if (topVisible && (r.bottom <= box.bottom || r.height > box.height)) {
      return;
    }
    const tooTall = r.height > box.height - 16;
    scrollBy(r.top < box.top || tooTall ? r.top - box.top - 4 : r.bottom - box.bottom + 8);
  }

  jumpBtn.addEventListener("click", () => {
    pinned = true;
    messages.scrollTo({ top: messages.scrollHeight, behavior: motion() });
  });

  /** 会話の末尾に足す(最初の案内は消す) */
  function append(node) {
    $("empty-hint")?.remove();
    messages.append(node);
  }

  function addMessage(kind, text) {
    const cls =
      kind === "status"
        ? text.startsWith("⚠")
          ? "status warn"
          : text.startsWith("✅")
            ? "status ok"
            : text.startsWith("API 使用量")
              ? "status usage"
              : "status"
        : kind;
    const node = el("div", { class: `message ${cls}`, text });
    append(node);
    if (kind === "user") {
      scrollToBottom();
    } else {
      follow();
    }
    return node;
  }

  function setLive(text) {
    live.textContent = text || "";
    live.title = text || "";
    live.classList.toggle("hidden", !text);
  }

  /** 何も無いときの案内 */
  function renderEmptyHint() {
    if (messages.childElementCount > 0) {
      return;
    }
    const hint = el(
      "div",
      { id: "empty-hint", class: "empty-hint" },
      el("strong", { text: "コードを読んで、クイズで理解する" }),
      el("div", { text: "下の入力欄に、知りたい仕組みや実装したいことを書いてください。" }),
    );
    const list = el("ul");
    for (const t of ["仕組みの質問 → 実際のコードを使った穴埋めクイズ", "実装・修正の依頼 → 変更の手順を1ステップずつ"]) {
      list.append(el("li", { text: t }));
    }
    hint.append(list);
    messages.append(hint);
  }

  /** 見出し・本文・操作に分けたカード(AI の返答はすべてこの形) */
  function card(kindClass, title, ...headExtras) {
    const head = el("div", { class: "card-head" }, el("span", { class: "card-title", text: title }), ...headExtras);
    const body = el("div", { class: "card-body" });
    const root = el("div", { class: `message card ${kindClass}` }, head, body);
    return { root, head, body };
  }

  /** 小さな見出しつきのまとまり */
  function section(label, ...children) {
    return el("div", { class: "section" }, label ? el("div", { class: "section-label", text: label }) : null, ...children);
  }

  // ---------- 上部のパネル ----------

  const panels = { settings: $("settings-box"), log: $("log-box") };
  const panelButtons = { settings: $("btn-settings"), log: $("btn-log") };

  /** 設定・学習記録のパネルを開閉する(同時に開くのは1つだけ) */
  function togglePanel(name, open) {
    for (const [key, box] of Object.entries(panels)) {
      const show = key === name ? (open ?? box.classList.contains("hidden")) : false;
      box.classList.toggle("hidden", !show);
      panelButtons[key].setAttribute("aria-expanded", String(show));
    }
    if (name === "log" && !panels.log.classList.contains("hidden")) {
      renderLog();
    }
  }

  const testMode = /** @type {HTMLInputElement} */ ($("test-mode"));
  testMode.addEventListener("change", () => vscode.postMessage({ type: "setTestMode", value: testMode.checked }));

  function renderState() {
    const s = state;
    const ready = s.hasKey && s.hasWorkspace && !s.busy;
    testMode.checked = !!s.testMode;
    $("test-badge").classList.toggle("hidden", !s.testMode);
    queryInput.disabled = !ready;
    sendBtn.disabled = !ready;
    modeSelect.disabled = !ready;
    cancelBtn.classList.toggle("hidden", !s.busy);
    sendBtn.classList.toggle("hidden", !!s.busy);
    queryInput.placeholder = !s.hasWorkspace
      ? "フォルダを開いてください"
      : !s.hasKey
        ? "APIキーを設定してください"
        : s.busy
          ? "処理中..."
          : "例: ログイン処理はどう動く? / ○○機能を追加したい";
    if (!s.busy) {
      setLive("");
    }
    $("key-status").textContent = s.hasKey ? "設定済み" : "未設定(質問するには必要です)";
    $("btn-key").textContent = s.hasKey ? "変更" : "設定";
    const idx = s.index;
    // 件数・チャンク・意味検索の進み具合は、利用者が意識しなくてよいのでテストモードでだけ出す
    $("index-status").textContent = !idx
      ? s.hasWorkspace
        ? "準備中..."
        : "フォルダを開くと作成します"
      : (idx.semantic ? "キーワード検索 + 意味検索" : "キーワード検索のみ(意味検索は未有効)") +
        (s.testMode
          ? ` ・ ${idx.files}ファイル / ${idx.chunks}チャンク${idx.semantic ? ` / 意味検索 ${Math.round(idx.coverage * 100)}%` : ""}`
          : "");
    renderSetup();
    if (!panels.log.classList.contains("hidden")) {
      renderLog();
    }
    renderLevel();
  }

  /** 使い始めに必要なこと(フォルダ・APIキー)が欠けていれば、目立つ場所で案内する */
  function renderSetup() {
    const box = $("setup-box");
    box.replaceChildren();
    if (!state.hasWorkspace) {
      box.append(el("h4", { text: "フォルダを開いてください" }), el("div", { class: "muted", text: "開いたフォルダのコードを調べて出題します。" }));
    } else if (!state.hasKey) {
      const btn = el("button", { text: "APIキーを設定" });
      btn.onclick = () => vscode.postMessage({ type: "setApiKey" });
      box.append(
        el("h4", { text: "OpenAI APIキーを設定してください" }),
        el("div", { class: "muted", text: "コードの調査と出題に使います。キーはこのPCの VS Code のシークレットに保存されます。" }),
        el("div", { class: "row" }, btn),
      );
    }
    box.classList.toggle("hidden", box.childElementCount === 0);
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
      el("div", { class: "muted", text: "問題の難しさ・用語の説明・解説の細かさを合わせます。あとから上の「学習レベル」でいつでも変えられます。" }),
    );
    for (const l of levels) {
      const btn = el("button", { class: "level-choice secondary" }, el("strong", { text: l.label }), el("span", { text: l.description }));
      btn.onclick = () => vscode.postMessage({ type: "setLevel", level: l.id });
      box.append(btn);
    }
  }

  function panelHead(title, onClose) {
    const close = el("button", { class: "icon-btn", text: "×", title: "閉じる", "aria-label": "閉じる" });
    close.onclick = onClose;
    return el("div", { class: "panel-head" }, el("h4", { text: title }), close);
  }

  function renderLog() {
    const box = panels.log;
    box.replaceChildren();
    const l = state.learning;
    box.append(panelHead("学習記録(このワークスペース)", () => togglePanel("log", false)));
    if (!l || l.blanks === 0) {
      box.append(el("div", { class: "muted", text: "まだ記録がありません。クイズに答えるとここに溜まります。" }));
    } else {
      const stat = (value, label) => el("div", { class: "stat" }, el("strong", { text: value }), el("span", { text: label }));
      box.append(
        el("div", { class: "stat-line" }, stat(`${Math.round(l.accuracy * 100)}%`, "正答率"), stat(String(l.sessions), "解答回数"), stat(String(l.blanks), "空欄の数")),
      );
      if (l.weak.length > 0) {
        const list = el("div", { class: "refs" });
        for (const w of l.weak) {
          list.append(el("div", { text: `・${w.concept}: ${Math.round(w.accuracy * 100)}%(${w.attempts}問)` }));
        }
        box.append(section("苦手な概念(正答率の低い順)", list));
      }
    }
    const review = el("button", { text: `復習する(${l ? l.dueCount : 0}件)` });
    review.disabled = !l || l.dueCount === 0 || state.busy;
    review.onclick = () => {
      vscode.postMessage({ type: "startReview" });
      togglePanel("log", false);
    };
    const reset = el("button", { class: "secondary", text: "記録を消す" });
    reset.onclick = () => vscode.postMessage({ type: "resetLog" });
    box.append(el("div", { class: "row" }, review, reset));
  }

  function renderPlan(m) {
    togglePanel("", false);
    const box = $("plan-box");
    box.replaceChildren();
    box.classList.remove("hidden");
    box.append(panelHead("索引の更新", () => box.classList.add("hidden")));
    const none = m.files === 0 && m.removed === 0;
    box.append(
      el("div", {
        text: none
          ? "前回から変更されたファイルはありません。"
          : `変更されたファイル: ${m.files}(削除 ${m.removed})` +
            (state.testMode ? ` / 新規チャンク ${m.chunks}` : "") +
            (m.truncated ? "\n※ファイル数が上限を超えたため一部のみ対象です(設定 quizSupport.maxFiles)。" : ""),
      }),
    );
    // トークン数はテストモードでだけ出す
    box.append(
      el("div", {
        class: "muted",
        text:
          "キーワード検索の索引は API を使わずに作れます。意味検索を有効にすると、OpenAI API でコードの埋め込みを作り、言い回しが違っても関連するコードを見つけやすくなります。" +
          (state.testMode ? `\n未計算: ${m.pendingEmbeds} チャンク(約 ${m.tokens.toLocaleString()} トークン)` : ""),
      }),
    );
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
    box.append(el("div", { class: "row" }, embed, lexical, el("span", { class: "spacer" }), clear));
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
    const isChange = item.kind === "change";
    if (!options.noHead) {
      block.append(
        el(
          "div",
          { class: "quiz-head" },
          options.number ? el("span", { class: "item-no", text: `問題 ${options.number}` }) : null,
          el("span", { class: isChange ? "badge" : "badge quiet", text: isChange ? "実装" : "読解" }),
          codeLink(item.path, item.startLine, `${item.path}:${item.startLine}-${item.endLine}`),
        ),
      );
    }
    if (item.task) {
      block.append(el("div", { class: "task" }, el("span", { class: "task-label", text: isChange ? "課題" : "読みどころ" }), document.createTextNode(item.task)));
    }
    if (item.newNames && item.newNames.length > 0) {
      const names = el("div", { class: "names" }, el("div", { class: "section-label", text: "この問題で新しく作る名前" }));
      for (const n of item.newNames) {
        names.append(el("div", {}, el("code", { text: n.name }), n.role ? document.createTextNode(` — ${n.role}`) : null));
      }
      block.append(names);
    }
    if (item.refs && item.refs.length > 0) {
      // 実装の問題では手本として読むので開いておき、読解の問題では折りたたむ
      const refs = el("div", { class: "refs" });
      item.refs.forEach((r) => refs.append(refLine("・", r)));
      block.append(details(`参考にするコード(${item.refs.length})`, [refs], isChange));
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
      const hintBtn = el("button", { class: "link", text: steps.length ? `ヒント(0/${steps.length})` : "ヒントなし" });
      hintBtn.disabled = steps.length === 0;
      hintBtn.onclick = () => {
        if (levels[k] < steps.length) {
          const step = steps[levels[k]];
          levels[k]++;
          text.append(el("div", {}, document.createTextNode(`ヒント${levels[k]}: `), step()));
          hintBtn.textContent = levels[k] < steps.length ? `次のヒント(${levels[k]}/${steps.length})` : "ヒントは以上です";
          hintBtn.disabled = levels[k] >= steps.length;
        }
      };
      const list = el("div", { class: "choices" });
      buttons.forEach((b, o) => list.append(el("div", { class: "choice-row" }, b, notes[o])));
      const result = el("div", { class: "result" });
      const group = el(
        "div",
        { class: "blank-group" },
        el("div", { class: "hint-head" }, el("span", { class: "blank-no", text: `空欄 ${k + 1}` }), el("span", { class: "concept", text: blank.concept }), hintBtn),
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

  /** 正答率に応じた結果のバッジ */
  function scoreBadge(score) {
    const rate = score.total > 0 ? score.correct / score.total : 0;
    return el("span", { class: `badge score ${rate >= 0.8 ? "good" : rate >= 0.5 ? "fair" : ""}`, text: `${score.correct}/${score.total} 正解` });
  }

  function renderQuiz(q) {
    const blankCount = q.items.reduce((n, item) => n + item.blanks.length, 0);
    const count = q.items.length + q.questions.length;
    const { root, head, body } = card("quiz", q.review ? "復習" : "クイズ", el("span", { class: "badge quiet", text: `${count}問・空欄${blankCount}個` }));
    if (q.goal) {
      body.append(el("p", { class: "goal", text: q.goal }));
    }
    const entry = { id: q.id, root, head, body, items: [], questions: [], prediction: null, graded: false, foot: null, gradeBtn: null };

    if (!q.review) {
      // 予想メモは任意。入力の負担を増やさないよう、開いたときだけ表示する
      const prediction = el("textarea", { class: "prediction hidden", rows: 2, placeholder: "このコードは何をしていそう?(自分の言葉で一言)" });
      const toggle = el("button", { class: "link", text: "＋ 先に予想をメモする(任意)" });
      toggle.onclick = () => {
        prediction.classList.remove("hidden");
        toggle.remove();
        prediction.focus();
      };
      entry.prediction = prediction;
      body.append(el("div", {}, toggle, prediction));
    }

    q.items.forEach((item, i) => {
      const { block, state } = renderItem(item, () => entry.graded, { number: count > 1 ? i + 1 : 0 });
      entry.items.push(state);
      body.append(block);
    });

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
      body.append(set);
    }

    const gradeBtn = el("button", { text: "採点する" });
    const unanswered = el("span", { class: "unanswered" });
    gradeBtn.onclick = () => {
      const left = entry.items.reduce((n, it) => n + it.picked.filter((p) => p < 0).length, 0);
      if (left > 0 && !unanswered.textContent) {
        // 1回目は知らせるだけ。もう一度押せば未選択のまま採点する
        unanswered.textContent = `未選択の空欄が${left}個あります(もう一度押すとこのまま採点)`;
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
    entry.foot = el("div", { class: "card-foot" }, gradeBtn, unanswered);
    body.append(entry.foot);
    quizzes.set(q.id, entry);
    append(root);
    scrollToStart(root);
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
        it.after.append(section("解説", el("div", { class: "explain", text: res.explanation })));
      }
      if (res.completed) {
        it.after.append(details("変更点を見る(- 削除 / + 追加。変更のない行は省略)", [diffBlock(res.completed)], true));
      }
      if (res.canApply) {
        const apply = el("button", { class: "secondary", text: "正解コードをファイルに反映…" });
        apply.title = "反映する前に確認します";
        apply.onclick = () => vscode.postMessage({ type: "apply", quizId: m.quizId, itemIndex: i });
        it.after.append(el("div", { class: "row" }, apply));
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

    // 採点のボタンは役目を終えたので、結果のまとめに置き換える
    entry.head.append(scoreBadge(m.score));
    const summary = el("div", { class: "summary" }, el("div", { class: "score", text: `結果: ${m.score.total}問中 ${m.score.correct}問正解` }));
    const mine = entry.prediction && entry.prediction.value.trim();
    if (mine) {
      summary.append(section("あなたの予想", el("div", { text: mine })));
    }
    if (m.overall) {
      summary.append(section("全体の解説", el("div", { text: m.overall })));
    }
    entry.foot.replaceWith(summary);
    ensureVisible(summary);
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
    const scale = c.estimatedFiles || c.estimatedLines ? `約${c.estimatedFiles}ファイル・約${c.estimatedLines}行` : "";
    const { root, body } = card("clarify", "実装の前に確認させてください", scale ? el("span", { class: "badge quiet", text: `見込み: ${scale}` }) : null);
    if (c.understanding) {
      body.append(section("依頼の理解", el("div", { class: "goal", text: c.understanding })));
    }
    if (c.reason) {
      body.append(el("div", { class: "muted", text: c.reason }));
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
      body.append(set);
      return { radios, note };
    });

    const submit = el("button", { text: "この内容で出題する" });
    const skip = el("button", { class: "secondary", text: "確認せずに進める", title: "出題側の判断で、依頼のまま実装問題を作ります" });
    const footer = el("span", { class: "muted" });
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
    body.append(el("div", { class: "card-foot" }, submit, skip, footer));
    openClarify = { disable };
    append(root);
    scrollToStart(root);
  }

  // ---------- 実装の手順 ----------

  /** @type {Map<string, any>} */
  const lessons = new Map();

  /**
   * 実装の手順: 地図(サブゴールの一覧)を先に見せ、1ステップずつ
   * 「なぜここを変えるか → 穴埋め → 次に確認すべき場所の予想 → 答え合わせ(見つけ方と判断)」の順に進める。
   */
  function renderLesson(l) {
    const total = l.steps.length;
    const progressText = el("span", { class: "badge quiet" });
    const { root, body } = card("lesson", "実装の手順", el("span", { class: "spacer" }), progressText);
    if (l.goal) {
      body.append(el("p", { class: "goal", text: l.goal }));
    }
    const bar = el("div");
    body.append(el("div", { class: "progress", title: "進み具合" }, bar));
    let criteria = null;
    if (l.criteria && l.criteria.length > 0) {
      const list = el("ol", { class: "criteria" });
      l.criteria.forEach((c) => list.append(el("li", { text: c })));
      criteria = el("details", { class: "section-fold" }, el("summary", { text: `受け入れ条件(実装できたかを確かめる基準・${l.criteria.length}件)` }), list);
      criteria.open = true;
      body.append(criteria);
    }
    const map = el("ol", { class: "step-map" });
    const mapItems = l.steps.map((s) => {
      const li = el("li", { class: "todo", text: s.label });
      map.append(li);
      return li;
    });
    const mapBox = el("details", { class: "section-fold" }, el("summary", { text: `手順の地図(全${total}ステップ・依存される側から順に)` }), map);
    mapBox.open = true;
    body.append(mapBox);
    const steps = el("div", { class: "lesson-steps" });
    body.append(steps);
    const entry = { id: l.id, root, body, steps, mapItems, criteria, bar, progressText, total, stepState: new Map(), final: null };
    lessons.set(l.id, entry);
    append(root);
    renderLessonStep(entry, l.step);
    // 届いたときは、目標と地図から読めるように手順の先頭を見せる
    scrollToStart(root);
  }

  /** 進み具合(答え合わせ済みのステップ数) */
  function setProgress(entry, done) {
    entry.bar.style.width = `${Math.round((done / entry.total) * 100)}%`;
    entry.progressText.textContent = done >= entry.total ? "完了" : `${done}/${entry.total} ステップ完了`;
  }

  function renderLessonStep(entry, s) {
    entry.mapItems.forEach((li, i) => (li.className = i < s.index ? "done" : i === s.index ? "current" : "todo"));
    setProgress(entry, s.index);
    // 読み終えた古いステップは閉じる(直前のステップは答え合わせを読めるよう開いたまま)
    for (const [index, st] of entry.stepState) {
      if (index < s.index - 1) {
        st.block.open = false;
      }
    }
    const summary = el(
      "summary",
      {},
      el("span", { class: "step-no", text: `${s.number}/${s.total}` }),
      el("span", { class: "step-label", text: s.label }),
      el("span", { class: "badge quiet", text: s.kind }),
      s.mechanical ? el("span", { class: "badge quiet", text: "考えどころ少" }) : null,
    );
    const block = el("details", { class: "lesson-step" }, summary);
    block.open = true;
    const stepBody = el("div", { class: "step-body" });
    block.append(stepBody);

    const files = el("div", { class: "refs" });
    for (const f of s.files) {
      files.append(
        el(
          "div",
          {},
          f.created ? el("span", { class: "file-link", text: `${f.path}(新規作成)` }) : codeLink(f.path, f.line, `${f.path}:${f.line}`, f.text),
        ),
      );
    }
    stepBody.append(section("変更する場所", files));
    if (s.why) {
      stepBody.append(el("div", { class: "task" }, el("span", { class: "task-label", text: "なぜ" }), document.createTextNode(s.why)));
    }
    if (s.contract) {
      stepBody.append(el("div", { class: "contract" }, el("span", { class: "task-label", text: "約束の変化" }), document.createTextNode(s.contract)));
    }
    const state = { answered: false, item: null, q: null, reveal: null, btn: null, block, summary };
    if (s.item) {
      const { block: itemBlock, state: itemState } = renderItem(s.item, () => state.answered, { noHead: true });
      state.item = itemState;
      stepBody.append(itemBlock);
    }
    if (s.diffs && s.diffs.length > 0) {
      const label = s.item ? "このステップのほかの変更" : "このステップの変更";
      stepBody.append(
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
        set.append(el("div", {}, hintBtn), hint);
      }
      const why = el("div", { class: "why" });
      set.append(why);
      state.q = { labels, why };
      stepBody.append(set);
    }
    state.reveal = el("div", { class: "reveal" });
    stepBody.append(state.reveal);
    const last = s.index + 1 >= s.total;
    const nothingToAnswer = !s.item && !s.question;
    const btn = el("button", {
      text: nothingToAnswer ? (last ? "確認してまとめへ" : "確認して次へ") : last ? "答え合わせ" : "答え合わせして次へ",
    });
    const warn = el("span", { class: "unanswered" });
    btn.onclick = () => {
      if (state.answered) {
        return;
      }
      const left = state.item ? state.item.picked.filter((p) => p < 0).length : 0;
      const noChoice = state.q && !state.q.labels.some((l) => l.input.checked);
      if ((left > 0 || noChoice) && !warn.textContent) {
        // 1回目は知らせるだけ。もう一度押せば未回答のまま答え合わせする
        warn.textContent = "未回答があります(もう一度押すとこのまま答え合わせ)";
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
    state.foot = el("div", { class: "card-foot" }, btn, warn);
    stepBody.append(state.foot);
    entry.stepState.set(s.index, state);
    entry.steps.append(block);
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
    box.replaceChildren(el("div", { class: "section-label", text: "答え合わせ" }));
    if (rv.explanation) {
      box.append(el("div", { class: "explain", text: rv.explanation }));
    }
    if (rv.diffs.length > 0) {
      box.append(
        details(
          "このステップの変更を見る(- 削除 / + 追加)",
          rv.diffs.flatMap((d) => [el("div", { class: "muted", text: `${d.path}${d.created ? "(新規)" : ""}` }), diffBlock(d.diff)]),
        ),
      );
    }
    if (rv.checks.length === 0) {
      box.append(el("div", { class: "muted", text: "この変更で、ほかに確認が必要になった場所はありませんでした。" }));
      return;
    }
    const cards = [];
    for (const c of rv.checks) {
      const check = el("div", { class: "check" });
      check.append(el("div", { class: "check-head" }, el("span", { class: "badge", text: c.pattern }), el("span", { text: `きっかけ: ${c.trigger}` })));
      check.append(el("div", { class: "muted", text: `探し方: ${c.query}` }));
      check.append(el("div", { class: "muted", text: `判断基準: ${c.criterion}` }));
      const changed = c.results.filter((r) => r.changed);
      const action = c.results.filter((r) => r.needsAction);
      const kept = c.results.filter((r) => !r.changed && !r.needsAction);
      changed.forEach((r) => check.append(resultLine(r.auto ? "✓ 変更済み" : "✏ 変更", r)));
      action.forEach((r) => check.append(resultLine("⚠ 要対応", r)));
      if (kept.length > 0) {
        // 「変えなかった理由」は判断の手本になるが、量が多いので折りたたむ
        check.append(details(`変更不要と判断した場所(${kept.length})`, kept.map((r) => resultLine("– 変更不要", r))));
      }
      (c.pending || []).forEach((p) => check.append(resultLine("⚠ 判断できなかった", { ...p, reason: c.error || "自動では判断できませんでした" })));
      if (c.more > 0) {
        check.append(el("div", { class: "muted", text: `ほかに ${c.more} か所(表示を省略)` }));
      }
      cards.push(check);
    }
    const fold = el("details", { class: "section-fold" }, el("summary", { text: `この変更で確認が必要になった場所(見つけ方と判断・${rv.checks.length}件)` }), ...cards);
    fold.open = true;
    box.append(fold);
  }

  function onLessonStep(m) {
    const entry = lessons.get(m.lessonId);
    const state = entry && entry.stepState.get(m.index);
    if (!state) {
      return;
    }
    const r = m.result;
    let correct = 0;
    let total = 0;
    if (state.item && r.grades) {
      markItemGrades(state.item, r.grades);
      correct += r.grades.filter((g) => g.correct).length;
      total += r.grades.length;
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
      correct += r.question.correct ? 1 : 0;
      total++;
    }
    renderReveal(state.reveal, r.reveal);
    state.foot.remove();
    state.block.classList.add("answered");
    state.summary.append(total > 0 ? scoreBadge({ correct, total }) : el("span", { class: "badge quiet", text: "確認済み" }));
    if (entry.criteria) {
      // 1ステップ目を終えたら、受け入れ条件は閉じて手順に集中できるようにする(見出しから開ける)
      entry.criteria.open = false;
    }
    if (m.next) {
      renderLessonStep(entry, m.next);
    } else {
      entry.mapItems.forEach((li) => (li.className = "done"));
      setProgress(entry, entry.total);
    }
    if (m.final) {
      renderLessonFinal(entry, m.final);
    }
    // 答え合わせの結果(解説・確認した場所)から読めるようにする。次のステップへは下へ読み進める
    ensureVisible(state.reveal);
  }

  function renderLessonFinal(entry, f) {
    const box = el("div", { class: "summary lesson-final" });
    box.append(el("div", { class: "score", text: `まとめ: ${f.score.total}問中 ${f.score.correct}問正解` }));
    if (f.overall) {
      box.append(el("div", { class: "overall", text: f.overall }));
    }
    const files = el("div", { class: "refs" });
    f.files.forEach((x) =>
      files.append(
        el(
          "div",
          { class: "file-stat" },
          document.createTextNode(`${x.path} `),
          el("span", { class: "plus", text: `+${x.added}` }),
          document.createTextNode(" "),
          el("span", { class: "minus", text: `-${x.removed}` }),
          x.created ? el("span", { class: "badge quiet", text: "新規" }) : null,
        ),
      ),
    );
    box.append(section(`反映するファイル(${f.files.length})`, files));
    if (f.typecheck.available) {
      if (f.typecheck.remaining.length > 0) {
        box.append(el("div", { class: "warn-box", text: `⚠ 解消できなかった型エラー(${f.typecheck.remaining.length}件)\n${f.typecheck.remaining.join("\n")}` }));
      } else {
        box.append(el("div", { class: "ok-line", text: "✓ 型検査: 変更による新しいエラーはありません" }));
      }
    } else if (f.typecheck.note) {
      box.append(el("div", { class: "muted", text: f.typecheck.note }));
    }
    if (f.unresolved.length > 0) {
      box.append(el("div", { class: "warn-box", text: `⚠ 手で確認が必要なこと\n${f.unresolved.map((u) => `・${u}`).join("\n")}` }));
    }
    if (f.warnings.length > 0) {
      box.append(details(`計画を作るときの注意(${f.warnings.length})`, f.warnings.map((w) => el("div", { class: "muted", text: `・${w}` }))));
    }
    const apply = el("button", { text: "すべての変更をファイルに反映…", title: "反映する前に確認します" });
    const revert = el("button", { class: "secondary hidden", text: "反映を取り消す" });
    const test = el("button", { class: "secondary hidden", text: `テストを実行(${f.testCommand || ""})` });
    const testBox = el("div", { class: "test-box" });
    apply.onclick = () => vscode.postMessage({ type: "lessonApply", lessonId: entry.id });
    revert.onclick = () => vscode.postMessage({ type: "lessonRevert", lessonId: entry.id });
    test.onclick = () => {
      testBox.replaceChildren(el("div", { class: "muted", text: "テストを実行しています..." }));
      vscode.postMessage({ type: "lessonTest", lessonId: entry.id });
    };
    box.append(el("div", { class: "card-foot" }, apply, revert, test), testBox);
    entry.final = { apply, revert, test, testBox, canTest: !!f.canTest };
    entry.body.append(box);
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
    f.apply.textContent = "すべての変更をファイルに反映…";
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
      f.testBox.append(el("div", { class: "row" }, fix));
    }
    ensureVisible(f.testBox);
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
  $("btn-log").addEventListener("click", () => togglePanel("log"));
  $("btn-settings").addEventListener("click", () => togglePanel("settings"));
  $("btn-settings-close").addEventListener("click", () => togglePanel("settings", false));
  $("test-badge").addEventListener("click", () => togglePanel("settings", true));

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
        togglePanel("log", true);
        break;
    }
  });

  renderEmptyHint();
  vscode.postMessage({ type: "ready" });
})();
