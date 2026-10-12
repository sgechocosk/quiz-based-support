# Quiz-based Support

コードベースを調べて質問に答える代わりに、**穴埋めクイズ**で「システムとコードの理解」を促す VS Code 拡張です。

## 動作の流れ
1. サイドバー「Quiz Support」で質問・要望を入力(例: 「認証のフローを理解したい」)。
2. エージェントがワークスペースを調査(ハイブリッド検索 BM25+ベクトル / grep / read_file / outline / LSP の定義・参照)。
3. **実際に読んだコードだけ**を根拠に、問題を生成。
   - 読解: 実コードの一部を空欄化(空欄を埋めると原文に一致するか検証済み)
   - 実装: 要望を実現するための変更を空欄化(構文検査つき)
   - 構造クイズ: LSP から決定的に作る選択問題(呼び出し元・定義ファイル)
4. 先に予想 → 空欄入力 → 段階ヒント(最大3段階) → 採点。正解・解説は採点まで画面に渡りません。
5. 「実装」問題は確認ダイアログの後、正解コードをファイルへ反映(Undo 可)。
6. 学習記録(概念別正答率・Leitner 方式の復習カード)は workspaceState に保存。

## セットアップ
- コマンド「Quiz Support: Set OpenAI API Key」またはサイドバーの「APIキー」で設定(SecretStorage に保存)。
- キー無しでもキーワード索引(BM25)は自動作成されます。意味検索(埋め込み)は「インデックス」から見積もりを確認して有効化。

## 設定
| 設定 | 既定 | 内容 |
|---|---|---|
| quizSupport.model | gpt-5-mini | 生成モデル |
| quizSupport.reasoningEffort | auto | 推論強度。auto は gpt-6-luna 等「ツールと併用不可」のモデルで自動的に none へ切替 |
| quizSupport.embeddingModel | text-embedding-3-small | 埋め込みモデル |
| quizSupport.baseUrl | OpenAI | OpenAI互換エンドポイント |
| quizSupport.maxAgentSteps | 8 | 調査の最大ステップ |
| quizSupport.minSimilarity | – | ベクトルのみ一致の下限 |
| quizSupport.semanticGrading | – | 別解を LLM で判定 |
| quizSupport.structureQuestions | – | LSP 構造クイズ |
| quizSupport.autoEmbedMaxTokens | – | 自動埋め込みの上限 |
| quizSupport.maxFiles | – | 索引対象の最大ファイル数 |

## 開発
```
npm install
npm run test:unit      # ユニット/E2E(偽OpenAI)
npm run check-types && npm run lint
npm run compile        # esbuild(依存を全て同梱)
F5                     # Extension Development Host
npm run package:vsix   # .vsix 作成
```

## 既知の制限
- AST チャンク分割は ts/tsx/js/java のみ。他言語は行ベース分割。
- 旧版の `vector-index` は使用しません(新形式は `index-v2`)。再索引は自動。
- 実 VS Code・実 OpenAI API での通し検証は開発環境では未実施です。
