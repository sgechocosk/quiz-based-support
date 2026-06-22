import * as vscode from "vscode";
import { WorkspaceVectorSearchService } from "./WorkspaceVectorSearchService";

export class ChatSidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private readonly _vectorService: WorkspaceVectorSearchService;

  constructor(private readonly _context: vscode.ExtensionContext) {
    this._vectorService = new WorkspaceVectorSearchService(_context);
    this._context.secrets.onDidChange((e) => {
      if (e.key === "openai-api-key") {
        void this.syncState();
      }
    });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context.extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview();
    void this.syncState();

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case "searchQuery":
          await this.handleSearchQuery(data.value);
          break;
        case "requestSetApiKey":
          vscode.commands.executeCommand("quiz-based-support.setApiKey");
          break;
        case "requestScan":
          await this.handleScan();
          break;
        case "confirmBuildIndex":
          await this.handleBuildIndex();
          break;
        case "applyCorrectCode":
          await this.handleApplyCorrectCode(data.change);
          break;
      }
    });
  }

  private async syncState() {
    const apiKey = await this._context.secrets.get("openai-api-key");
    if (!apiKey) {
      this._view?.webview.postMessage({
        type: "state",
        value: "require-api-key",
      });
      return;
    }

    try {
      const status = await this._vectorService.getStatus();
      if (status.ready) {
        this._view?.webview.postMessage({
          type: "state",
          value: "ready",
          message: await this._vectorService.getReadyMessage(),
        });
      } else {
        this._view?.webview.postMessage({
          type: "state",
          value: "require-scan",
        });
      }
    } catch (error) {
      this._view?.webview.postMessage({
        type: "error",
        value:
          error instanceof Error ? error.message : "状態取得に失敗しました。",
      });
    }
  }

  private async handleScan() {
    this._view?.webview.postMessage({
      type: "status",
      value: "ワークスペースをスキャン中...",
    });
    try {
      const summary = await this._vectorService.prepareIndexSummary(true);
      this._view?.webview.postMessage({
        type: "scanResult",
        summary: `ワークスペースから ${summary.files} ファイル、${summary.chunks} チャンク、約 ${summary.tokens} トークンを抽出します。`,
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: "error",
        value:
          error instanceof Error ? error.message : "スキャンに失敗しました。",
      });
    }
  }

  private async handleSearchQuery(query: string) {
    this._view?.webview.postMessage({
      type: "status",
      value: "コードを検索中...",
    });
    try {
      const results = await this._vectorService.search(query);

      this._view?.webview.postMessage({
        type: "status",
        value: "変更案を分析中...",
      });
      const analysis = await this._vectorService.analyzeAndSuggest(
        query,
        results,
      );
      const formatted = this._vectorService.formatAnalysisResult(analysis);

      this._view?.webview.postMessage({ type: "result", value: formatted });
    } catch (error) {
      this._view?.webview.postMessage({
        type: "error",
        value:
          error instanceof Error
            ? error.message
            : "検索中にエラーが発生しました。",
      });
    }
  }

  private async handleBuildIndex() {
    try {
      const customProgress = {
        report: (value: { message?: string }) => {
          if (value.message) {
            this._view?.webview.postMessage({
              type: "status",
              value: value.message,
            });
          }
        },
      };

      await this._vectorService.buildIndex(true, customProgress);
      void this.syncState();
    } catch (error) {
      this._view?.webview.postMessage({
        type: "error",
        value:
          error instanceof Error ? error.message : "ベクトル化に失敗しました。",
      });
    }
  }

  private async handleApplyCorrectCode(
    change: import("./WorkspaceVectorSearchService").CodeChange,
  ) {
    try {
      await this._vectorService.applyCorrectCode(change);
      this._view?.webview.postMessage({
        type: "status",
        value: `✅ ${change.targetFilePath} の ${change.startLine}〜${change.endLine} 行目に正解コードを反映しました。`,
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: "error",
        value:
          error instanceof Error
            ? error.message
            : "コードの反映に失敗しました。",
      });
    }
  }

  private _getHtmlForWebview() {
    const script = this._getScriptContent();
    const style = this._getStyleContent();

    return (
      "<!DOCTYPE html>" +
      '<html lang="ja">' +
      "<head>" +
      '<meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
      "<style>" +
      style +
      "</style>" +
      "</head>" +
      "<body>" +
      '<div id="chat-container">' +
      '<div id="top-actions">' +
      '<button id="setup-btn">API Key</button>' +
      '<button id="scan-btn">ベクトル化</button>' +
      "</div>" +
      '<div id="index-actions">' +
      '<div id="index-summary" class="message notice-msg"></div>' +
      '<button id="index-btn">確定して実行</button>' +
      "</div>" +
      '<div id="messages"></div>' +
      '<div id="input-container">' +
      '<input type="text" id="query-input" placeholder="準備中..." disabled />' +
      '<button id="send-btn" disabled>送信</button>' +
      "</div>" +
      "</div>" +
      "<script>" +
      script +
      "</script>" +
      "</body>" +
      "</html>"
    );
  }

  private _getStyleContent(): string {
    return [
      "html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }",
      "body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); }",
      "#chat-container { display: flex; flex-direction: column; height: 100%; padding: 10px; box-sizing: border-box; }",
      "#messages { flex-grow: 1; overflow-y: auto; margin-bottom: 10px; display: flex; flex-direction: column; gap: 8px; padding-right: 4px; }",
      ".message { padding: 8px; border-radius: 6px; font-size: 13px; line-height: 1.4; word-wrap: break-word; white-space: pre-wrap; }",
      ".user-msg { background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); align-self: flex-end; max-width: 85%; }",
      ".bot-msg { background-color: var(--vscode-editor-inactiveSelectionBackground); align-self: flex-start; max-width: 95%; }",
      ".error-msg { color: var(--vscode-errorForeground); }",
      ".notice-msg { background: var(--vscode-editorHoverWidget-background); border: 1px solid var(--vscode-editorHoverWidget-border); align-self: stretch; max-width: 100%; }",
      "#input-container { display: flex; gap: 5px; flex-shrink: 0; }",
      'input[type="text"] { flex-grow: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 6px; border-radius: 4px; outline: none; }',
      'input[type="text"]:focus { border-color: var(--vscode-focusBorder); }',
      "button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid rgba(255, 255, 255, 0.2); padding: 6px 12px; border-radius: 4px; cursor: pointer; flex-shrink: 0; filter: brightness(1.2); }",
      "button:hover { filter: brightness(1.35); }",
      "button:disabled, input:disabled { opacity: 0.5; cursor: not-allowed; }",
      "#top-actions { display: flex; gap: 8px; margin-bottom: 10px; flex-shrink: 0; }",
      "#top-actions button { flex: 1; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }",
      "#index-actions { display: none; flex-direction: column; gap: 8px; padding: 8px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; margin-bottom: 10px; }",
      "#index-actions.visible { display: flex; }",
      ".quiz-blank { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 2px 6px; margin: 0 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 0.95em; }",
      ".quiz-blank.correct { border-color: #4caf50; background: rgba(76, 175, 80, 0.15); }",
      ".quiz-blank.incorrect { border-color: #f44336; background: rgba(244, 67, 54, 0.15); }",
      ".grade-btn { margin-top: 6px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); width: 100%; }",
      ".grade-result { font-size: 12px; margin-top: 4px; color: var(--vscode-foreground); opacity: 0.8; }",
      ".quiz-block { margin: 4px 0; }",
      ".quiz-code-line { padding: 1px 8px; font-family: var(--vscode-editor-font-family); font-size: 0.9em; opacity: 0.5; }",
      ".quiz-row { border-left: 3px solid var(--vscode-focusBorder); padding: 6px 8px; margin: 6px 0; border-radius: 0 4px 4px 0; background: var(--vscode-editor-inactiveSelectionBackground); }",
      ".quiz-hint { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }",
      ".quiz-line-pre { margin: 2px 0; padding: 4px 8px; background: var(--vscode-textCodeBlock-background); border-radius: 3px; overflow-x: auto; white-space: pre; }",
      ".quiz-row-result { font-size: 12px; margin-top: 4px; min-height: 16px; }",
      ".result-correct { color: #4caf50; }",
      ".result-incorrect { color: #f44336; }",
      ".result-correct code, .result-incorrect code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family); }",
    ].join("\n");
  }

  private _getScriptContent(): string {
    return [
      "const vscode = acquireVsCodeApi();",
      "const messagesDiv = document.getElementById('messages');",
      "const input = document.getElementById('query-input');",
      "const sendBtn = document.getElementById('send-btn');",
      "const indexActions = document.getElementById('index-actions');",
      "const indexSummary = document.getElementById('index-summary');",
      "",
      // _getScriptContent() の配列を以下に差し替え
      "function gradeQuiz(btn) {",
      "  const msgDiv = btn.closest('.message');",
      "  const rows = msgDiv.querySelectorAll('.quiz-row');",
      "  let correct = 0;",
      "  rows.forEach(function(row) {",
      "    const inp = row.querySelector('.quiz-blank');",
      "    const resultDiv = row.querySelector('.quiz-row-result');",
      "    const userAnswer = inp.value.trim();",
      "    const correctAnswer = inp.dataset.answer || '';",
      "    const normalize = function(s) { return s.trim().replace(/;$/, '').replace(/\\s+/g, ' '); };",
      "    const isCorrect = normalize(userAnswer) === normalize(correctAnswer);",
      "    inp.classList.remove('correct', 'incorrect');",
      "    inp.classList.add(isCorrect ? 'correct' : 'incorrect');",
      // 正解・不正解どちらもユーザー入力と正解を両方表示
      "    if (isCorrect) {",
      "      resultDiv.innerHTML = '<span class=\"result-correct\">正解！　あなたの回答: <code>' + userAnswer + '</code></span>';",
      "    } else {",
      "      resultDiv.innerHTML = '<span class=\"result-incorrect\">不正解　あなたの回答: <code>' + (userAnswer || '(未入力)') + '</code>　正解: <code>' + correctAnswer + '</code></span>';",
      "    }",
      "    if (isCorrect) correct++;",
      "  });",
      "  const totalDiv = btn.nextElementSibling;",
      "  totalDiv.textContent = '結果: ' + rows.length + '問中 ' + correct + '問正解 (' + Math.round(correct / rows.length * 100) + '%)';",
      "  btn.disabled = true;",
      "  btn.textContent = '採点済み';",
      "  const metaRaw = btn.dataset.meta;",
      "  if (metaRaw) {",
      "    try {",
      "      const meta = JSON.parse(decodeURIComponent(metaRaw));",
      "      const answers = [];",
      "      const msgDiv = btn.closest('.message');",
      "      msgDiv.querySelectorAll('.quiz-blank').forEach(function(inp) {",
      "        answers.push(inp.dataset.answer || '');",
      "      });",
      "      const applyBtn = document.createElement('button');",
      "      applyBtn.className = 'grade-btn apply-btn';",
      "      applyBtn.textContent = '正解コードをファイルに反映';",
      "      applyBtn.onclick = function() {",
      "        applyBtn.disabled = true;",
      "        applyBtn.textContent = '反映中...';",
      "        vscode.postMessage({",
      "          type: 'applyCorrectCode',",
      "          change: { ...meta, answers: answers }",
      "        });",
      "      };",
      "      btn.parentNode.insertBefore(applyBtn, btn.nextSibling);",
      "    } catch(e) {}",
      "  }",
      "}",
      "",
      "function formatTextToHtml(text) {",
      "  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');",
      "",
      "  let meta = null;",
      "  const mMatch = escaped.match(/___QUIZ_META___(.*?)___QUIZ_META___/);",
      "  if (mMatch) { try { meta = JSON.parse(mMatch[1]); } catch(e) {} }",
      "",
      "  let answers = [];",
      "  const aMatch = escaped.match(/___QUIZ_ANSWERS___(.*?)___QUIZ_ANSWERS___/);",
      "  if (aMatch) { try { answers = JSON.parse(aMatch[1]); } catch(e) {} }",
      "",
      "  let hints = [];",
      "  const hMatch = escaped.match(/___QUIZ_HINTS___(.*?)___QUIZ_HINTS___/);",
      "  if (hMatch) { try { hints = JSON.parse(hMatch[1]); } catch(e) {} }",
      "",
      "  let cleaned = escaped",
      "    .replace(/___QUIZ_ANSWERS___.*?___QUIZ_ANSWERS___\\n?/g, '')",
      "    .replace(/___QUIZ_HINTS___.*?___QUIZ_HINTS___\\n?/g, '')",
      "    .replace(/___QUIZ_META___.*?___QUIZ_META___\\n?/g, '');",
      "",
      "  const codeBlockRegex = new RegExp('(' + '`'.repeat(3) + '[\\\\s\\\\S]*?' + '`'.repeat(3) + ')', 'g');",
      "  const parts = cleaned.split(codeBlockRegex);",
      "",
      "  let blankIndex = 0;",
      "  const htmlParts = parts.map(function(part) {",
      "    const fence = '`'.repeat(3);",
      "    if (part.startsWith(fence) && part.endsWith(fence)) {",
      "      const code = part.slice(3, -3).replace(/^\\n/, '');",
      "      const lines = code.split('\\n');",
      // BLANK行ごとにヒント→入力欄の「quiz-row」を生成
      "      const rowsHtml = lines.map(function(line) {",
      "        if (line.indexOf('___BLANK___') === -1) {",
      "          return '<div class=\"quiz-code-line\"><code>' + line + '</code></div>';",
      "        }",
      "        const hint = hints[blankIndex] || '';",
      "        const answer = answers[blankIndex] || '';",
      "        const escapedAnswer = answer.replace(/\"/g, '&quot;');",
      "        const width = Math.max(100, Math.min(320, answer.length * 9 + 40));",
      "        blankIndex++;",
      "        const inputHtml = line.replace('___BLANK___',",
      '          \'<input type="text" class="quiz-blank" placeholder="???" data-answer="\' + escapedAnswer + \'" style="width:\' + width + \'px">\'',
      "        );",
      "        return '<div class=\"quiz-row\">'",
      "          + (hint ? '<div class=\"quiz-hint\">' + hint + '</div>' : '')",
      "          + '<pre class=\"quiz-line-pre\"><code>' + inputHtml + '</code></pre>'",
      "          + '<div class=\"quiz-row-result\"></div>'",
      "          + '</div>';",
      "      }).join('');",
      "      return '<div class=\"quiz-block\">' + rowsHtml + '</div>';",
      "    } else {",
      "      return part.replace(/\\n/g, '<br>');",
      "    }",
      "  }).join('');",
      "",
      "  if (answers.length > 0) {",
      "    const metaAttr = meta ? ' data-meta=\\''+encodeURIComponent(JSON.stringify(meta)).replace(/'/g, '%27')+'\\'' : '';",
      "    return htmlParts",
      "      + '<button class=\"grade-btn\" onclick=\"gradeQuiz(this)\"' + metaAttr + '>解答チェック (' + answers.length + '問)</button>'",
      "      + '<div class=\"grade-result\"></div>';",
      "  }",

      "  return htmlParts;",
      "}",
      "",
      "function addMessage(text, className) {",
      "  const msgDiv = document.createElement('div');",
      "  msgDiv.className = 'message ' + className;",
      "  if (className === 'bot-msg') {",
      "    msgDiv.innerHTML = formatTextToHtml(text);",
      "  } else {",
      "    msgDiv.textContent = text;",
      "  }",
      "  messagesDiv.appendChild(msgDiv);",
      "  messagesDiv.scrollTop = messagesDiv.scrollHeight;",
      "}",
      "",
      "function setInputState(enabled, placeholder) {",
      "  input.disabled = !enabled;",
      "  sendBtn.disabled = !enabled;",
      "  input.placeholder = placeholder;",
      "}",
      "",
      "document.getElementById('send-btn').addEventListener('click', function() {",
      "  const text = input.value.trim();",
      "  if (text) {",
      "    addMessage(text, 'user-msg');",
      "    input.value = '';",
      "    vscode.postMessage({ type: 'searchQuery', value: text });",
      "  }",
      "});",
      "",
      "document.getElementById('setup-btn').addEventListener('click', function() {",
      "  vscode.postMessage({ type: 'requestSetApiKey' });",
      "});",
      "",
      "document.getElementById('scan-btn').addEventListener('click', function() {",
      "  vscode.postMessage({ type: 'requestScan' });",
      "});",
      "",
      "document.getElementById('index-btn').addEventListener('click', function() {",
      "  vscode.postMessage({ type: 'confirmBuildIndex' });",
      "});",
      "",
      "input.addEventListener('keypress', function(e) {",
      "  if (e.key === 'Enter') sendBtn.click();",
      "});",
      "",
      "window.addEventListener('message', function(event) {",
      "  const message = event.data;",
      "  switch (message.type) {",
      "    case 'state':",
      "      if (message.value === 'require-api-key') {",
      "        addMessage('APIキーが未設定です。API Keyボタンから設定してください。', 'bot-msg');",
      "        setInputState(false, 'APIキーを設定してください...');",
      "        indexActions.classList.remove('visible');",
      "      } else if (message.value === 'require-scan') {",
      "        addMessage('APIキーを確認しました。上部のベクトル化ボタンを押してスキャンを開始してください。', 'bot-msg');",
      "        setInputState(false, 'スキャンを行ってください...');",
      "        indexActions.classList.remove('visible');",
      "      } else if (message.value === 'ready') {",
      "        addMessage(message.message || '準備完了です。コードの機能や役割を入力してください。', 'bot-msg');",
      "        setInputState(true, '例: ログイン処理のコードは？');",
      "        indexActions.classList.remove('visible');",
      "      }",
      "      break;",
      "    case 'scanResult':",
      "      setInputState(false, '承認待ち...');",
      "      indexSummary.textContent = message.summary;",
      "      indexActions.classList.add('visible');",
      "      addMessage('スキャンが完了しました。トークン数を確認し、よろしければ確定して実行ボタンを押してください。', 'bot-msg');",
      "      break;",
      "    case 'result':",
      "    case 'status':",
      "      addMessage(message.value, 'bot-msg');",
      "      break;",
      "    case 'error':",
      "      addMessage('エラー: ' + message.value, 'error-msg');",
      "      break;",
      "  }",
      "});",
    ].join("\n");
  }
}
