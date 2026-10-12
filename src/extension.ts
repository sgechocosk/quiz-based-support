import * as vscode from "vscode";
import { ChatSidebarProvider } from "./ChatSidebarProvider";

const SECRET_KEY = "openai-api-key";

export function activate(context: vscode.ExtensionContext) {
  const provider = new ChatSidebarProvider(context);

  // APIキーはOSのセキュア領域(SecretStorage)に保存する
  const setApiKey = vscode.commands.registerCommand("quiz-based-support.setApiKey", async () => {
    const apiKey = await vscode.window.showInputBox({
      prompt: "OpenAI(または互換サービス)のAPIキーを入力してください",
      password: true,
      ignoreFocusOut: true,
    });
    if (apiKey && apiKey.trim()) {
      await context.secrets.store(SECRET_KEY, apiKey.trim());
      void vscode.window.showInformationMessage("APIキーを安全に保存しました。");
    }
  });

  const rebuildIndex = vscode.commands.registerCommand("quiz-based-support.rebuildIndex", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.quiz-support-sidebar");
    await provider.commandRebuildIndex();
  });

  const clearIndex = vscode.commands.registerCommand("quiz-based-support.clearIndex", async () => {
    await provider.commandClearIndex();
  });

  const showLog = vscode.commands.registerCommand("quiz-based-support.showLearningLog", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.quiz-support-sidebar");
    provider.commandShowLog();
  });

  const view = vscode.window.registerWebviewViewProvider("quiz-support-chat", provider, {
    // サイドバーを閉じても、入力途中のクイズ画面を保持する
    webviewOptions: { retainContextWhenHidden: true },
  });

  context.subscriptions.push(provider, setApiKey, rebuildIndex, clearIndex, showLog, view);
}

export function deactivate() {}
