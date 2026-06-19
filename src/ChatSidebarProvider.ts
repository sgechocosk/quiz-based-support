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
      const formatted = this._vectorService.formatSearchResults(query, results);
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

  private _getHtmlForWebview() {
    return `
      <!DOCTYPE html>
      <html lang="ja">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
              html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
              body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
              #chat-container { display: flex; flex-direction: column; height: 100%; padding: 10px; box-sizing: border-box; }
              #messages { flex-grow: 1; overflow-y: auto; margin-bottom: 10px; display: flex; flex-direction: column; gap: 8px; padding-right: 4px; }
              .message { padding: 8px; border-radius: 6px; font-size: 13px; line-height: 1.4; word-wrap: break-word; white-space: pre-wrap; }
              .user-msg { background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); align-self: flex-end; max-width: 85%; }
              .bot-msg { background-color: var(--vscode-editor-inactiveSelectionBackground); align-self: flex-start; max-width: 95%; }
              .error-msg { color: var(--vscode-errorForeground); }
              .notice-msg { background: var(--vscode-editorHoverWidget-background); border: 1px solid var(--vscode-editorHoverWidget-border); align-self: stretch; max-width: 100%; }
              #input-container { display: flex; gap: 5px; flex-shrink: 0; }
              input { flex-grow: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 6px; border-radius: 4px; outline: none; }
              input:focus { border-color: var(--vscode-focusBorder); }
              
              button { 
                  background: var(--vscode-button-background); 
                  color: var(--vscode-button-foreground); 
                  border: 1px solid rgba(255, 255, 255, 0.2); 
                  padding: 6px 12px; 
                  border-radius: 4px; 
                  cursor: pointer; 
                  flex-shrink: 0; 
                  filter: brightness(1.2); /* 背景と同化を防ぐため明度を上げる */
              }
              button:hover { filter: brightness(1.35); }
              button:disabled, input:disabled { opacity: 0.5; cursor: not-allowed; }
              
              #top-actions { display: flex; gap: 8px; margin-bottom: 10px; flex-shrink: 0; }
              #top-actions button { flex: 1; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
              #index-actions { display: none; flex-direction: column; gap: 8px; padding: 8px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; margin-bottom: 10px; }
              #index-actions.visible { display: flex; }
          </style>
      </head>
      <body>
          <div id="chat-container">
              <div id="top-actions">
                  <button id="setup-btn">API Key</button>
                  <button id="scan-btn">ベクトル化</button>
              </div>
              <div id="index-actions">
                  <div id="index-summary" class="message notice-msg"></div>
                  <button id="index-btn">確定して実行</button>
              </div>
              <div id="messages"></div>
              <div id="input-container">
                  <input type="text" id="query-input" placeholder="準備中..." disabled />
                  <button id="send-btn" disabled>送信</button>
              </div>
          </div>

          <script>
              const vscode = acquireVsCodeApi();
              const messagesDiv = document.getElementById('messages');
              const input = document.getElementById('query-input');
              const sendBtn = document.getElementById('send-btn');
              const indexActions = document.getElementById('index-actions');
              const indexSummary = document.getElementById('index-summary');

              function addMessage(text, className) {
                  const msgDiv = document.createElement('div');
                  msgDiv.className = 'message ' + className;
                  msgDiv.textContent = text;
                  messagesDiv.appendChild(msgDiv);
                  messagesDiv.scrollTop = messagesDiv.scrollHeight;
              }

              function setInputState(enabled, placeholder) {
                  input.disabled = !enabled;
                  sendBtn.disabled = !enabled;
                  input.placeholder = placeholder;
              }

              document.getElementById('send-btn').addEventListener('click', () => {
                  const text = input.value.trim();
                  if (text) {
                      addMessage(text, 'user-msg');
                      input.value = '';
                      vscode.postMessage({ type: 'searchQuery', value: text });
                  }
              });

              document.getElementById('setup-btn').addEventListener('click', () => {
                  vscode.postMessage({ type: 'requestSetApiKey' });
              });

              document.getElementById('scan-btn').addEventListener('click', () => {
                  vscode.postMessage({ type: 'requestScan' });
              });

              document.getElementById('index-btn').addEventListener('click', () => {
                  vscode.postMessage({ type: 'confirmBuildIndex' });
              });

              window.addEventListener('message', event => {
                  const message = event.data;
                  switch (message.type) {
                      case 'state':
                          if (message.value === 'require-api-key') {
                              addMessage('APIキーが未設定です。API Keyボタンから設定してください。', 'bot-msg');
                              setInputState(false, 'APIキーを設定してください...');
                              indexActions.classList.remove('visible');
                          } else if (message.value === 'require-scan') {
                              addMessage('APIキーを確認しました。上部のベクトル化ボタンを押してスキャンを開始してください。', 'bot-msg');
                              setInputState(false, 'スキャンを行ってください...');
                              indexActions.classList.remove('visible');
                          } else if (message.value === 'ready') {
                              addMessage(message.message || '準備完了です。コードの機能や役割を入力してください。', 'bot-msg');
                              setInputState(true, '例: ログイン処理のコードは？');
                              indexActions.classList.remove('visible');
                          }
                          break;
                      case 'scanResult':
                          setInputState(false, '承認待ち...');
                          indexSummary.textContent = message.summary;
                          indexActions.classList.add('visible');
                          addMessage('スキャンが完了しました。トークン数を確認し、よろしければ確定して実行ボタンを押してください。', 'bot-msg');
                          break;
                      case 'result':
                      case 'status':
                          addMessage(message.value, 'bot-msg');
                          break;
                      case 'error':
                          addMessage('エラー: ' + message.value, 'error-msg');
                          break;
                  }
              });

              input.addEventListener('keypress', (e) => {
                  if (e.key === 'Enter') sendBtn.click();
              });
          </script>
      </body>
      </html>
    `;
  }
}
