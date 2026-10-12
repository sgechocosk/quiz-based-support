import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { makeSemanticJudge, QuizAgent, type QuizMode } from "./core/agent";
import { languageForPath } from "./core/chunker";
import { IndexManager, type SyncPlan } from "./core/indexer";
import { coerceLevel, LEARNER_LEVELS, LEVEL_DESCRIPTION, LEVEL_LABEL } from "./core/level";
import { LearnerLog, type BlankResult, type ReviewCard } from "./core/learnerLog";
import { OpenAiClient } from "./core/llm";
import type { KeyValueStore } from "./core/ports";
import { buildStructureQuestions } from "./core/questions";
import {
  applyItemToText,
  compactDiff,
  foldRanges,
  gradeBlanks,
  isolateBlank,
  resolveBlanks,
  scoreOf,
  windowAround,
  type BlankGrade,
} from "./core/quiz";
import { makeRng, sha1 } from "./core/text";
import type { McqQuestion, QuizItem } from "./core/types";
import { TreeSitterProvider } from "./host/parser";
import { VscodeLsp, VscodeWorkspace } from "./host/workspaceVscode";

const SECRET_KEY = "openai-api-key";

interface Services {
  ws: VscodeWorkspace;
  lsp: VscodeLsp;
  index: IndexManager;
  watcher: vscode.FileSystemWatcher;
}

/**
 * 正解・解説・元コードはここ(拡張機能ホスト)にだけ保持する。
 * webview には出題に必要な情報(空欄入りコードとヒント)しか渡さない。
 */
interface QuizSession {
  id: string;
  review: boolean;
  items: QuizItem[];
  questions: McqQuestion[];
  overall: string;
  graded: boolean;
}

function readConfig() {
  const c = vscode.workspace.getConfiguration("quizSupport");
  return {
    model: c.get<string>("model", "gpt-5-mini"),
    embeddingModel: c.get<string>("embeddingModel", "text-embedding-3-small"),
    reasoningEffort: c.get<string>("reasoningEffort", "auto"),
    baseUrl: c.get<string>("baseUrl", "https://api.openai.com/v1"),
    maxAgentSteps: c.get<number>("maxAgentSteps", 8),
    minSimilarity: c.get<number>("minSimilarity", 0.2),
    semanticGrading: c.get<boolean>("semanticGrading", true),
    structureQuestions: c.get<boolean>("structureQuestions", true),
    autoEmbedMaxTokens: c.get<number>("autoEmbedMaxTokens", 100_000),
    maxFiles: c.get<number>("maxFiles", 3000),
    level: coerceLevel(c.get<string>("learnerLevel", "intermediate")),
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export class ChatSidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private services?: Services;
  private servicesPromise?: Promise<Services | undefined>;
  private apiKey: string | undefined;
  private readonly parser: TreeSitterProvider;
  private readonly client: OpenAiClient;
  private readonly log: LearnerLog;
  private readonly sessions = new Map<string, QuizSession>();
  private pendingPlan?: SyncPlan;
  private abort?: AbortController;
  private busy = false;
  private syncing = false;
  private syncTimer?: ReturnType<typeof setTimeout>;
  private readonly dirty = new Set<string>();
  private needFullSync = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.parser = new TreeSitterProvider(context.extensionUri.fsPath);
    this.client = new OpenAiClient({
      apiKey: async () => this.apiKey ?? (await context.secrets.get(SECRET_KEY)),
      baseUrl: () => readConfig().baseUrl,
      model: () => readConfig().model,
      embeddingModel: () => readConfig().embeddingModel,
      reasoningEffort: () => readConfig().reasoningEffort,
    });
    const store: KeyValueStore = {
      get: <T>(key: string) => context.workspaceState.get<T>(key),
      update: async (key, value) => {
        await context.workspaceState.update(key, value);
      },
    };
    this.log = new LearnerLog(store);

    this.disposables.push(
      context.secrets.onDidChange((e) => {
        if (e.key === SECRET_KEY) {
          void this.refreshKey().then(() => this.pushState());
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("quizSupport")) {
          void this.pushState();
        }
      }),
    );
  }

  dispose(): void {
    this.abort?.abort();
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    this.services?.watcher.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  // ---------- webview ----------

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, "media");
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    webviewView.webview.html = this.html(webviewView.webview, mediaRoot);
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      void this.onMessage(message);
    });
    void this.init();
  }

  private html(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "main.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "main.js"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
</head>
<body>
<div id="app">
  <div id="top-actions">
    <button id="btn-key" class="secondary">APIキー</button>
    <button id="btn-index" class="secondary">インデックス</button>
    <button id="btn-log" class="secondary">学習記録</button>
  </div>
  <div id="level-row">
    <label for="level" class="muted">学習レベル</label>
    <select id="level" title="解説の細かさ・用語・問題の難しさが変わります"></select>
  </div>
  <div id="level-box" class="card hidden"></div>
  <div id="index-status" class="muted"></div>
  <div id="plan-box" class="card hidden"></div>
  <div id="log-box" class="card hidden"></div>
  <div id="messages"></div>
  <div id="input-area">
    <div id="input-row">
      <select id="mode" title="出題の種類">
        <option value="auto">自動</option>
        <option value="read">読んで理解</option>
        <option value="change">実装して学ぶ</option>
      </select>
      <input type="text" id="query" placeholder="準備中..." disabled>
      <button id="btn-send" disabled>送信</button>
      <button id="btn-cancel" class="secondary hidden">中止</button>
    </div>
  </div>
</div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  private post(message: Record<string, unknown>): void {
    void this.view?.webview.postMessage(message);
  }

  /** live=true は画面下部の1行表示(進捗など)。false は会話に残るお知らせ。 */
  private status(text: string, live = false): void {
    this.post({ type: "status", text, live });
  }

  private fail(error: unknown, fallback: string): void {
    this.post({ type: "error", text: errorMessage(error, fallback) });
  }

  // ---------- 初期化・サービス ----------

  private async refreshKey(): Promise<void> {
    this.apiKey = (await this.context.secrets.get(SECRET_KEY)) || undefined;
  }

  private async init(): Promise<void> {
    await this.refreshKey();
    await this.pushState();
    const services = await this.ensureServices();
    await this.pushState();
    if (services) {
      this.needFullSync = true; // 起動時は全体を走査する(以降は変更通知のあったファイルだけ)
      void this.autoSync();
    }
  }

  private ensureServices(): Promise<Services | undefined> {
    this.servicesPromise ??= this.createServices();
    return this.servicesPromise;
  }

  private async createServices(): Promise<Services | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return undefined;
    }
    const ws = new VscodeWorkspace(folder);
    await ws.refreshIgnore();
    const dir = path.join(this.context.globalStorageUri.fsPath, "index-v2", sha1(ws.id).slice(0, 12));
    const index = new IndexManager({
      dir,
      workspace: ws,
      parser: this.parser,
      embedder: () => (this.apiKey ? this.client : undefined),
      embeddingModel: () => readConfig().embeddingModel,
      maxFiles: readConfig().maxFiles,
    });
    await index.load();

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "**/*"));
    const mark = (uri: vscode.Uri, deleted: boolean): void => {
      const rel = ws.relativeOf(uri);
      if (!rel) {
        return;
      }
      if (rel === ".gitignore") {
        void ws.refreshIgnore().then(() => {
          this.needFullSync = true;
          this.scheduleSync();
        });
        return;
      }
      if (languageForPath(rel)) {
        this.dirty.add(rel);
      } else if (deleted) {
        // フォルダ削除などは個別ファイルの通知が来ないことがあるので、全体を再走査する
        this.needFullSync = true;
      } else {
        return;
      }
      this.scheduleSync();
    };
    watcher.onDidChange((u) => mark(u, false));
    watcher.onDidCreate((u) => mark(u, false));
    watcher.onDidDelete((u) => mark(u, true));

    this.services = { ws, lsp: new VscodeLsp(ws), index, watcher };
    return this.services;
  }

  private scheduleSync(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    this.syncTimer = setTimeout(() => void this.autoSync(), 1500);
  }

  /** 起動時・ファイル変更時の自動同期。チャンク化(無料)は常に行い、埋め込みは有効化済みで差分が小さいときだけ行う。 */
  private async autoSync(): Promise<void> {
    const services = this.services;
    if (!services || this.syncing) {
      if (this.syncing) {
        this.scheduleSync();
      }
      return;
    }
    this.syncing = true;
    try {
      const paths = this.needFullSync ? undefined : [...this.dirty];
      const first = !services.index.hasChunks();
      this.dirty.clear();
      this.needFullSync = false;
      if (paths && paths.length === 0) {
        return;
      }
      if (first) {
        this.status("コードを解析しています(初回のみ・APIは使いません)...", true);
      }
      const plan = await services.index.prepare(paths);
      if (plan.updates.size === 0) {
        return;
      }
      const cfg = readConfig();
      const wantEmbed = services.index.isSemanticEnabled() && !!this.apiKey;
      const embed = wantEmbed && plan.pendingTokens <= cfg.autoEmbedMaxTokens;
      await services.index.commit(plan, { embed });
      if (wantEmbed && !embed && plan.pendingEmbeds.length > 0) {
        this.status(
          `セマンティック検索に未反映の差分が約${plan.pendingTokens.toLocaleString()}トークンあります。「インデックス」から更新できます。`,
        );
      }
    } catch (error) {
      this.fail(error, "インデックスの更新に失敗しました。");
    } finally {
      this.syncing = false;
      await this.pushState();
    }
  }

  private async pushState(): Promise<void> {
    const stats = this.services?.index.stats();
    this.post({
      type: "state",
      hasKey: !!this.apiKey,
      hasWorkspace: !!vscode.workspace.workspaceFolders?.[0],
      level: readConfig().level,
      levelChosen: this.levelChosen(),
      levels: LEARNER_LEVELS.map((id) => ({ id, label: LEVEL_LABEL[id], description: LEVEL_DESCRIPTION[id] })),
      busy: this.busy,
      index: stats,
      learning: this.log.summary(),
    });
  }

  /** 利用者が学習レベルを一度でも選んだか(未選択なら初回に選んでもらう) */
  private levelChosen(): boolean {
    const i = vscode.workspace.getConfiguration("quizSupport").inspect<string>("learnerLevel");
    return i?.globalValue !== undefined || i?.workspaceValue !== undefined || i?.workspaceFolderValue !== undefined;
  }

  // ---------- メッセージ処理 ----------

  private async onMessage(raw: unknown): Promise<void> {
    if (typeof raw !== "object" || raw === null) {
      return;
    }
    const m = raw as Record<string, any>;
    try {
      switch (m.type) {
        case "ready":
          await this.pushState();
          break;
        case "setApiKey":
          await vscode.commands.executeCommand("quiz-based-support.setApiKey");
          break;
        case "ask":
          await this.handleAsk(String(m.query ?? ""), this.coerceMode(m.mode));
          break;
        case "cancel":
          this.abort?.abort();
          break;
        case "grade":
          await this.handleGrade(m);
          break;
        case "apply":
          await this.handleApply(String(m.quizId ?? ""), Number(m.itemIndex));
          break;
        case "open":
          await this.handleOpen(String(m.path ?? ""), Number(m.line) || 1);
          break;
        case "planIndex":
          await this.handlePlan();
          break;
        case "confirmIndex":
          await this.handleConfirm(Boolean(m.embed));
          break;
        case "clearIndex":
          await this.handleClear();
          break;
        case "startReview":
          await this.handleReview();
          break;
        case "setLevel":
          await vscode.workspace
            .getConfiguration("quizSupport")
            .update("learnerLevel", coerceLevel(m.level), vscode.ConfigurationTarget.Global);
          await this.pushState();
          break;
        case "resetLog":
          await this.log.reset();
          await this.pushState();
          break;
      }
    } catch (error) {
      this.fail(error, "処理中にエラーが発生しました。");
      this.busy = false;
      await this.pushState();
    }
  }

  private coerceMode(value: unknown): QuizMode {
    return value === "read" || value === "change" ? value : "auto";
  }

  // ---------- 出題 ----------

  private async handleAsk(query: string, mode: QuizMode): Promise<void> {
    const text = query.trim();
    if (!text) {
      return;
    }
    if (this.busy) {
      this.status("前の処理が終わるまでお待ちください。");
      return;
    }
    if (!this.apiKey) {
      this.fail(new Error("OpenAI APIキーが未設定です。「APIキー」から設定してください。"), "");
      return;
    }
    const services = await this.ensureServices();
    if (!services) {
      this.fail(new Error("フォルダを開いてから使ってください。"), "");
      return;
    }

    const cfg = readConfig();
    this.busy = true;
    this.abort = new AbortController();
    await this.pushState();
    try {
      const agent = new QuizAgent({
        llm: this.client,
        ws: services.ws,
        lsp: services.lsp,
        index: services.index,
        syntax: this.parser,
        config: {
          maxSteps: cfg.maxAgentSteps,
          minSimilarity: cfg.minSimilarity,
          repoMapChars: 1800,
          evidenceChars: 16_000,
          level: cfg.level,
        },
      });
      const result = await agent.run(text, mode, {
        onStatus: (s) => this.status(s, true),
        signal: this.abort.signal,
      });

      let questions: McqQuestion[] = [];
      const first = result.quiz.items[0];
      if (cfg.structureQuestions && first) {
        this.status("構造クイズ(呼び出し関係)を作成中...", true);
        questions = (
          await buildStructureQuestions({ ws: services.ws, lsp: services.lsp }, first, makeRng(Date.now()))
        ).slice(0, 2);
      }

      const session: QuizSession = {
        id: crypto.randomUUID(),
        review: false,
        items: result.quiz.items,
        questions,
        overall: result.quiz.overallExplanation,
        graded: false,
      };
      this.sessions.set(session.id, session);
      this.post({ type: "quiz", quiz: this.payloadOf(session, text, result.quiz.goal) });
      if (result.quiz.notice) {
        this.status(`⚠ ${result.quiz.notice}`);
      }
      if (result.quiz.rejected.length > 0) {
        this.status(`検証で不合格だった${result.quiz.rejected.length}件は作り直し、直らなかったものは除外しました。`);
      }
    } finally {
      this.busy = false;
      this.abort = undefined;
      await this.pushState();
    }
  }

  private payloadOf(session: QuizSession, query: string, goal: string): Record<string, unknown> {
    return {
      id: session.id,
      query,
      goal,
      review: session.review,
      items: session.items.map((item, index) => ({
        index,
        kind: item.kind,
        path: item.path,
        startLine: item.startLine,
        endLine: item.endLine,
        code: item.quizCode,
        // 空欄・変更行から離れた行は折りたたんで表示する(クリックで展開)
        folds: foldRanges(item),
        task: item.task ?? "",
        refs: item.refs ?? [],
        newNames: item.newNames ?? [],
        blanks: item.blanks.map((b) => ({ concept: b.concept, hints: b.hints, clue: b.clue })),
      })),
      questions: session.questions.map((q, index) => ({
        index,
        prompt: q.prompt,
        options: q.options,
        multi: q.correct.length > 1,
      })),
    };
  }

  // ---------- 採点・反映 ----------

  private async handleGrade(m: Record<string, any>): Promise<void> {
    const session = this.sessions.get(String(m.quizId ?? ""));
    if (!session) {
      this.fail(new Error("このクイズは失効しました。もう一度質問してください。"), "");
      return;
    }
    if (session.graded) {
      return;
    }
    const cfg = readConfig();
    const services = this.services;
    const given: string[][] = Array.isArray(m.blanks) ? m.blanks.map((a: unknown) => (Array.isArray(a) ? a.map(String) : [])) : [];
    const hints: number[][] = Array.isArray(m.hints) ? m.hints.map((a: unknown) => (Array.isArray(a) ? a.map(Number) : [])) : [];
    const choices: number[][] = Array.isArray(m.choices) ? m.choices.map((a: unknown) => (Array.isArray(a) ? a.map(Number) : [])) : [];

    this.status("採点中...", true);
    const judge = cfg.semanticGrading && this.apiKey ? makeSemanticJudge(this.client) : undefined;
    const results: BlankResult[] = [];
    const itemResults: Array<{
      grades: Array<BlankGrade & { why?: string }>;
      explanation: string;
      syntaxNote?: string;
      canApply: boolean;
      completed?: string;
    }> = [];
    let correct = 0;
    let total = 0;

    for (const [i, item] of session.items.entries()) {
      const answers = given[i] ?? [];
      const grades = await gradeBlanks(item, answers, judge);
      const score = scoreOf(grades);
      correct += score.correct;
      total += score.total;

      let syntaxNote: string | undefined;
      if (item.kind === "change" && !session.review && services && grades.some((g) => !g.correct) && answers.every((a) => a.trim())) {
        try {
          const text = await services.ws.readText(item.path);
          if ((await this.parser.isValid(item.path, applyItemToText(text, item, answers))) === false) {
            syntaxNote = "入力どおりに埋めると構文エラーになります。括弧・区切り・キーワードを見直してみましょう。";
          }
        } catch {
          // 構文チェックは補助。失敗しても採点は続ける。
        }
      }
      const answerList = item.blanks.map((b) => b.answer);
      itemResults.push({
        grades: grades.map((g, k) => ({ ...g, why: item.blanks[k]?.why })),
        explanation: item.explanation,
        syntaxNote,
        canApply: item.kind === "change" && !session.review,
        // 変更問題は、空欄以外も含めた完成形を見せて「どこがどう変わるか」を確認できるようにする
        completed: item.kind === "change" && !session.review ? compactDiff(item.original, resolveBlanks(item.quizCode, answerList)) : undefined,
      });

      item.blanks.forEach((b, k) => {
        results.push({
          path: item.path,
          startLine: item.startLine,
          endLine: item.endLine,
          concept: b.concept,
          snippet: windowAround(isolateBlank(item.quizCode, answerList, k)),
          answer: b.answer,
          hints: b.hints,
          why: b.why,
          correct: grades[k]?.correct ?? false,
          hintsUsed: hints[i]?.[k] ?? 0,
        });
      });
    }

    const questionResults = session.questions.map((q, i) => {
      const chosen = [...new Set(choices[i] ?? [])].sort((a, b) => a - b);
      const ok = chosen.length === q.correct.length && chosen.every((c, k) => c === q.correct[k]);
      total++;
      if (ok) {
        correct++;
      }
      return { correct: ok, correctIndexes: q.correct, chosen, explanation: q.explanation, concept: q.concept };
    });

    session.graded = true;
    await this.log.record(results);
    await this.log.recordConceptOnly(questionResults.map((q) => ({ concept: q.concept, correct: q.correct })));
    this.post({
      type: "graded",
      quizId: session.id,
      items: itemResults,
      questions: questionResults,
      overall: session.overall,
      score: { correct, total },
    });
    await this.pushState();
  }

  private async handleApply(quizId: string, itemIndex: number): Promise<void> {
    const session = this.sessions.get(quizId);
    const item = session?.items[itemIndex];
    const services = this.services;
    if (!session || !item || !services) {
      this.fail(new Error("反映対象が見つかりません(クイズが失効した可能性があります)。"), "");
      return;
    }
    if (item.kind !== "change" || session.review) {
      this.fail(new Error("この問題は既存コードの理解問題なので、反映対象ではありません。"), "");
      return;
    }
    if (!session.graded) {
      this.fail(new Error("先に解答して採点してください。"), "");
      return;
    }
    const uri = services.ws.uriOf(item.path);
    const doc = await vscode.workspace.openTextDocument(uri);
    // 生成時の内容と一致するか検証(不一致なら例外)
    applyItemToText(doc.getText(), item);

    const choice = await vscode.window.showWarningMessage(
      `${item.path} の ${item.startLine}〜${item.endLine} 行目を、正解コードで書き換えます。`,
      { modal: true, detail: "反映後は通常の編集と同じく、元に戻す(Undo)で取り消せます。" },
      "反映する",
    );
    if (choice !== "反映する") {
      return;
    }
    const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const resolved = resolveBlanks(
      item.quizCode,
      item.blanks.map((b) => b.answer),
    )
      .split(/\r?\n/)
      .join(eol);
    const range = new vscode.Range(item.startLine - 1, 0, item.endLine - 1, doc.lineAt(item.endLine - 1).text.length);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, range, resolved);
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error("編集を適用できませんでした。");
    }
    await vscode.window.showTextDocument(doc, { preview: false, selection: new vscode.Range(item.startLine - 1, 0, item.startLine - 1, 0) });
    this.status(`✅ ${item.path} の ${item.startLine}〜${item.endLine} 行目に反映しました(Undoで元に戻せます)。`);
  }

  private async handleOpen(relPath: string, line: number): Promise<void> {
    const services = this.services;
    if (!services || !relPath) {
      return;
    }
    const rel = relPath.replace(/\\/g, "/");
    if (rel.startsWith("/") || rel.split("/").includes("..")) {
      return;
    }
    const pos = new vscode.Position(Math.max(line - 1, 0), 0);
    await vscode.window.showTextDocument(services.ws.uriOf(rel), { selection: new vscode.Range(pos, pos), preview: true });
  }

  // ---------- 復習 ----------

  private async handleReview(): Promise<void> {
    if (this.busy) {
      return;
    }
    const cards: ReviewCard[] = this.log.dueCards(Date.now(), 5);
    if (cards.length === 0) {
      this.status("いま復習するカードはありません。");
      return;
    }
    const items: QuizItem[] = cards.map((c) => ({
      kind: "read",
      path: c.path,
      startLine: c.startLine,
      endLine: c.endLine,
      original: "",
      quizCode: c.snippet,
      blanks: [{ answer: c.answer, concept: c.concept, hints: c.hints, why: c.why }],
      explanation: "",
    }));
    const session: QuizSession = {
      id: crypto.randomUUID(),
      review: true,
      items,
      questions: [],
      overall: "復習おつかれさまです。間違えた箇所は間隔を空けてまた出題されます。",
      graded: false,
    };
    this.sessions.set(session.id, session);
    this.post({
      type: "quiz",
      quiz: this.payloadOf(session, "復習", "前に間違えた・ヒントを使った箇所をもう一度。"),
    });
  }

  // ---------- インデックス ----------

  private async handlePlan(): Promise<void> {
    const services = await this.ensureServices();
    if (!services) {
      this.fail(new Error("フォルダを開いてから使ってください。"), "");
      return;
    }
    this.status("差分を計算しています...", true);
    const plan = await services.index.prepare(undefined, (s) => this.status(s, true));
    this.pendingPlan = plan;
    this.post({
      type: "plan",
      files: plan.changedFiles,
      removed: plan.removedFiles,
      chunks: plan.newChunks,
      pendingEmbeds: plan.pendingEmbeds.length,
      tokens: plan.pendingTokens,
      truncated: plan.truncated,
      hasKey: !!this.apiKey,
      semantic: services.index.isSemanticEnabled(),
    });
  }

  private async handleConfirm(embed: boolean): Promise<void> {
    const services = this.services;
    if (!services) {
      return;
    }
    if (!this.pendingPlan) {
      await this.handlePlan();
    }
    const plan = this.pendingPlan;
    if (!plan) {
      return;
    }
    this.pendingPlan = undefined;
    this.busy = true;
    this.abort = new AbortController();
    await this.pushState();
    try {
      const stats = await services.index.commit(plan, { embed: embed && !!this.apiKey }, (s) => this.status(s, true), this.abort.signal);
      this.status(
        `インデックスを更新しました(${stats.files}ファイル / ${stats.chunks}チャンク / ベクトル${stats.vectors}件${embed ? "" : "・キーワード検索のみ"})。`,
      );
    } finally {
      this.busy = false;
      this.abort = undefined;
      await this.pushState();
    }
  }

  private async handleClear(): Promise<void> {
    const services = this.services;
    if (!services) {
      return;
    }
    await services.index.clear();
    this.pendingPlan = undefined;
    this.status("インデックスを削除しました。再作成するには「インデックス」を押してください。");
    await this.pushState();
    this.needFullSync = true;
    this.scheduleSync();
  }

  // ---------- コマンドから ----------

  async commandRebuildIndex(): Promise<void> {
    await this.handleClear();
    await this.handlePlan();
  }

  commandShowLog(): void {
    this.post({ type: "showLog" });
  }

  async commandClearIndex(): Promise<void> {
    await this.handleClear();
  }
}
