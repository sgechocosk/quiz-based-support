import * as vscode from "vscode";
import { ChatSidebarProvider } from "./ChatSidebarProvider"; // 後述

export function activate(context: vscode.ExtensionContext) {
  console.log("Quiz-based Support is now active!");

  // 1. APIキーを設定・保存するコマンド
  const setApiKeyCommand = vscode.commands.registerCommand(
    "quiz-based-support.setApiKey",
    async () => {
      const apiKey = await vscode.window.showInputBox({
        prompt: "OpenAI API Keyを入力してください (sk-... )",
        password: true, // 入力を隠す
        ignoreFocusOut: true,
      });

      if (apiKey) {
        // SecretStorageを使用してOSのセキュア領域に暗号化して保存
        await context.secrets.store("openai-api-key", apiKey);
        vscode.window.showInformationMessage("APIキーを安全に保存しました。");
      }
    },
  );

  // 2. サイドバーのWebviewプロバイダーを登録
  const sidebarProvider = new ChatSidebarProvider(context);
  const viewRegistration = vscode.window.registerWebviewViewProvider(
    "quiz-support-chat", // package.jsonで定義するIDと一致させる
    sidebarProvider,
  );

  context.subscriptions.push(setApiKeyCommand, viewRegistration);
}

export function deactivate() {}
