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
  const queryInput = /** @type {HTMLTextAreaElement} */ ($("query"));
  const queryMirror = $("query-mirror");
  const assistLine = $("assist-line");
  const assistBox = $("assist-box");
  const assistSr = $("assist-sr");
  const refineBtn = /** @type {HTMLButtonElement} */ ($("btn-refine"));
  /** media/assist.js(入力補助の、画面に依存しない処理) */
  const A = /** @type {any} */ (window).QbsAssist;
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
  // - 考えを確かめたとき: 選んだ場所で結果を確かめられるよう動かさない(続けて届いたお知らせでも下へ流さない)
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

  /** 今の位置に留まる(このあと届いたお知らせでも追いかけず、「↓ 最新へ」を出す) */
  function hold() {
    pinned = false;
    updateJump();
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

  /** 何も無いときの案内(画面の中央に、入力欄への誘導だけを出す) */
  function renderEmptyHint() {
    if (messages.childElementCount > 0) {
      return;
    }
    // 狭いときは「、」の後でだけ折り返す(単語の途中で切らない)
    messages.append(
      el("div", { id: "empty-hint", class: "empty-hint" }, el("span", { text: "下の入力欄に、" }), el("span", { text: "知りたい仕組みや実装したいことを書いてください。" })),
    );
  }

  /** 見出し・本文・操作に分けたカード(AI の返答はすべてこの形) */
  function card(kindClass, title, ...headExtras) {
    const head = el("div", { class: "card-head" }, el("span", { class: "card-title", text: title }), ...headExtras);
    const body = el("div", { class: "card-body" });
    const root = el("div", { class: `message card ${kindClass}` }, head, body);
    return { root, head, body };
  }

  /**
   * 考える順序を、番号つきの縦の流れ(①目的 → ②場所 → ③…)で見せる。
   * エンジニアが要件からどう考えて変更するかを、1段ずつたどれるようにする。
   */
  function chain() {
    return el("div", { class: "chain" });
  }

  /** chain の1段(番号は CSS の counter で振る) */
  function thought(label, ...children) {
    const body = el("div", { class: "thought-body" }, ...children);
    const node = el("div", { class: "thought" }, el("div", { class: "thought-label", text: label }), body);
    return { node, body };
  }

  /** 小さな見出しつきのまとまり */
  function section(label, ...children) {
    return el("div", { class: "section" }, label ? el("div", { class: "section-label", text: label }) : null, ...children);
  }

  // ---------- 上部のパネル ----------

  const panels = { settings: $("settings-box"), log: $("log-box") };
  const panelButtons = { settings: $("btn-settings"), log: $("btn-log") };

  /** 設定・判断の記録のパネルを開閉する(同時に開くのは1つだけ) */
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
  const inputAssistToggle = /** @type {HTMLInputElement} */ ($("input-assist"));
  inputAssistToggle.addEventListener("change", () => vscode.postMessage({ type: "setInputAssist", value: inputAssistToggle.checked }));

  function renderState() {
    const s = state;
    const ready = s.hasKey && s.hasWorkspace && !s.busy;
    testMode.checked = !!s.testMode;
    $("test-badge").classList.toggle("hidden", !s.testMode);
    queryInput.disabled = !ready;
    sendBtn.disabled = !ready;
    modeSelect.disabled = !ready;
    refineBtn.disabled = !ready;
    inputAssistToggle.checked = s.inputAssist !== false;
    $("input-assist-test").classList.toggle("hidden", !s.testMode);
    $("input-assist-note").textContent = s.assistNote || "";
    $("input-assist-note").classList.toggle("hidden", !s.assistNote);
    renderAssistStats(s.assistStats);
    if (!ready || !s.assist || !s.assist.auto) {
      // 処理中・設定でオフ・テストモードのときは、出している候補を消す
      cancelSuggest();
      if (!ready || !s.assist || !s.assist.names) {
        clearGhost();
        hideAssistLine();
      }
    }
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
      box.append(el("h4", { text: "フォルダを開いてください" }), el("div", { class: "muted", text: "開いたフォルダのコードを調べて、考え方をたどります。" }));
    } else if (!state.hasKey) {
      const btn = el("button", { text: "APIキーを設定" });
      btn.onclick = () => vscode.postMessage({ type: "setApiKey" });
      box.append(
        el("h4", { text: "OpenAI APIキーを設定してください" }),
        el("div", { class: "muted", text: "コードの調査と解説の生成に使います。キーはこのPCの VS Code のシークレットに保存されます。" }),
        el("div", { class: "row" }, btn),
      );
    }
    box.classList.toggle("hidden", box.childElementCount === 0);
  }

  // ---------- 経験レベル ----------

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
      el("h4", { text: "はじめに: 経験レベルを選んでください" }),
      el("div", { class: "muted", text: "扱う内容の深さ・用語の説明・解説の細かさを合わせます。あとから上の「経験レベル」でいつでも変えられます。" }),
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
    box.append(panelHead("これまでの判断(このワークスペース)", () => togglePanel("log", false)));
    if (!l || l.blanks === 0) {
      box.append(el("div", { class: "muted", text: "まだ記録がありません。考えを確かめるとここに残ります。" }));
    } else {
      const stat = (value, label) => el("div", { class: "stat" }, el("strong", { text: value }), el("span", { text: label }));
      box.append(
        el("div", { class: "stat-line" }, stat(`${Math.round(l.accuracy * 100)}%`, "判断の一致率"), stat(String(l.sessions), "取り組んだ回数"), stat(String(l.blanks), "判断ポイント")),
      );
      if (l.weak.length > 0) {
        const list = el("div", { class: "refs" });
        for (const w of l.weak) {
          list.append(el("div", { text: `・${w.concept}: ${Math.round(w.accuracy * 100)}%(${w.attempts}回)` }));
        }
        box.append(section("見直したい観点(一致率の低い順)", list));
      }
    }
    const review = el("button", { text: `振り返る(${l ? l.dueCount : 0}件)` });
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

  /** 実装の手順で変更する場所へのリンク(新規作成のファイルはまだ無いので名前だけ) */
  function fileLink(f) {
    return f.created ? el("span", { class: "file-link", text: `${f.path}(新規作成)` }) : codeLink(f.path, f.line, `${f.path}:${f.line}`, f.text);
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
   * コード1か所と、その中の判断ポイント(候補から選ぶ・段階的な手がかり)。読み解きと変更の手順で共通。
   * locked() が true の間は選択を変えられない(考えを確かめた後)。
   */
  function renderItem(item, locked, options = {}) {
    const block = el("div", { class: "code-item" });
    const isChange = item.kind === "change";
    if (!options.noHead) {
      block.append(el("div", { class: "item-head" }, codeLink(item.path, item.startLine, `${item.path}:${item.startLine}-${item.endLine}`)));
    }
    if (item.task) {
      // 変更では「何を実現するために、どこを、どう変えるか」、読み解きでは「何を読み取るか」
      block.append(el("div", { class: "task" }, el("span", { class: "task-label", text: isChange ? "戦略" : "ねらい" }), document.createTextNode(item.task)));
    }
    if (item.newNames && item.newNames.length > 0) {
      const names = el("div", { class: "names" }, el("div", { class: "section-label", text: "新規作成する要素" }));
      for (const n of item.newNames) {
        names.append(el("div", {}, el("code", { text: n.name }), n.role ? document.createTextNode(` — ${n.role}`) : null));
      }
      block.append(names);
    }
    if (item.refs && item.refs.length > 0) {
      // 変更では手本として読むので開いておき、読み解きでは折りたたむ
      const refs = el("div", { class: "refs" });
      item.refs.forEach((r) => refs.append(refLine("・", r)));
      block.append(details(`参考にするコード(${item.refs.length})`, [refs], isChange));
    }
    if (options.link) {
      // 変更する場所へのリンクは、コードのすぐ上に出す
      block.append(el("div", { class: "item-head" }, options.link));
    }

    /** コード中の判断ポイント(選んだ候補がここにはまる) */
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
        const toggle = el("div", { class: "code-fold", text: `⋯ ${count}行省略(クリックで表示)`, title: "判断ポイントと直接関係しない行" });
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
          const slot = el("span", { class: "slot", text: `［ ${n} ］`, title: `要所 ${n}: 下の候補から選んでください`, tabIndex: 0 });
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
        const b = el("button", { class: "choice", title: "この候補をコードに当てはめる" }, el("code", { text: code }));
        b.onclick = () => {
          if (locked() || b.disabled) {
            return;
          }
          picked[k] = o;
          buttons.forEach((x, i) => x.classList.toggle("selected", i === o));
          // 選んだコードをコードの中にはめて、前後とつながるかを見ながら考えられるようにする
          slot.textContent = code;
          slot.classList.add("filled");
        };
        return b;
      });
      const notes = blank.options.map(() => el("div", { class: "choice-note hidden" }));

      // 手がかりの段階: 概念 → 考え方 → 読む場所(あれば) → 当てはまらない候補を1つ消す(あれば)
      const steps = blank.hints.filter((h) => h && h.trim()).map((h) => () => document.createTextNode(h));
      if (blank.clue) {
        steps.push(() => refLine("この場所を読むと判断できます: ", blank.clue));
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
          return document.createTextNode(`候補「${blank.options[e.index]}」は当てはまりません。${e.note ? `理由: ${e.note}` : ""}`);
        });
      }
      const text = el("div", { class: "hint-text" });
      const hintBtn = el("button", { class: "link", text: steps.length ? `考え方のヒント(0/${steps.length})` : "" });
      hintBtn.disabled = steps.length === 0;
      hintBtn.onclick = () => {
        if (locked()) {
          return;
        }
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
        el("div", { class: "hint-head" }, el("span", { class: "blank-no", text: `要所 ${k + 1}` }), el("span", { class: "concept", text: blank.concept }), steps.length ? hintBtn : null),
        list,
        text,
        result,
      );
      slot.addEventListener("click", () => group.scrollIntoView({ behavior: "smooth", block: "nearest" }));
      groups.push({ buttons, notes, result, slot, hintBtn, hints: text });
      block.append(group);
    });
    const after = el("div", { class: "after" });
    block.append(after);
    return { block, state: { picked, levels, groups, after, kind: item.kind, index: item.index } };
  }

  /** 確かめた結果を、判断ポイント・候補に書き込む(実際のコードと、その根拠) */
  function markItemGrades(it, grades) {
    grades.forEach((g, k) => {
      const group = it.groups[k];
      if (!group) {
        return;
      }
      group.buttons.forEach((b) => (b.disabled = true));
      // 使ったヒントは折りたたんで、結果を読みやすくする(使っていなければ何も残さない)
      group.hintBtn.remove();
      if (group.hints.childElementCount > 0) {
        const fold = details(`考え方のヒント(${group.hints.childElementCount})`, []);
        group.hints.replaceWith(fold);
        fold.append(group.hints);
      }
      group.slot.classList.add(g.correct ? "correct" : "incorrect");
      // 合っていれば選んだコードのまま、違えば実際のコードに置き換えて、完成したコードとして読めるようにする
      group.slot.textContent = g.expected;
      group.buttons.forEach((b, o) => {
        if (o === g.correctIndex) {
          b.classList.add("right");
        } else if (o === g.chosen) {
          b.classList.add("wrong");
        }
        // 選んだ候補が違ったときだけ「選ばない理由」を出す(他の候補の理由は情報が多くなりすぎるので出さない)
        if (o === g.chosen && o !== g.correctIndex && g.notes[o]) {
          group.notes[o].textContent = `選ばない理由: ${g.notes[o]}`;
          group.notes[o].classList.remove("hidden");
        }
      });
      const out = group.result;
      out.replaceChildren();
      out.className = `result ${g.correct ? "ok" : "ng"}`;
      // 合っていれば短く伝える。違った・選ばなかったときは判定を出さず、なぜそのコードになるかへ読み進めてもらう
      // (違ったことは、コード中の枠と候補の色で分かる)
      if (g.correct) {
        out.append(document.createTextNode("✓ 合っています"));
      } else if (g.why) {
        out.append(el("code", { text: g.expected }), document.createTextNode(" になる理由"));
      } else {
        // 理由が無いときは、入るコードだけを示す
        out.append(document.createTextNode(`${it.kind === "change" ? "このコードにする" : "実際のコード"}: `), el("code", { text: g.expected }));
      }
      if (g.why) {
        out.append(el("div", { class: "why-blank", text: g.why }));
      }
    });
  }

  /**
   * 仕組みを読み解く(変更の考えどころを含むこともある)。
   * ①何を理解するか → ②③…コードを読み、判断ポイントを考える → 呼び出し関係を確かめる → 振り返り、の順に並べる。
   */
  function renderQuiz(q) {
    const hasChange = q.items.some((item) => item.kind === "change");
    const title = q.review ? "振り返り" : hasChange ? "変更の考えどころ" : "仕組みの読み解き";
    const { root, head, body } = card("reading", title);
    const flow = chain();
    body.append(flow);
    const entry = { id: q.id, root, head, body, items: [], questions: [], prediction: null, graded: false, foot: null, gradeBtn: null };

    const purpose = thought(q.review ? "もう一度考えること" : "何を理解するか");
    if (q.goal) {
      purpose.body.append(el("p", { class: "goal", text: q.goal }));
    }
    if (!q.review) {
      // 見立てのメモは任意。入力の負担を増やさないよう、開いたときだけ表示する
      const prediction = el("textarea", { class: "prediction hidden", rows: 2, placeholder: "このコードは何をしていそう?(自分の言葉で一言)" });
      const toggle = el("button", { class: "link", text: "＋ 読む前に、自分の見立てを書いておく(任意)" });
      toggle.onclick = () => {
        prediction.classList.remove("hidden");
        toggle.remove();
        prediction.focus();
      };
      entry.prediction = prediction;
      purpose.body.append(el("div", {}, toggle, prediction));
    }
    flow.append(purpose.node);

    q.items.forEach((item) => {
      const { block, state } = renderItem(item, () => entry.graded);
      entry.items.push({ ...state, path: item.path, concepts: item.blanks.map((b) => b.concept) });
      flow.append(thought(item.kind === "change" ? "どう変えるか" : "どこを、どう読むか", block).node);
    });

    if (q.questions.length > 0) {
      const step = thought("呼び出し関係を確かめる");
      for (const question of q.questions) {
        const set = el("fieldset", { class: "mcq" }, el("legend", { text: "つながり" }), el("div", { text: question.prompt }));
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
        step.body.append(set);
      }
      flow.append(step.node);
    }

    const gradeBtn = el("button", { text: "考えを確かめる" });
    const unanswered = el("span", { class: "unanswered" });
    gradeBtn.onclick = () => {
      const left = entry.items.reduce((n, it) => n + it.picked.filter((p) => p < 0).length, 0);
      if (left > 0 && !unanswered.textContent) {
        // 1回目は知らせるだけ。もう一度押せば選ばないまま確かめる
        unanswered.textContent = `まだ選んでいない要所が${left}か所あります(もう一度押すとこのまま確かめます)`;
        return;
      }
      entry.graded = true;
      gradeBtn.disabled = true;
      gradeBtn.textContent = "確かめています...";
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
    /** 判断が分かれた観点(振り返りで見直す) */
    const revisit = [];
    m.items.forEach((res, i) => {
      const it = entry.items[i];
      markItemGrades(it, res.grades);
      res.grades.forEach((g, k) => {
        if (!g.correct) {
          revisit.push(`${it.concepts[k] || "要所"}(${it.path.split("/").pop()} の要所 ${k + 1})`);
        }
      });
      if (res.explanation) {
        it.after.append(section("このコードの役割と流れ", el("div", { class: "explain", text: res.explanation })));
      }
      if (res.completed) {
        it.after.append(details("変更点を見る(- 削除 / + 追加。変更のない行は省略)", [diffBlock(res.completed)], true));
      }
      if (res.canApply) {
        const apply = el("button", { class: "secondary", text: "このコードをファイルに反映…" });
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
      qu.why.textContent = `${res.correct ? "✓ 一致" : "✗ 異なる"}  ${res.explanation}`;
    });

    // 確かめるボタンは役目を終えたので、振り返りに置き換える
    entry.head.append(el("span", { class: "badge quiet", text: "確認済み" }));
    const summary = el("div", { class: "summary" }, el("div", { class: "summary-title", text: "振り返り" }));
    const mine = entry.prediction && entry.prediction.value.trim();
    if (mine) {
      summary.append(section("最初の見立て", el("div", { text: mine })));
    }
    if (m.overall) {
      summary.append(section("全体の流れ", el("div", { text: m.overall })));
    }
    if (revisit.length > 0) {
      summary.append(section("見直すとよい判断", el("div", { text: [...new Set(revisit)].map((r) => `・${r}`).join("\n") })));
    }
    entry.foot.replaceWith(summary);
    hold();
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
    const { root, body } = card("clarify", "実装前の確認", scale ? el("span", { class: "badge quiet", text: `見込み: ${scale}` }) : null);
    if (c.understanding) {
      body.append(el("div", { class: "goal", text: c.understanding }));
    }
    if (c.reason) {
      body.append(el("div", { class: "muted", text: c.reason }));
    }
    if (c.stages && c.stages.length > 0) {
      // 大きな依頼は段階に分け、1段階ずつ依頼全体が完成するまで進める
      body.append(section(`段階の分け方(この順に1段階ずつ、依頼全体が完成するまで進めます)`, stageList(c.stages.map((st) => ({ ...st, status: "todo" })))));
    }

    const inputs = c.questions.map((q, qi) => {
      const set = el("fieldset", { class: "mcq clarify-q" }, el("legend", { text: `決めること ${qi + 1}` }), el("div", { class: "clarify-question", text: q.question }));
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

    const hasQuestions = c.questions.length > 0;
    const submit = el("button", { text: hasQuestions ? "この方針で進める" : "この分け方で進める" });
    const skip = el("button", { class: hasQuestions ? "secondary" : "secondary hidden", text: "確認せずに進める", title: "依頼の内容のまま、こちらの判断で進めます" });
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
      if (!skipped && hasQuestions && answers.every((a) => a.option === undefined && !a.text)) {
        footer.textContent = "どれかを選ぶか、補足を書いてください(このまま進めるなら「確認せずに進める」)";
        return;
      }
      openClarify = null;
      disable(skipped ? "確認せずに進めました" : "この方針で進めました");
      const summary = skipped
        ? "確認せずに進める"
        : !hasQuestions
          ? "この分け方で進める"
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

  // ---------- 段階に分けた依頼 ----------

  const STAGE_NOTE = { unapplied: "(反映せずに進めた)", skipped: "(飛ばした)" };

  /** 段階の地図(済んだ・今の・残りの段階) */
  function stageList(stages) {
    const list = el("ol", { class: "step-map stage-map" });
    for (const st of stages) {
      const cls = st.status === "current" ? "current" : st.status === "todo" ? "todo" : st.status === "skipped" ? "skipped" : "done";
      const li = el("li", { class: cls, title: st.goal || "" }, document.createTextNode(`${st.label}${STAGE_NOTE[st.status] || ""}`));
      if (st.goal) {
        li.append(el("span", { class: "muted stage-goal", text: ` — ${st.goal}` }));
      }
      list.append(li);
    }
    return list;
  }

  /**
   * 依頼ごとの「次へ進む」操作(最新の1つ)。押したら処理が終わるまで止め、
   * 進めなかったとき(取り消し・エラー)は stageIdle で押せる状態に戻す。
   * @type {Map<string, { buttons: HTMLButtonElement[], note: HTMLElement }>}
   */
  const stageControls = new Map();

  function registerStageControl(campaignId, buttons, note) {
    settleStage(campaignId, "");
    stageControls.set(campaignId, { buttons, note });
    for (const b of buttons) {
      const onclick = b.onclick;
      b.onclick = (e) => {
        if (state.busy) {
          note.textContent = "前の処理が終わってから押してください";
          return;
        }
        buttons.forEach((x) => (x.disabled = true));
        note.textContent = "準備しています...";
        onclick && onclick.call(b, e);
      };
    }
  }

  /** 前の段階の操作を締める(次の段階が届いた・完成した) */
  function settleStage(campaignId, text) {
    const c = stageControls.get(campaignId);
    if (!c) {
      return;
    }
    c.buttons.forEach((b) => (b.disabled = true));
    c.note.textContent = text;
    stageControls.delete(campaignId);
  }

  function onStageIdle(m) {
    const c = stageControls.get(m.campaignId);
    if (c) {
      c.buttons.forEach((b) => (b.disabled = false));
      c.note.textContent = "";
    }
  }

  /** 段階を計画できなかった(中止・エラーを含む): 計画し直すか、飛ばして次へ */
  function renderStageBlocked(m) {
    settleStage(m.campaignId, "→ 続きは下に表示しました");
    const title = m.label ? `段階 ${m.index + 1}/${m.total}「${m.label}」を計画できませんでした` : "完成の確認を終えられませんでした";
    const { root, body } = card("clarify", title);
    body.append(el("div", { class: "warn", text: m.reason }));
    body.append(
      el(
        "div",
        { class: "muted" },
        document.createTextNode(
          m.canSkip
            ? "今のコードで調べ直して計画し直すか、この段階を飛ばして次へ進めます(飛ばした内容は、残りの段階を見直すときに扱います)。"
            : "もう一度、依頼全体が完成したかを確かめられます。",
        ),
      ),
    );
    const retry = el("button", { text: m.canSkip ? "この段階を計画し直す" : "もう一度確かめる" });
    retry.onclick = () => vscode.postMessage({ type: "stageRetry", campaignId: m.campaignId });
    const buttons = [retry];
    if (m.canSkip) {
      const skip = el("button", { class: "secondary", text: "飛ばして次へ" });
      skip.onclick = () => vscode.postMessage({ type: "stageSkip", campaignId: m.campaignId });
      buttons.push(skip);
    }
    const note = el("span", { class: "muted" });
    body.append(el("div", { class: "card-foot" }, ...buttons, note));
    registerStageControl(m.campaignId, buttons, note);
    append(root);
    scrollToStart(root);
  }

  /** 依頼全体の完成(または段階の上限に達した) */
  function renderCampaignDone(m) {
    settleStage(m.campaignId, "→ 完成を確かめました");
    const { root, body } = card("lesson", m.complete ? "依頼した変更が完成しました" : "段階の上限に達しました");
    if (m.understanding) {
      body.append(section("依頼", el("div", { class: "goal", text: m.understanding })));
    }
    if (m.reason) {
      body.append(el("div", { class: "muted", text: m.reason }));
    }
    body.append(section(`進めた段階(${m.stages.length})`, stageList(m.stages)));
    if (m.criteria && m.criteria.length > 0) {
      const list = el("ol", { class: "criteria" });
      m.criteria.forEach((c) => list.append(el("li", { text: c })));
      body.append(section("依頼全体の受け入れ条件(動かして確かめましょう)", list));
    }
    if (m.files.length > 0) {
      body.append(section(`変えたファイル(${m.files.length})`, el("div", { class: "overall", text: m.files.join("\n") })));
    }
    if (!m.complete && m.remaining.length > 0) {
      body.append(
        el("div", {
          class: "warn-box",
          text: `⚠ 1つの依頼で進める段階は${m.limit}までです。残りの段階:\n${m.remaining.map((r) => `・${r}`).join("\n")}\n続けるときは、残りの内容で依頼し直してください。`,
        }),
      );
    }
    if (m.stages.some((st) => st.status !== "applied")) {
      body.append(el("div", { class: "muted", text: "反映せずに進めた・飛ばした段階があります。ファイルの内容を確かめてください。" }));
    }
    append(root);
    scrollToStart(root);
  }

  // ---------- 実装の手順 ----------

  /** @type {Map<string, any>} */
  const lessons = new Map();

  /**
   * 変更の組み立て: エンジニアが要件から変更を考える順に並べる。
   * 要件の整理 → 目標の設定 → 実装するステップ(地図)を先に見せ、各ステップでは
   * 目的 → 約束の変化 → 変更するコード(場所のリンクと判断ポイント)→ 影響の予測 → 判断と根拠、の順にたどる。
   */
  function renderLesson(l) {
    const total = l.steps.length;
    const progressText = el("span", { class: "badge quiet" });
    const title = l.stage ? `変更の組み立て(段階 ${l.stage.index + 1}/${l.stage.total})` : "変更の組み立て";
    const { root, body } = card("lesson", title, el("span", { class: "spacer" }), progressText);
    const bar = el("div");
    body.append(el("div", { class: "progress", title: "進み具合" }, bar));
    const flow = chain();
    body.append(flow);
    if (l.stage) {
      settleStage(l.stage.campaignId, "→ 続きは下に表示しました");
      flow.append(
        thought(
          "依頼全体をどう分けたか",
          el("div", { class: "muted", text: `大きな依頼なので、${l.stage.total}段階に分けて1段階ずつ、依頼全体が完成するまで進めます。今回は${l.stage.index + 1}段階目です。` }),
          stageList(l.stage.roadmap),
        ).node,
      );
    }
    if (l.goal) {
      flow.append(thought("要件の整理", el("p", { class: "goal", text: l.goal })).node);
    }
    if (l.criteria && l.criteria.length > 0) {
      // 手順の途中でも見返せるよう、常に開いておく
      const list = el("ol", { class: "criteria" });
      l.criteria.forEach((c) => list.append(el("li", { text: c })));
      flow.append(thought("目標の設定", section(`${l.criteria.length}件(実装できたかを確かめる振る舞い)`, list)).node);
    }
    const map = el("ol", { class: "step-map" });
    const mapItems = l.steps.map((s) => {
      const li = el("li", { class: "todo", text: s.label });
      map.append(li);
      return li;
    });
    flow.append(thought("実装するステップ", map).node);
    const steps = el("div", { class: "lesson-steps" });
    flow.append(thought("1ステップずつ実装する", steps).node);
    const entry = { id: l.id, root, body, flow, steps, mapItems, bar, progressText, total, stepState: new Map(), final: null };
    lessons.set(l.id, entry);
    append(root);
    renderLessonStep(entry, l.step);
    // 届いたときは、要件の整理と実装するステップから読めるように先頭を見せる
    scrollToStart(root);
  }

  /** 進み具合。バーは確かめ終えたステップ数、文字は今いるステップの位置(done 番目まで終えて、次は done+1 番目) */
  function setProgress(entry, done) {
    entry.bar.style.width = `${Math.round((done / entry.total) * 100)}%`;
    entry.progressText.textContent = done >= entry.total ? "すべて確認済み" : `ステップ ${done + 1}/${entry.total}`;
  }

  function renderLessonStep(entry, s) {
    entry.mapItems.forEach((li, i) => (li.className = i < s.index ? "done" : i === s.index ? "current" : "todo"));
    setProgress(entry, s.index);
    // 読み終えた古いステップは閉じる(直前のステップは判断と根拠を読めるよう開いたまま)
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
      s.mechanical ? el("span", { class: "badge quiet", text: "定型の変更" }) : null,
    );
    const block = el("details", { class: "lesson-step" }, summary);
    block.open = true;
    const flow = chain();
    block.append(el("div", { class: "step-body" }, flow));

    if (s.why) {
      flow.append(thought("変更の理由", el("div", { class: "task", text: s.why })).node);
    }
    if (s.contract) {
      flow.append(thought("変わる仕様", el("div", { class: "contract", text: s.contract })).node);
    }
    const state = { answered: false, item: null, q: null, reveal: null, btn: null, block, summary };
    const how = thought(s.item ? "変更するコード" : "変更の内容");
    // 変更する場所へのリンクは、それぞれのコードのすぐ上に出す
    if (s.item) {
      const { block: itemBlock, state: itemState } = renderItem(s.item, () => state.answered, { noHead: true, link: fileLink(s.files[s.itemEdit]) });
      state.item = itemState;
      how.body.append(itemBlock);
    }
    // 答えが見えてしまうため差分を後に回した編集も、場所のリンクだけは出しておく
    const shown = new Set([s.itemEdit, ...s.diffs.map((d) => d.edit)]);
    const others = [
      ...s.diffs.flatMap((d) => [el("div", {}, fileLink(s.files[d.edit])), diffBlock(d.diff)]),
      ...s.files.flatMap((f, i) =>
        shown.has(i) ? [] : [el("div", {}, fileLink(f), el("span", { class: "muted", text: "(変更内容は「判断と根拠」で表示します)" }))],
      ),
    ];
    const otherCount = s.files.length - (s.item ? 1 : 0);
    if (otherCount > 0) {
      const label = s.item ? "このステップのほかの変更" : "このステップの変更";
      how.body.append(details(`${label}(${otherCount}件)`, others, !s.item));
    }
    if (how.body.childElementCount > 0) {
      flow.append(how.node);
    }
    if (s.question) {
      const set = el("fieldset", { class: "mcq next-check" }, el("legend", { text: "次に確認すべき場所" }), el("div", { text: s.question.prompt }));
      const name = `next-${entry.id}-${s.index}`;
      const labels = s.question.options.map((option, i) => {
        const input = el("input", { type: s.question.multi ? "checkbox" : "radio", name, value: String(i) });
        const label = el("label", {}, input, document.createTextNode(option));
        set.append(label);
        return { input, label };
      });
      if (s.question.hint) {
        const hint = el("div", { class: "hint-text hidden", text: `探し方の手がかり\n${s.question.hint}` });
        const hintBtn = el("button", { class: "link", text: "探し方の手がかり" });
        hintBtn.onclick = () => {
          hint.classList.remove("hidden");
          hintBtn.remove();
        };
        set.append(el("div", {}, hintBtn), hint);
      }
      const why = el("div", { class: "why" });
      set.append(why);
      state.q = { labels, why };
      flow.append(thought("影響はどこに及ぶか", set).node);
    }
    const reveal = thought("判断と根拠");
    reveal.node.classList.add("hidden");
    state.reveal = reveal;
    flow.append(reveal.node);
    const last = s.index + 1 >= s.total;
    const nothingToAnswer = !s.item && !s.question;
    const btn = el("button", {
      text: nothingToAnswer ? (last ? "確認してまとめへ" : "確認して次へ") : last ? "考えを確かめる" : "考えを確かめて次へ",
    });
    const warn = el("span", { class: "unanswered" });
    btn.onclick = () => {
      if (state.answered) {
        return;
      }
      const left = state.item ? state.item.picked.filter((p) => p < 0).length : 0;
      const noChoice = state.q && !state.q.labels.some((l) => l.input.checked);
      if ((left > 0 || noChoice) && !warn.textContent) {
        // 1回目は知らせるだけ。もう一度押せば選ばないまま確かめる
        warn.textContent = "まだ選んでいない判断があります(もう一度押すとこのまま確かめます)";
        return;
      }
      state.answered = true;
      btn.disabled = true;
      btn.textContent = "確かめています...";
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
    block.append(state.foot);
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

  /** 考えを確かめた後: エンジニアがこの変更をどう判断したか(変更の全体・影響の追い方と、その見つけ方) */
  function renderReveal(box, rv) {
    box.replaceChildren();
    if (rv.explanation) {
      box.append(el("div", { class: "explain", text: rv.explanation }));
    }
    if (rv.diffs.length > 0) {
      box.append(
        details(
          "このステップの変更を見る",
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
    box.append(section(`影響の追い方(どう見つけ、どう判断したか・${rv.checks.length}件)`, ...cards));
  }

  function onLessonStep(m) {
    const entry = lessons.get(m.lessonId);
    const state = entry && entry.stepState.get(m.index);
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
      state.q.why.textContent = r.question.correct ? "✓ 見立てが一致" : "✗ 見立てと異なる(下の「影響の追い方」で、見つけ方と判断を確かめましょう)";
    }
    renderReveal(state.reveal.body, r.reveal);
    state.reveal.node.classList.remove("hidden");
    state.foot.remove();
    state.block.classList.add("answered");
    state.summary.append(el("span", { class: "badge quiet", text: "✓ 確認済み" }));
    if (m.next) {
      renderLessonStep(entry, m.next);
    } else {
      entry.mapItems.forEach((li) => (li.className = "done"));
      setProgress(entry, entry.total);
    }
    if (m.final) {
      renderLessonFinal(entry, m.final);
    }
    // 選んだ場所で結果を確かめられるよう動かさない。判断と根拠・次のステップへは下へ読み進める
    hold();
  }

  function renderLessonFinal(entry, f) {
    const box = el("div", { class: "summary lesson-final" });
    box.append(el("div", { class: "summary-title", text: "変更の全体像" }));
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
    if (f.stage) {
      // 段階に分けた依頼: この段階を終えたら、依頼全体が完成するまで次の段階へ
      const s = f.stage;
      const next = el("button", { text: s.next ? `次の段階へ進む(${s.index + 2}/${s.total}: ${s.next})…` : "依頼全体が完成したか確かめる…" });
      next.title = "反映していなければ、反映して進むか、そのまま進むかを選べます";
      next.onclick = () => vscode.postMessage({ type: "stageNext", campaignId: s.campaignId });
      const note = el("span", { class: "muted" });
      box.append(
        el(
          "div",
          { class: "stage-next" },
          el("div", {
            class: "muted",
            text: s.next
              ? `段階 ${s.index + 1}/${s.total}「${s.label}」の変更をたどりました。反映したら、次の段階へ進みます。進む前に、依頼全体の受け入れ条件と見比べて残りの段階を見直します。`
              : `段階 ${s.index + 1}/${s.total}「${s.label}」の変更をたどりました。予定した段階はこれで最後です。依頼全体の受け入れ条件と見比べて、足りなければ段階を足して続けます。`,
          }),
          el("div", { class: "card-foot" }, next, note),
        ),
      );
      registerStageControl(s.campaignId, [next], note);
    }
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
        insertDraft(`テスト(${m.command})が失敗したので直したい: ${line.trim().slice(0, 200)}`);
      };
      f.testBox.append(el("div", { class: "row" }, fix));
    }
    ensureVisible(f.testBox);
  }

  // ---------- 入力補助(続きの候補・名前の補完・依頼を整える) ----------
  //
  // - 候補は入力欄に重ねた要素(#query-mirror)に薄い文字で描くだけで、入力の値には入れない(Enter は打った文だけを送る)
  // - 受け入れは Tab(全部)と Ctrl/Alt/⌘+→(1語ずつ)。execCommand で入れるので Ctrl+Z で戻せる。入れた部分は次に打つまで下線で示す
  // - IME の変換中・処理中・カーソルが末尾でないときは出さない。Esc で消した書きかけには出し直さない
  // - 続きの候補が無いときは、足すと伝わりやすくなることと「依頼を整える」を示す(API を使わない)

  const assist = {
    /** 候補を出したときの入力と、その続き(薄い文字) */
    base: "",
    ghost: "",
    /** "llm": 続きの候補 / "name": 名前の補完 */
    kind: "",
    /** 名前の補完で前方一致した名前 */
    names: /** @type {string[]} */ ([]),
    composing: false,
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    timer: undefined,
    reqId: 0,
    nameReqId: 0,
    refineId: 0,
    /** 続きの候補を求めて、まだ届いていない */
    waiting: false,
    /** Esc で消した書きかけ */
    dismissed: "",
    /** 直前に受け入れた範囲 */
    accepted: /** @type {{ start: number, end: number } | null} */ (null),
    /** 受け入れで入力欄を書き換えている間(input イベントを入力の変化として扱わない) */
    inserting: false,
    /** 送るまでに続きの候補を表示した・使った回数と、整えた依頼を入れたか(送るときにホストへ渡す) */
    shown: 0,
    used: 0,
    refined: false,
    /** 依頼を整えるの結果を待っている */
    refining: false,
  };

  const PART_LABEL = { location: "場所", behavior: "どうなってほしいか", condition: "どんなとき", scope: "変えないもの", target: "対象", viewpoint: "知りたいこと" };

  function caretAtEnd() {
    const len = queryInput.value.length;
    return queryInput.selectionStart === len && queryInput.selectionEnd === len;
  }

  /** 入力の内容と候補を重ねた要素に写す(入力欄の高さもこの要素で決まる) */
  function renderMirror() {
    const value = queryInput.value;
    const parts = [];
    const acc = assist.accepted;
    if (acc && acc.end <= value.length && acc.start < acc.end) {
      parts.push(
        document.createTextNode(value.slice(0, acc.start)),
        el("span", { class: "accepted", text: value.slice(acc.start, acc.end) }),
        document.createTextNode(value.slice(acc.end)),
      );
    } else {
      parts.push(document.createTextNode(value));
    }
    const show = !!assist.ghost && !assist.composing && !queryInput.disabled && document.activeElement === queryInput && caretAtEnd();
    if (show) {
      parts.push(el("span", { class: "ghost", text: assist.ghost }));
      parts.push(el("span", { class: "ghost-key", text: assist.kind === "name" && assist.names.length > 1 ? `Tab ・ 他${assist.names.length - 1}件` : "Tab" }));
    }
    // 末尾が改行のときも、その行の高さを取る
    parts.push(document.createTextNode("\u200b"));
    queryMirror.replaceChildren(...parts);
    queryMirror.scrollTop = queryInput.scrollTop;
  }

  function clearGhost() {
    assist.ghost = "";
    assist.kind = "";
    assist.names = [];
    renderMirror();
  }

  function hideAssistLine() {
    assistLine.replaceChildren();
    assistLine.classList.add("hidden");
  }

  /** 求めている続きの候補を取り消す(遅れて届いても使わない) */
  function cancelSuggest() {
    clearTimeout(assist.timer);
    assist.timer = undefined;
    if (assist.waiting) {
      assist.waiting = false;
      assist.reqId++;
      vscode.postMessage({ type: "suggestCancel" });
    }
  }

  function assistReady() {
    return !!state.assist && state.hasKey && state.hasWorkspace && !state.busy && !queryInput.disabled;
  }

  /** 入力が変わったとき: 打った文字が候補と同じなら候補を縮め、違えば消して、名前の補完か続きの候補を求める */
  function onDraftChanged() {
    if (assist.inserting) {
      return;
    }
    assist.accepted = null;
    const value = queryInput.value;
    if (!value.trim()) {
      // 書きかけを消した: この依頼で候補を表示した・使った数を数え直す
      assist.shown = 0;
      assist.used = 0;
      assist.refined = false;
    }
    if (assist.ghost) {
      const rest = A.consume(assist.base, assist.ghost, value);
      if (rest && caretAtEnd()) {
        assist.base = value;
        assist.ghost = rest;
        renderMirror();
        return;
      }
      if (rest === "" && assist.kind === "llm") {
        // 候補と同じ文を最後まで打った
        assist.used++;
      }
      assist.ghost = "";
      assist.kind = "";
      assist.names = [];
    }
    cancelSuggest();
    hideAssistLine();
    renderMirror();
    if (!assistReady() || assist.composing || !caretAtEnd()) {
      return;
    }
    const ident = state.assist.names ? A.identifierBefore(value, value.length) : undefined;
    if (ident) {
      // 名前を打っている途中は、続きの候補を求めない
      vscode.postMessage({ type: "completeName", id: ++assist.nameReqId, prefix: ident.prefix });
      return;
    }
    scheduleSuggest();
  }

  /** 入力が止まったら続きの候補を求める */
  function scheduleSuggest() {
    clearTimeout(assist.timer);
    const value = queryInput.value;
    // 「依頼を整える」のカードを開いている間は、そちらで決めているので続きの候補を出さない
    if (!state.assist.auto || A.meaningfulLength(value) < 5 || value === assist.dismissed || !assistBox.classList.contains("hidden")) {
      return;
    }
    assist.timer = setTimeout(() => {
      assist.timer = undefined;
      if (!assistReady() || !state.assist.auto || assist.composing || document.hidden || document.activeElement !== queryInput || !caretAtEnd() || queryInput.value !== value || !assistBox.classList.contains("hidden")) {
        return;
      }
      assist.waiting = true;
      vscode.postMessage({ type: "suggest", id: ++assist.reqId, draft: value, mode: modeSelect.value });
    }, state.assist.delayMs || 700);
  }

  function onSuggestion(m) {
    if (m.id !== assist.reqId) {
      return;
    }
    assist.waiting = false;
    const value = queryInput.value;
    if (!assistReady() || assist.composing || !caretAtEnd() || document.activeElement !== queryInput) {
      return;
    }
    // 届くまでに打った文字が候補の先頭と同じなら、その分を縮めて出す
    const ghost = m.completion ? (value === m.draft ? m.completion : A.consume(m.draft, m.completion, value) || "") : "";
    if (ghost) {
      assist.base = value;
      assist.ghost = ghost;
      assist.kind = "llm";
      assist.names = [];
      assist.shown++;
      renderMirror();
      assistSr.textContent = `続きの候補: ${ghost}(Tab で入れられます)`;
      return;
    }
    if (value === m.draft && Array.isArray(m.missing) && m.missing.length > 0) {
      showMissing(m.missing);
    }
  }

  /** 続きの候補が無いとき(詰まったとき): 足すと伝わりやすくなることと、「依頼を整える」を示す */
  function showMissing(missing) {
    const btn = el("button", { class: "link", text: "依頼を整える", title: "書きかけの依頼を、調査と計画に伝わりやすい形に整えます(Ctrl+Enter)" });
    btn.onclick = () => requestRefine();
    assistLine.replaceChildren(el("span", { text: `足すと伝わりやすくなること: ${missing.join("・")}` }), btn);
    assistLine.classList.remove("hidden");
  }

  function onNameCompletion(m) {
    if (m.id !== assist.nameReqId || !caretAtEnd()) {
      return;
    }
    const value = queryInput.value;
    const ident = A.identifierBefore(value, value.length);
    if (!ident || ident.prefix !== m.prefix) {
      return;
    }
    const names = Array.isArray(m.names) ? m.names : [];
    const g = A.nameGhost(m.prefix, names);
    assist.names = names.filter((n) => n.startsWith(m.prefix) && n !== m.prefix);
    if (g.text) {
      assist.base = value;
      assist.ghost = g.text;
      assist.kind = "name";
      assistSr.textContent = assist.names.length > 1 ? `名前の候補が${assist.names.length}件あります(下に並べました)` : `名前の候補: ${m.prefix}${g.text}(Tab で入れられます)`;
    }
    renderMirror();
    // 1つに決まらないときは選べるように並べる。大文字小文字まで一致するものが無いときは、コードらしい形の語のときだけ
    // (英語の普通の語で名前の候補が出続けないように)
    const codeLike = /[a-z][A-Z]|_|\$/.test(m.prefix) || m.prefix.length >= 5;
    if (assist.names.length > 1 || (assist.names.length === 0 && names.length > 0 && codeLike)) {
      showNameChoices(names, Number(m.total) || names.length, m.defs || {});
    }
    if (!g.text) {
      // 名前の補完が無ければ、ふつうに続きの候補を求める(英語の依頼で語の終わりに止まったときなど)
      scheduleSuggest();
    }
  }

  function showNameChoices(names, total, defs) {
    const row = el("span", { class: "name-choices" });
    for (const name of names) {
      const def = defs && defs[name];
      const b = el("button", { class: "name-chip", text: name, title: def ? `${def.path}:${def.line}` : "この名前を入れる" });
      // 入力欄のフォーカスを保つ
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.onclick = () => {
        // 並べたあとに打った文字があるかもしれないので、押したときの名前の範囲を取り直す
        const value = queryInput.value;
        const now = A.identifierBefore(value, value.length);
        if (!now || !name.toLowerCase().startsWith(now.prefix.toLowerCase())) {
          hideAssistLine();
          return;
        }
        assist.ghost = "";
        replaceRange(now.start, now.start + now.prefix.length, name, "name");
        clearGhost();
        hideAssistLine();
      };
      row.append(b);
    }
    assistLine.replaceChildren(el("span", { text: total > names.length ? `名前の候補(${total}件のうち${names.length}件):` : "名前の候補:" }), row);
    assistLine.classList.remove("hidden");
  }

  /** 入力欄の [start, end) を text にする。execCommand で入れて Ctrl+Z で戻せるようにする */
  function replaceRange(start, end, text, kind) {
    queryInput.focus();
    queryInput.setSelectionRange(start, end);
    assist.inserting = true;
    let done = false;
    try {
      done = document.execCommand("insertText", false, text);
    } catch {
      done = false;
    }
    if (!done) {
      queryInput.setRangeText(text, start, end, "end");
    }
    assist.inserting = false;
    assist.accepted = text ? { start, end: start + text.length } : null;
    if (kind === "name") {
      vscode.postMessage({ type: "nameAccepted" });
    } else if (kind === "llm") {
      assist.used++;
    }
    renderMirror();
  }

  /** 候補を受け入れる(all=false は1語だけ) */
  function acceptGhost(all) {
    const piece = all ? assist.ghost : A.nextSegment(assist.ghost);
    const rest = assist.ghost.slice(piece.length);
    const kind = assist.kind;
    const several = kind === "name" && assist.names.length > 1;
    const end = queryInput.value.length;
    assist.ghost = "";
    // 名前が複数あって共通の先頭だけを入れたときは、まだ名前を選び終えていない
    replaceRange(end, end, piece, several ? "" : kind);
    hideAssistLine();
    if (several) {
      const value = queryInput.value;
      const ident = A.identifierBefore(value, value.length);
      assist.kind = "";
      assist.names = [];
      if (ident) {
        vscode.postMessage({ type: "completeName", id: ++assist.nameReqId, prefix: ident.prefix });
      }
      renderMirror();
      return;
    }
    if (rest && !all) {
      assist.base = queryInput.value;
      assist.ghost = rest;
      assist.kind = kind;
    } else {
      assist.kind = "";
      assist.names = [];
    }
    renderMirror();
  }

  /** 入力欄に文を入れる(書きかけがあれば、消さずに次の行へ足す) */
  function insertDraft(text) {
    cancelSuggest();
    assist.ghost = "";
    clearGhost();
    hideAssistLine();
    const value = queryInput.value;
    if (value.trim()) {
      replaceRange(value.length, value.length, (value.endsWith("\n") ? "" : "\n") + text, "");
    } else {
      replaceRange(0, value.length, text, "");
    }
    assist.accepted = null;
    renderMirror();
  }

  function setQuery(text) {
    queryInput.value = text;
    assist.accepted = null;
    assist.dismissed = "";
    cancelSuggest();
    clearGhost();
    hideAssistLine();
  }

  // ---------- 依頼を整える ----------

  function closeRefine() {
    assistBox.replaceChildren();
    assistBox.classList.add("hidden");
  }

  /** 整えている途中なら取り消して(API の呼び出しも止める)、カードを閉じる */
  function cancelRefine() {
    if (assist.refining) {
      assist.refining = false;
      vscode.postMessage({ type: "refineCancel" });
    }
    assist.refineId++;
    closeRefine();
  }

  function refineCard(title) {
    const close = el("button", { class: "icon-btn", text: "×", title: "閉じる", "aria-label": "閉じる" });
    close.onclick = () => {
      cancelRefine();
      queryInput.focus();
    };
    const body = el("div", { class: "refine-body" });
    const root = el("div", { class: "refine-card" }, el("div", { class: "refine-head" }, el("strong", { text: title }), close), body);
    assistBox.replaceChildren(root);
    assistBox.classList.remove("hidden");
    return body;
  }

  function requestRefine() {
    const draft = queryInput.value.trim();
    if (!draft || queryInput.disabled) {
      return;
    }
    cancelSuggest();
    clearGhost();
    hideAssistLine();
    if (assist.refining) {
      vscode.postMessage({ type: "refineCancel" });
    }
    const id = ++assist.refineId;
    assist.refining = true;
    refineCard("依頼を整える").append(el("div", { class: "muted", text: "書きかけの依頼を、調査と計画に伝わりやすい形に整えています..." }));
    assistSr.textContent = "依頼を整えています";
    vscode.postMessage({ type: "refine", id, draft, mode: modeSelect.value });
  }

  /** 差の印(足した部分)と、決めることの〔 〕を付けて表示する(〔 〕は差の区切りをまたいでも1つにまとめる) */
  function refineText(draft, text) {
    /** @type {boolean[]} 文字ごとに、足した部分か */
    const added = [];
    for (const seg of A.diffSegments(draft, text)) {
      added.push(...Array.from(seg.text, () => seg.added));
    }
    const chars = Array.from(text);
    const nodes = [];
    let i = 0;
    for (const piece of text.split(/(〔[^〔〕]*〕)/)) {
      const len = Array.from(piece).length;
      if (!piece) {
        continue;
      }
      if (/^〔[^〔〕]*〕$/.test(piece)) {
        nodes.push(el("span", { class: "slot", text: piece }));
      } else {
        // 足した部分ごとにまとめて印を付ける
        let start = i;
        while (start < i + len) {
          let end = start;
          while (end < i + len && added[end] === added[start]) {
            end++;
          }
          const run = chars.slice(start, end).join("");
          nodes.push(added[start] ? el("mark", { class: "added", text: run }) : document.createTextNode(run));
          start = end;
        }
      }
      i += len;
    }
    return nodes;
  }

  function onRefined(m) {
    if (m.id !== assist.refineId) {
      return;
    }
    assist.refining = false;
    if (m.error || !m.proposal) {
      refineCard("依頼を整える").append(el("div", { class: "warn-box", text: m.error || "依頼を整えられませんでした。" }));
      assistSr.textContent = m.error || "依頼を整えられませんでした";
      return;
    }
    assistSr.textContent = "伝わりやすい依頼の案を、入力欄の上に出しました";
    const p = m.proposal;
    const body = refineCard("伝わりやすい依頼の案");
    /** @type {Array<{ text: string } | undefined>} */
    const answers = p.questions.map(() => undefined);
    const preview = el("div", { class: "refine-text" });
    const update = () => preview.replaceChildren(...refineText(m.draft, A.composeInstruction(p.instruction, p.questions, answers, true, p.intent)));
    update();
    body.append(preview);
    if (p.parts.length > 0) {
      const parts = el("div", { class: "refine-parts" }, el("span", { class: "muted", text: "補ったこと:" }));
      for (const part of p.parts) {
        parts.append(el("span", { class: "part-chip", title: part.text }, el("strong", { text: PART_LABEL[part.kind] || part.kind }), document.createTextNode(` ${part.text}`)));
      }
      body.append(parts);
    }
    if (p.nameRefs && p.nameRefs.length > 0) {
      // 補った名前は、定義を開いて確かめられるようにする(知らない名前をそのまま受け入れないため)
      const refs = el("div", { class: "refine-parts" }, el("span", { class: "muted", text: "補った名前(開いて確かめられます):" }));
      for (const r of p.nameRefs) {
        refs.append(codeLink(r.path, r.line, `${r.name}(${r.path}:${r.line})`));
      }
      body.append(refs);
    }
    if (p.unknownNames.length > 0) {
      body.append(el("div", { class: "warn-box", text: `コードで見つからなかった名前: ${p.unknownNames.join(", ")}(確かめてから使ってください)` }));
    }
    p.questions.forEach((q, qi) => {
      const set = el("fieldset", { class: "mcq clarify-q" }, el("legend", { text: `決めること ${qi + 1}` }), el("div", { class: "clarify-question", text: q.question }));
      const name = `refine-${m.id}-${qi}`;
      const note = el("input", { type: "text", class: "clarify-note", placeholder: "その他(自由に書く)" });
      const pick = (text) => {
        answers[qi] = text ? { text } : undefined;
        update();
      };
      q.options.forEach((o) => {
        const input = el("input", { type: "radio", name });
        input.addEventListener("change", () => {
          note.value = "";
          pick(o.fill);
        });
        const label = el("span", { class: "clarify-option" }, el("strong", { text: o.label }), o.fill !== o.label ? el("span", { class: "muted", text: o.fill }) : null);
        set.append(el("label", {}, input, label));
      });
      const later = el("input", { type: "radio", name });
      later.checked = true;
      later.addEventListener("change", () => {
        note.value = "";
        pick("");
      });
      // 読み解きの質問には送ったあとの確認が無いので、答えなければ文から外して、流れ・呼び出し元を中心に調べる
      const laterLabel = p.intent === "read" ? ["おまかせ", "流れ・呼び出し元を中心に調べます"] : ["まだ決めない", "調べたあとの確認で決めます"];
      set.append(el("label", {}, later, el("span", { class: "clarify-option" }, el("strong", { text: laterLabel[0] }), el("span", { class: "muted", text: laterLabel[1] }))));
      note.addEventListener("input", () => {
        later.checked = !note.value.trim();
        set.querySelectorAll("input[type=radio]").forEach((r) => {
          if (r !== later && note.value.trim()) {
            /** @type {HTMLInputElement} */ (r).checked = false;
          }
        });
        pick(note.value.trim());
      });
      set.append(note);
      body.append(set);
    });
    const insert = el("button", { text: "入力欄に入れる" });
    let confirmed = false;
    insert.onclick = () => {
      // 案を出したあとに入力欄を書き換えていたら、置き換える前に一度知らせる
      if (!confirmed && queryInput.value.trim() !== m.draft) {
        confirmed = true;
        footNote.textContent = "案を出したあとに入力欄が変わっています。もう一度押すと今の入力を置き換えます(Ctrl+Z で戻せます)。";
        footNote.classList.add("warn");
        return;
      }
      cancelSuggest();
      assist.ghost = "";
      clearGhost();
      hideAssistLine();
      const text = A.composeInstruction(p.instruction, p.questions, answers, false, p.intent);
      replaceRange(0, queryInput.value.length, text, "refine");
      assist.accepted = null;
      assist.refined = true;
      closeRefine();
      renderMirror();
    };
    const close = el("button", { class: "secondary", text: "閉じる" });
    close.onclick = () => {
      closeRefine();
      queryInput.focus();
    };
    const footNote = el("span", { class: "muted", text: "入れたあとも書き直せます。Ctrl+Z で元に戻せます。" });
    body.append(el("div", { class: "card-foot" }, insert, close, footNote));
  }

  function renderAssistStats(st) {
    const box = $("assist-stats");
    box.classList.toggle("hidden", !st);
    if (!st) {
      return;
    }
    const avg = (sum, n) => (n > 0 ? (sum / n).toFixed(1) : "-");
    const reasons = Object.entries(st.suppressed || {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    const u = st.usage || { calls: 0, estimated: 0, actual: 0, output: 0 };
    box.textContent = [
      `入力補助の記録: 続きの候補 表示 ${st.shown} / 使用 ${st.accepted}・名前の補完 ${st.names}・依頼を整える ${st.refined}(入れた ${st.refineUsed})`,
      `送った依頼 ${st.sends}(補助あり ${st.assistedSends})・名前を含む 補助あり ${st.namedAssisted} / なし ${st.namedUnassisted}`,
      `調査の平均回数 補助あり ${avg(st.stepsAssisted, st.investigatedAssisted)} / なし ${avg(st.stepsUnassisted, st.investigatedUnassisted)}・要件の確認 ${st.clarifiedAssisted} / ${st.clarifiedUnassisted}・見つからず ${st.notFoundAssisted} / ${st.notFoundUnassisted}`,
      `出さなかった理由: ${reasons || "なし"}`,
      `入力補助の API: ${u.calls}回 / 入力 ${u.actual > 0 ? `${u.actual.toLocaleString()}(実測、うちキャッシュ ${(u.cached || 0).toLocaleString()})` : `約${u.estimated.toLocaleString()}`} / 出力 ${u.output.toLocaleString()} トークン`,
    ].join("\n");
  }

  queryInput.addEventListener("compositionstart", () => {
    assist.composing = true;
    cancelSuggest();
    renderMirror();
  });
  queryInput.addEventListener("compositionend", () => {
    assist.composing = false;
    onDraftChanged();
  });
  queryInput.addEventListener("input", (e) => {
    if (assist.composing || /** @type {InputEvent} */ (e).isComposing) {
      renderMirror();
      return;
    }
    onDraftChanged();
  });
  for (const type of ["keyup", "click", "focus", "blur", "select"]) {
    queryInput.addEventListener(type, () => renderMirror());
  }
  queryInput.addEventListener("scroll", () => {
    queryMirror.scrollTop = queryInput.scrollTop;
  });
  modeSelect.addEventListener("change", () => {
    cancelSuggest();
    clearGhost();
    hideAssistLine();
  });
  refineBtn.addEventListener("click", () => requestRefine());

  // ---------- 入出力 ----------

  function send() {
    const text = queryInput.value.trim();
    if (!text || queryInput.disabled) {
      return;
    }
    closeClarify("(新しい質問をしたため無効になりました)");
    cancelRefine();
    addMessage("user", text);
    const used = { shown: assist.shown, accepted: assist.used, refined: assist.refined };
    assist.shown = 0;
    assist.used = 0;
    assist.refined = false;
    setQuery("");
    vscode.postMessage({ type: "ask", query: text, mode: modeSelect.value, assist: used });
  }

  sendBtn.addEventListener("click", send);
  queryInput.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) {
      return;
    }
    const ghostShown = !!assist.ghost && caretAtEnd();
    if (e.key === "Tab" && ghostShown && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      acceptGhost(true);
      return;
    }
    if (e.key === "ArrowRight" && ghostShown && (e.ctrlKey || e.altKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      acceptGhost(false);
      return;
    }
    if (e.key === "Escape" && (assist.ghost || !assistLine.classList.contains("hidden"))) {
      e.preventDefault();
      assist.dismissed = queryInput.value;
      cancelSuggest();
      clearGhost();
      hideAssistLine();
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      requestRefine();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
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
      case "stageIdle":
        onStageIdle(m);
        break;
      case "stageBlocked":
        setLive("");
        renderStageBlocked(m);
        break;
      case "campaignDone":
        setLive("");
        renderCampaignDone(m);
        break;
      case "suggestion":
        onSuggestion(m);
        break;
      case "nameCompletion":
        onNameCompletion(m);
        break;
      case "refined":
        onRefined(m);
        break;
    }
  });

  renderEmptyHint();
  renderMirror();
  vscode.postMessage({ type: "ready" });
})();
