import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  answersFrom,
  investigationRequiresChange,
  QuizAgent,
  requirementText,
  STAGE_SIZE,
  type AgentResult,
  type Clarification,
  type Investigation,
  type QuizMode,
  type RunHooks,
} from "./core/agent";
import { buildChoices, namePool } from "./core/choices";
import { languageForPath } from "./core/chunker";
import { IndexManager, type SyncPlan } from "./core/indexer";
import {
  buildLesson,
  finalPayload,
  gradeItem,
  gradeQuestion,
  itemPayload,
  revealPayload,
  stepPayload,
  type Lesson,
} from "./core/lesson";
import {
  coerceLevel,
  LEARNER_LEVELS,
  LEVEL_DESCRIPTION,
  LEVEL_LABEL,
} from "./core/level";
import {
  LearnerLog,
  type BlankResult,
  type ReviewCard,
} from "./core/learnerLog";
import {
  LlmError,
  OpenAiClient,
  type ApiRequestInfo,
  type ApiUsageInfo,
} from "./core/llm";
import {
  parseProjectRules,
  PROJECT_RULES_PATH,
  type ProjectRule,
} from "./core/patterns";
import { ChangePlanner, PlanError } from "./core/planner";
import { PromptAssistant, type SendAssist } from "./core/promptAssist";
import type { RequirementSpec, StagePlan } from "./core/planTypes";
import type { KeyValueStore, TypeChecker } from "./core/ports";
import { buildStructureQuestions } from "./core/questions";
import { applyItemToText, compactDiff, resolveBlanks } from "./core/quiz";
import {
  changedFocus,
  MAX_STAGES,
  reviewProgress,
  stageSpec,
  statusLabel,
  type StageResult,
} from "./core/stages";
import { makeRng, sha1, splitLines } from "./core/text";
import type { Choice, McqQuestion, QuizItem } from "./core/types";
import {
  applyPlanFiles,
  changedSince,
  runTestCommand,
  savePlanFiles,
} from "./host/applier";
import { GitHistory } from "./host/gitHistory";
import { TreeSitterProvider } from "./host/parser";
import { loadTypeScript, TsTypeChecker } from "./host/typeChecker";
import { VscodeLsp, VscodeWorkspace } from "./host/workspaceVscode";

const SECRET_KEY = "openai-api-key";

interface Services {
  ws: VscodeWorkspace;
  lsp: VscodeLsp;
  index: IndexManager;
  watcher: vscode.FileSystemWatcher;
  /** 型検査(TypeScript の設定が無ければ null)。初めて使うときに作る */
  typeChecker?: TypeChecker | null;
  history?: GitHistory;
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

/** 実装の手順(変更計画をステップごとに学ぶ)。正解・判断の記録はホストにだけ置き、答え合わせのたびに次のステップを渡す */
interface LessonSession {
  id: string;
  query: string;
  lesson: Lesson;
  /** 次に答えるステップ */
  current: number;
  finished: boolean;
  applied: boolean;
  score: { correct: number; total: number };
  /** 判断の記録に「取り組んだ回数」として数えたか(1つの手順は、最初に記録したときに1回だけ数える) */
  logged: boolean;
  /** 段階に分けて進めている依頼の一部なら、その依頼 */
  campaignId?: string;
}

/**
 * 大きな依頼を段階に分けて、依頼全体が完成するまで進める(段階ごとに 調べ直す → 計画 → たどる → 反映 を回す)。
 * 次の段階へ進む前に、依頼全体の受け入れ条件と済んだ段階を見比べて、残りの段階を見直す。
 */
interface Campaign {
  id: string;
  query: string;
  /** 依頼全体の要件 */
  overall: RequirementSpec;
  /** 済んだ段階 + 今の段階 + 残りの段階 */
  stages: StagePlan[];
  /** 今の段階(0始まり)。stages の長さ以上なら、完成の確認待ち */
  current: number;
  done: StageResult[];
  /** 最新の調査(次の段階はこれを今の内容で調べ直して使う) */
  inv: Investigation;
  /** 今の段階の手順(計画できなかったときは undefined) */
  lessonId?: string;
}

/** 保持する出題・手順・依頼の数(古いものから捨てる) */
const KEEP = { quizzes: 20, lessons: 20, campaigns: 10 };

/** Map に入れ、上限を超えたら古いものから捨てる */
function remember<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    map.delete(map.keys().next().value!);
  }
}

function readConfig() {
  const c = vscode.workspace.getConfiguration("quizSupport");
  return {
    model: c.get<string>("model", "gpt-6-luna"),
    embeddingModel: c.get<string>("embeddingModel", "text-embedding-3-small"),
    reasoningEffort: c.get<string>("reasoningEffort", "auto"),
    baseUrl: c.get<string>("baseUrl", "https://api.openai.com/v1"),
    maxAgentSteps: c.get<number>("maxAgentSteps", 20),
    minSimilarity: c.get<number>("minSimilarity", 0.2),
    structureQuestions: c.get<boolean>("structureQuestions", true),
    autoEmbedMaxTokens: c.get<number>("autoEmbedMaxTokens", 100_000),
    maxFiles: c.get<number>("maxFiles", 3000),
    level: coerceLevel(c.get<string>("learnerLevel", "intermediate")),
    testMode: c.get<boolean>("testMode", false),
    typeCheck: c.get<boolean>("typeCheck", true),
    testCommand: (c.get<string>("testCommand", "") ?? "").trim(),
    inputAssist: c.get<boolean>("inputAssist", true),
  };
}

/** 送った依頼で入力補助をどう使ったか(webview から届いた値を整える) */
function sendAssistFrom(raw: unknown): SendAssist {
  const a = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const count = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
  return { shown: count(a.shown), accepted: count(a.accepted), refined: a.refined === true };
}

function reviewChoices(card: ReviewCard): Choice[] {
  return buildChoices({
    answer: card.answer,
    why: card.why ?? "",
    distractors: [],
    known: new Set(card.snippet.match(/[A-Za-z_$][\w$]*/g) ?? []),
    pool: namePool(card.snippet),
    seed: card.id,
  }).choices;
}

/**
 * 進捗の表示から、利用者が意識しなくてよい内部の情報(調査で呼んだツール名と引数)を除く。
 * 詳しい表示はテストモードで見られる。
 */
function friendlyStatus(text: string): string {
  const tool = /^調査 (\d+): /.exec(text);
  if (tool) {
    return `関連コードを調査中...(${tool[1]})`;
  }
  // 調べることの一覧は長いので、テストモードでだけそのまま出す
  return text.startsWith("調べること: ") ? "調べることを決めました。関連コードを調査中..." : text;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export class ChatSidebarProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view?: vscode.WebviewView;
  private services?: Services;
  private servicesPromise?: Promise<Services | undefined>;
  private apiKey: string | undefined;
  private readonly parser: TreeSitterProvider;
  private readonly client: OpenAiClient;
  private readonly log: LearnerLog;
  private readonly store: KeyValueStore;
  /** 入力補助(サービスを作ったときに作る) */
  private assistant?: PromptAssistant;
  /** 「依頼を整える」の要求(新しい要求が来たら前のものを中止する) */
  private refineAbort?: AbortController;
  /** 入力補助の API 使用量(依頼の処理の集計とは分ける。テストモードで表示) */
  private assistUsage = { calls: 0, estimated: 0, actual: 0, cached: 0, output: 0 };
  private readonly sessions = new Map<string, QuizSession>();
  private readonly lessons = new Map<string, LessonSession>();
  private readonly campaigns = new Map<string, Campaign>();
  private pendingPlan?: SyncPlan;
  /** 回答待ちの要件確認(最新の1件だけ。新しい質問をすると無効になる) */
  private pendingClarify?: {
    id: string;
    query: string;
    inv: Investigation;
    clarification: Clarification;
    spec: RequirementSpec;
  };
  /** API 実行前の確認で「この処理では以降確認しない」が選ばれた(処理の始めに戻す) */
  private approveRest = false;
  /** 1つの処理での API 使用量(処理の終わりに表示する) */
  private usage = { calls: 0, estimated: 0, actual: 0, output: 0 };
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
      apiKey: async () =>
        this.apiKey ?? (await context.secrets.get(SECRET_KEY)),
      baseUrl: () => readConfig().baseUrl,
      model: () => readConfig().model,
      embeddingModel: () => readConfig().embeddingModel,
      reasoningEffort: () => readConfig().reasoningEffort,
      beforeRequest: (info) => this.confirmApi(info),
      afterResponse: (info) => this.countUsage(info),
    });
    const store: KeyValueStore = {
      get: <T>(key: string) => context.workspaceState.get<T>(key),
      update: async (key, value) => {
        await context.workspaceState.update(key, value);
      },
    };
    this.store = store;
    this.log = new LearnerLog(store);

    this.disposables.push(
      context.secrets.onDidChange((e) => {
        if (e.key === SECRET_KEY) {
          this.assistant?.resetPause();
          void this.refreshKey().then(() => this.pushState());
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("quizSupport")) {
          // モデル・ベースURLなどを直したら、失敗で止めた続きの候補を戻す
          this.assistant?.resetPause();
          void this.pushState();
        }
      }),
    );
  }

  dispose(): void {
    this.abort?.abort();
    this.refineAbort?.abort();
    this.assistant?.cancel();
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
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };
    webviewView.webview.html = this.html(webviewView.webview, mediaRoot);
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      void this.onMessage(message);
    });
    void this.init();
  }

  private html(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const css = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "main.css"),
    );
    const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "main.js"));
    const assistJs = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "assist.js"));
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
  <header id="toolbar">
    <label for="level" class="toolbar-label">経験レベル</label>
    <select id="level" title="解説の細かさ・用語・扱う内容の深さが変わります"></select>
    <span class="spacer"></span>
    <button id="test-badge" class="badge test hidden" title="テストモード: API 実行前の確認・トークン数・内部の情報を表示中(クリックで設定を開く)">テスト</button>
    <button id="btn-log" class="toolbar-btn" title="これまでの判断の記録と振り返り" aria-expanded="false">判断の記録</button>
    <button id="btn-settings" class="toolbar-btn" title="APIキー・索引・テストモード" aria-expanded="false">設定</button>
  </header>
  <section id="settings-box" class="panel hidden" aria-label="設定">
    <div class="panel-head"><h4>設定</h4><button id="btn-settings-close" class="icon-btn" title="閉じる" aria-label="閉じる">×</button></div>
    <div class="setting">
      <div class="setting-text"><div class="setting-name">OpenAI APIキー</div><div id="key-status" class="muted"></div></div>
      <button id="btn-key" class="secondary">設定</button>
    </div>
    <div class="setting">
      <div class="setting-text"><div class="setting-name">コード検索の索引</div><div id="index-status" class="muted"></div></div>
      <button id="btn-index" class="secondary">更新...</button>
    </div>
    <label class="setting setting-toggle">
      <input type="checkbox" id="input-assist">
      <div class="setting-text"><div class="setting-name">入力中の候補</div><div class="muted">入力が止まったときに、書きかけの続きや関数名の候補を薄い文字で出します(Tab で入れる)。続きの候補を作るため、送信前の書きかけ・最近の依頼・コードの構成(ファイルと主な名前)・関連する場所を OpenAI API に送ります。オフにしても「依頼を整える」は使えます。</div><div id="input-assist-test" class="muted hidden">テストモードの間は出しません。</div><div id="input-assist-note" class="warn hidden"></div></div>
    </label>
    <label class="setting setting-toggle" title="開発・検証向けの表示です">
      <input type="checkbox" id="test-mode">
      <div class="setting-text"><div class="setting-name">テストモード</div><div class="muted">API を呼ぶ前に目的と入力トークン数を確認し、処理ごとの使用量や生成の内部情報を表示します(開発・検証向け)。</div></div>
    </label>
    <div id="assist-stats" class="assist-stats muted hidden"></div>
  </section>
  <section id="setup-box" class="panel notice-panel hidden"></section>
  <section id="level-box" class="panel hidden"></section>
  <section id="plan-box" class="panel hidden"></section>
  <section id="log-box" class="panel hidden"></section>
  <div id="messages-wrap">
    <div id="messages"></div>
    <button id="jump-latest" class="hidden" title="いちばん下へ移動">↓ 最新へ</button>
  </div>
  <div id="live" class="hidden" role="status"></div>
  <footer id="input-area">
    <div id="assist-box" class="hidden"></div>
    <div class="query-wrap">
      <div id="query-mirror" aria-hidden="true"></div>
      <textarea id="query" rows="1" placeholder="準備中..." disabled aria-label="質問・要望(Enter で送信、Shift+Enter で改行)"></textarea>
    </div>
    <div id="assist-line" class="assist-line hidden"></div>
    <div id="assist-sr" class="sr-only" aria-live="polite"></div>
    <div id="send-row">
      <select id="mode" title="進め方" aria-label="進め方">
        <option value="auto">自動で判断</option>
        <option value="read">仕組みを読み解く</option>
        <option value="change">変更を組み立てる</option>
      </select>
      <span class="spacer"></span>
      <button id="btn-refine" class="secondary" disabled title="書きかけの依頼を、調査と計画に伝わりやすい形に整えます(Ctrl+Enter)">依頼を整える</button>
      <button id="btn-cancel" class="secondary hidden">中止</button>
      <button id="btn-send" disabled>送信</button>
    </div>
  </footer>
</div>
<script nonce="${nonce}" src="${assistJs}"></script>
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
    const dir = path.join(
      this.context.globalStorageUri.fsPath,
      "index-v2",
      sha1(ws.id).slice(0, 12),
    );
    const index = new IndexManager({
      dir,
      workspace: ws,
      parser: this.parser,
      embedder: () => (this.apiKey ? this.client : undefined),
      embeddingModel: () => readConfig().embeddingModel,
      maxFiles: readConfig().maxFiles,
    });
    await index.load();

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, "**/*"),
    );
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
    this.assistant = new PromptAssistant({
      llm: this.client,
      index: () => (index.hasChunks() ? index : undefined),
      store: this.store,
      workspaceId: ws.id,
    });
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
        this.status(
          "コードを解析しています(初回のみ・APIは使いません)...",
          true,
        );
      }
      const plan = await services.index.prepare(paths);
      if (plan.updates.size === 0) {
        return;
      }
      const cfg = readConfig();
      const wantEmbed = services.index.isSemanticEnabled() && !!this.apiKey;
      // テストモード(API 実行前に確認する)のときは、裏で勝手に API を呼ばない(「索引」から確認して更新する)
      const embed =
        wantEmbed &&
        !cfg.testMode &&
        plan.pendingTokens <= cfg.autoEmbedMaxTokens;
      await services.index.commit(plan, { embed });
      if (wantEmbed && !embed && plan.pendingEmbeds.length > 0) {
        this.status(
          cfg.testMode
            ? `意味検索に未反映の差分が約${plan.pendingTokens.toLocaleString()}トークンあります(テストモードのため自動では更新しません)。設定の「索引」から更新できます。`
            : "意味検索に反映していない変更があります。設定の「索引」から更新できます。",
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
      levels: LEARNER_LEVELS.map((id) => ({
        id,
        label: LEVEL_LABEL[id],
        description: LEVEL_DESCRIPTION[id],
      })),
      busy: this.busy,
      index: stats,
      learning: this.log.summary(),
      testMode: readConfig().testMode,
      ...this.assistState(),
    });
  }

  /**
   * 入力補助の状態。入力中の候補(続きの候補・名前の補完)は設定でオフにでき、テストモードの間は出さない
   * (テストモードでは裏で API を呼ばない)。「依頼を整える」は利用者の操作で呼ぶので、どちらでも使える。
   */
  private assistState(): Record<string, unknown> {
    const cfg = readConfig();
    const live = cfg.inputAssist && !cfg.testMode;
    const u = this.assistUsage;
    const block = this.assistant?.autoBlock();
    const notes: Record<string, string> = {
      config: "API の設定(モデル名・ベースURL・APIキー)では続きの候補を作れなかったため、止めています。設定を見直すと再開します。",
      slow: "応答に時間がかかるため、続きの候補を止めています(推論を止められないモデルの可能性があります)。設定を見直すと再開します。",
    };
    // 使われない状態が続いても止めない(既定オン・オフは利用者が決める)。オフにできることだけを知らせる
    const rarely = live && !block && this.assistant?.rarelyUsed() ? "続きの候補があまり使われていません。不要なら、このスイッチでオフにできます。" : "";
    return {
      inputAssist: cfg.inputAssist,
      assist: {
        names: live,
        auto: live && !!this.apiKey && !block,
        delayMs: this.assistant?.delayMs() ?? 800,
      },
      assistNote: live && block ? notes[block] : rarely,
      // 使われ方と API 使用量は、利用者が意識しなくてよいのでテストモードでだけ渡す
      assistStats: cfg.testMode && this.assistant ? { ...this.assistant.stats(), usage: { ...u } } : undefined,
    };
  }

  /** 利用者が経験レベルを一度でも選んだか(未選択なら初回に選んでもらう) */
  private levelChosen(): boolean {
    const i = vscode.workspace
      .getConfiguration("quizSupport")
      .inspect<string>("learnerLevel");
    return (
      i?.globalValue !== undefined ||
      i?.workspaceValue !== undefined ||
      i?.workspaceFolderValue !== undefined
    );
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
          // 送ったら、整えている途中の依頼は要らない
          this.refineAbort?.abort();
          this.assistant?.recordSend(String(m.query ?? "").trim(), sendAssistFrom(m.assist));
          await this.handleAsk(String(m.query ?? ""), this.coerceMode(m.mode));
          break;
        case "suggest":
          await this.handleSuggest(m);
          break;
        case "suggestCancel":
          this.assistant?.cancel();
          break;
        case "completeName":
          this.handleCompleteName(m);
          break;
        case "nameAccepted":
          this.assistant?.recordNameAccepted();
          break;
        case "refine":
          await this.handleRefine(m);
          break;
        case "refineCancel":
          this.refineAbort?.abort();
          break;
        case "setInputAssist": {
          this.assistant?.resetPause(true);
          // ワークスペースの設定で決めていれば、そちらを書き換える(ユーザー設定だけ変えても効かないため)
          const c = vscode.workspace.getConfiguration("quizSupport");
          const i = c.inspect<boolean>("inputAssist");
          const target =
            i?.workspaceFolderValue !== undefined
              ? vscode.ConfigurationTarget.WorkspaceFolder
              : i?.workspaceValue !== undefined
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;
          await c.update("inputAssist", m.value === true, target);
          await this.pushState();
          break;
        }
        case "clarifyAnswer":
          await this.handleClarifyAnswer(m);
          break;
        case "lessonAnswer":
          await this.handleLessonAnswer(m);
          break;
        case "lessonApply":
          await this.handleLessonApply(String(m.lessonId ?? ""));
          break;
        case "lessonRevert":
          await this.handleLessonRevert(String(m.lessonId ?? ""));
          break;
        case "lessonTest":
          await this.handleLessonTest(String(m.lessonId ?? ""));
          break;
        case "stageNext":
          await this.handleStageNext(String(m.campaignId ?? ""));
          break;
        case "stageRetry":
          await this.handleStageRetry(String(m.campaignId ?? ""));
          break;
        case "stageSkip":
          await this.handleStageSkip(String(m.campaignId ?? ""));
          break;
        case "setTestMode":
          await vscode.workspace
            .getConfiguration("quizSupport")
            .update(
              "testMode",
              m.value === true,
              vscode.ConfigurationTarget.Global,
            );
          await this.pushState();
          break;
        case "cancel":
          this.abort?.abort();
          this.refineAbort?.abort();
          break;
        case "grade":
          await this.handleGrade(m);
          break;
        case "apply":
          await this.handleApply(String(m.quizId ?? ""), Number(m.itemIndex));
          break;
        case "open":
          await this.handleOpen(
            String(m.path ?? ""),
            Number(m.line) || 1,
            typeof m.text === "string" ? m.text : undefined,
          );
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
            .update(
              "learnerLevel",
              coerceLevel(m.level),
              vscode.ConfigurationTarget.Global,
            );
          await this.pushState();
          break;
        case "resetLog":
          await this.log.reset();
          // 入力補助の最近の依頼と記録も消す
          this.assistant?.reset();
          await this.pushState();
          break;
      }
    } catch (error) {
      this.fail(error, "処理中にエラーが発生しました。");
      this.busy = false;
      await this.pushState();
    }
  }

  // ---------- 入力補助 ----------
  //
  // 依頼の処理(withAgent)とは別の経路: 処理中の状態にせず、会話にエラーを出さない(入力の邪魔をしない)。
  // ここで例外を投げると onMessage が処理中の状態を戻してしまうので、例外は外に出さない。

  /** 書きかけの続きの候補(入力が止まったときに webview から届く) */
  private async handleSuggest(m: Record<string, any>): Promise<void> {
    const id = Number(m.id) || 0;
    const draft = String(m.draft ?? "");
    const reply = (completion: string, missing: string[]) =>
      this.post({ type: "suggestion", id, draft, completion, missing });
    const cfg = readConfig();
    const assistant = this.assistant;
    if (!cfg.inputAssist || cfg.testMode || this.busy || !this.apiKey || !assistant || !this.view?.visible) {
      reply("", []);
      return;
    }
    const before = assistant.autoBlock();
    try {
      const out = await assistant.complete(draft, this.coerceMode(m.mode));
      if (out.reason !== "aborted") {
        reply(out.completion, out.missing);
      }
    } catch {
      // 候補は出せなくても入力は続けられる
    }
    if (assistant.autoBlock() !== before) {
      // 失敗・遅さで止めたことを画面に伝える(以後は求めてこない)
      await this.pushState();
    }
  }

  /** 名前の補完(API を使わない) */
  private handleCompleteName(m: Record<string, any>): void {
    const cfg = readConfig();
    const prefix = String(m.prefix ?? "");
    const result = cfg.inputAssist && !cfg.testMode && this.assistant ? this.assistant.completeName(prefix) : { names: [], total: 0 };
    // 候補を選ぶときに、どこで宣言されている名前かを見られるようにする
    const defs: Record<string, { path: string; line: number }> = {};
    for (const name of result.names) {
      const def = this.services?.index.definitionOf(name);
      if (def) {
        defs[name] = def;
      }
    }
    this.post({ type: "nameCompletion", id: Number(m.id) || 0, prefix, ...result, defs });
  }

  /** 「依頼を整える」(利用者の操作)。テストモードでは API の確認を出す */
  private async handleRefine(m: Record<string, any>): Promise<void> {
    const id = Number(m.id) || 0;
    const draft = String(m.draft ?? "").trim();
    const fail = (text: string) => this.post({ type: "refined", id, draft, error: text });
    if (!draft) {
      return;
    }
    if (draft.length > 2000) {
      fail("書きかけが長すぎます(2000文字まで)。ログやコードは要点だけにしてから整えてください。");
      return;
    }
    if (!this.apiKey) {
      fail("OpenAI APIキーが未設定です。上の案内またはサイドバーの「設定」から設定してください。");
      return;
    }
    const services = await this.ensureServices();
    const assistant = this.assistant;
    if (!services || !assistant) {
      fail("フォルダを開いてから使ってください。");
      return;
    }
    this.refineAbort?.abort();
    const controller = new AbortController();
    this.refineAbort = controller;
    try {
      const proposal = await assistant.refine(draft, this.coerceMode(m.mode), controller.signal);
      if (!controller.signal.aborted) {
        this.post({ type: "refined", id, draft, proposal });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        fail(errorMessage(error, "依頼を整えられませんでした。"));
      }
    } finally {
      if (this.refineAbort === controller) {
        this.refineAbort = undefined;
      }
      if (readConfig().testMode) {
        await this.pushState();
      }
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
    const services = await this.readyServices();
    if (!services) {
      return;
    }
    // 新しい質問をしたら、答えていない要件の確認は無効にする
    this.pendingClarify = undefined;
    await this.withAgent(services, async (agent, hooks) => {
      let inv: Investigation;
      try {
        inv = await agent.investigate(text, mode, hooks);
      } catch (error) {
        if (!hooks.signal?.aborted && error instanceof Error && error.message.startsWith("関連するコードが見つかりませんでした")) {
          this.assistant?.recordResult(text, { notFound: true });
        }
        throw error;
      }
      this.assistant?.recordResult(text, { steps: inv.steps });
      if (!investigationRequiresChange(inv)) {
        // 仕組みの質問: 読解のクイズ
        await this.presentQuiz(
          services,
          await agent.compose(inv, [], hooks),
          text,
        );
        return;
      }
      // 実装・修正の依頼: 要件を整理し、大きい・案が複数あるなら先に質問する(調査結果は回答後の計画に使う)
      const { spec, clarification } = await agent.organize(inv, hooks);
      this.assistant?.recordResult(text, { clarified: !!clarification });
      if (clarification) {
        const id = crypto.randomUUID();
        this.pendingClarify = { id, query: text, inv, clarification, spec };
        this.post({ type: "clarify", id, clarification });
        return;
      }
      await this.proceed(services, agent, inv, spec, text, hooks);
    });
  }

  /** 要件の確認への回答(skip=true は「確認せずに進める」) */
  private async handleClarifyAnswer(m: Record<string, any>): Promise<void> {
    const pending = this.pendingClarify;
    if (!pending || pending.id !== String(m.id ?? "")) {
      this.fail(
        new Error("この確認は失効しました。もう一度質問してください。"),
        "",
      );
      return;
    }
    const services = await this.readyServices();
    if (!services) {
      return;
    }
    this.pendingClarify = undefined;
    const picks = Array.isArray(m.answers)
      ? m.answers.map((a: any) => ({
          option: Number.isInteger(a?.option) ? Number(a.option) : undefined,
          text: String(a?.text ?? ""),
        }))
      : [];
    const answers = m.skip ? [] : answersFrom(pending.clarification, picks);
    await this.withAgent(services, async (agent, hooks) => {
      let spec = pending.spec;
      if (answers.length > 0) {
        // 選んだ案に関係するコードを調べてから、受け入れ条件を確定する
        await agent.followUp(pending.inv, answers, hooks);
        spec = await agent.finalizeSpec(
          pending.inv,
          pending.spec,
          answers,
          hooks,
        );
      }
      await this.proceed(services, agent, pending.inv, spec, pending.query, hooks);
    });
  }

  /** 要件が決まったら、段階があれば1段階ずつ依頼全体が完成するまで、無ければ1回の手順で進める */
  private async proceed(
    services: Services,
    agent: QuizAgent,
    inv: Investigation,
    spec: RequirementSpec,
    query: string,
    hooks: RunHooks,
  ): Promise<void> {
    if (spec.stages && spec.stages.length >= 2) {
      const campaign: Campaign = {
        id: crypto.randomUUID(),
        query,
        overall: spec,
        stages: spec.stages,
        current: 0,
        done: [],
        inv,
      };
      remember(this.campaigns, campaign.id, campaign, KEEP.campaigns);
      await this.continueCampaign(services, agent, campaign, hooks, false);
      return;
    }
    await this.presentLesson(services, agent, inv, spec, query, hooks);
  }

  // ---------- 実装の手順(変更計画) ----------

  /** 型検査は TypeScript の設定があるワークスペースでだけ使う(初回に作って使い回す) */
  private typeCheckerFor(services: Services): TypeChecker | undefined {
    if (!readConfig().typeCheck) {
      return undefined;
    }
    if (services.typeChecker === undefined) {
      const root = services.ws.folder.uri.fsPath;
      const ts = loadTypeScript(
        root,
        vscode.env.appRoot,
        vscode.workspace.isTrusted,
      );
      services.typeChecker = ts ? new TsTypeChecker(ts, root) : null;
    }
    return services.typeChecker ?? undefined;
  }

  /** .quiz-support/patterns.json(このプロジェクトの「これを変えたらあれも確認する」) */
  private async projectRules(services: Services): Promise<ProjectRule[]> {
    let text: string;
    try {
      text = await services.ws.readText(PROJECT_RULES_PATH);
    } catch {
      return [];
    }
    const { rules, errors } = parseProjectRules(text);
    if (errors.length > 0) {
      this.status(`⚠ ${errors.slice(0, 2).join(" / ")}`);
    }
    return rules;
  }

  private async presentLesson(
    services: Services,
    agent: QuizAgent,
    inv: Investigation,
    spec: RequirementSpec,
    query: string,
    hooks: RunHooks,
  ): Promise<void> {
    let lesson: Lesson;
    try {
      lesson = await this.buildPlanLesson(services, inv, spec, hooks);
    } catch (error) {
      if (hooks.signal?.aborted || !(error instanceof PlanError)) {
        throw error;
      }
      // 変更計画を作れなくても止めない: 理由を示して、調査済みのコードから実装のクイズを作る
      this.status(`⚠ ${error.message}\n変更の手順を組み立てる代わりに、調べたコードで変更の考えどころをたどります。`);
      await this.presentQuiz(
        services,
        await agent.composeQuiz(inv, requirementText(inv.query, spec.answers), hooks),
        query,
      );
      return;
    }
    this.showLesson(lesson, query);
  }

  /** 変更計画を作り、手順(ステップごとの問題)にする */
  private async buildPlanLesson(
    services: Services,
    inv: Investigation,
    spec: RequirementSpec,
    hooks: RunHooks,
  ): Promise<Lesson> {
    const cfg = readConfig();
    if (vscode.workspace.isTrusted) {
      services.history ??= new GitHistory(services.ws.folder.uri.fsPath);
    }
    const planner = new ChangePlanner({
      llm: this.client,
      ws: services.ws,
      lsp: services.lsp,
      syntax: this.parser,
      typeChecker: this.typeCheckerFor(services),
      history: services.history,
      rules: await this.projectRules(services),
      config: { level: cfg.level, evidenceChars: 16_000 },
    });
    const plan = await planner.plan(inv, spec, hooks);
    const lesson = await buildLesson(
      plan,
      {
        llm: this.client,
        ws: services.ws,
        level: cfg.level,
        evidence: inv.evidence,
        evidenceChars: 16_000,
      },
      hooks,
    );
    return lesson;
  }

  private showLesson(lesson: Lesson, query: string, campaign?: Campaign): LessonSession {
    const { plan } = lesson;
    const session: LessonSession = {
      id: crypto.randomUUID(),
      query,
      lesson,
      current: 0,
      finished: false,
      applied: false,
      score: { correct: 0, total: 0 },
      logged: false,
      campaignId: campaign?.id,
    };
    remember(this.lessons, session.id, session, KEEP.lessons);
    this.post({
      type: "lesson",
      lesson: {
        id: session.id,
        query,
        goal: lesson.goal,
        understanding: plan.spec.understanding,
        criteria: plan.spec.criteria,
        steps: lesson.steps.map((ls) => ({
          number: ls.step.number,
          label: ls.display.label,
        })),
        step: stepPayload(lesson, 0),
        stage: campaign ? this.stageView(campaign) : undefined,
      },
    });
    // 計画を作るときの注意は内部の情報なので、テストモードでだけ出す
    if (readConfig().testMode) {
      for (const w of plan.warnings.slice(0, 3)) {
        this.status(`⚠ ${w}`);
      }
    }
    return session;
  }

  /** 1ステップの答え合わせ → 判断の記録を見せて、次のステップ(最後ならまとめ)を渡す */
  private async handleLessonAnswer(m: Record<string, any>): Promise<void> {
    const session = this.lessons.get(String(m.lessonId ?? ""));
    if (!session) {
      this.fail(
        new Error("この手順は失効しました。もう一度依頼してください。"),
        "",
      );
      return;
    }
    const index = Number(m.index);
    if (session.finished || index !== session.current) {
      return; // 二重送信
    }
    const ls = session.lesson.steps[index]!;
    const picks: number[] = Array.isArray(m.blanks) ? m.blanks.map(Number) : [];
    const hints: number[] = Array.isArray(m.hints) ? m.hints.map(Number) : [];
    const chosen: number[] = Array.isArray(m.choices)
      ? m.choices.map(Number)
      : [];

    let grades: unknown[] = [];
    if (ls.item) {
      const graded = gradeItem(ls.item, picks, hints);
      grades = graded.grades;
      session.score.correct += graded.grades.filter((g) => g.correct).length;
      session.score.total += graded.grades.length;
      await this.log.record(graded.records, Date.now(), !session.logged);
      session.logged = true;
    }
    let question: ReturnType<typeof gradeQuestion> | undefined;
    if (ls.question) {
      question = gradeQuestion(ls.question, chosen);
      session.score.total++;
      if (question.correct) {
        session.score.correct++;
      }
      await this.log.recordConceptOnly(
        [{ concept: ls.question.concept, correct: question.correct }],
        !session.logged,
      );
      session.logged = true;
    }
    session.current++;
    const hasNext = session.current < session.lesson.steps.length;
    session.finished = !hasNext;
    const cfg = readConfig();
    const final = finalPayload(session.lesson);
    this.post({
      type: "lessonStep",
      lessonId: session.id,
      index,
      result: {
        grades,
        question,
        reveal: revealPayload(session.lesson, index),
      },
      next: hasNext ? stepPayload(session.lesson, session.current) : undefined,
      final: hasNext
        ? undefined
        : {
            ...final,
            // 計画の注意・型検査を行わなかった理由は内部の情報なので、テストモードでだけ渡す
            warnings: cfg.testMode ? final.warnings : [],
            typecheck: cfg.testMode
              ? final.typecheck
              : { ...(final.typecheck as object), note: undefined },
            score: session.score,
            canTest: !!cfg.testCommand,
            testCommand: cfg.testCommand,
            stage: this.nextStageView(session),
          },
    });
    await this.pushState();
  }

  /** 計画したすべてのファイルを1つの編集として反映する(計画のあとに変わったファイルがあれば中止) */
  private async handleLessonApply(lessonId: string): Promise<void> {
    const session = this.lessons.get(lessonId);
    const services = this.services;
    if (!session || !services) {
      this.fail(
        new Error("反映対象が見つかりません(手順が失効した可能性があります)。"),
        "",
      );
      return;
    }
    if (!session.finished) {
      this.fail(new Error("先にすべてのステップを確かめてください。"), "");
      return;
    }
    if (session.applied) {
      this.status("この手順は反映済みです。");
      return;
    }
    const { plan } = session.lesson;
    if (await this.movedSincePlan(session, services)) {
      return;
    }
    const created = plan.files.filter((f) => f.original === null).length;
    const notes = [
      `${plan.files.length}ファイルを変更します${created > 0 ? `(うち新規作成 ${created})` : ""}: ${plan.files.map((f) => f.path).join(", ")}`,
      plan.typecheck.remaining.length > 0
        ? `⚠ 解消できなかった型エラーが${plan.typecheck.remaining.length}件あります。`
        : "",
      plan.obligations.some((o) => o.status !== "done")
        ? "⚠ 判断しきれなかった確認事項があります(まとめを確認してください)。"
        : "",
      "反映後は「反映を取り消す」で元に戻せます(各ファイルの元に戻す操作でも戻せます)。",
    ].filter(Boolean);
    const choice = await vscode.window.showWarningMessage(
      "実装の手順をファイルに反映します。",
      { modal: true, detail: notes.join("\n") },
      "反映する",
    );
    if (choice !== "反映する") {
      return;
    }
    if (!(await this.applyLessonFiles(session, services))) {
      return;
    }
    const first = plan.files.find((f) => f.original !== null) ?? plan.files[0];
    if (first) {
      await vscode.window.showTextDocument(services.ws.uriOf(first.path), {
        preview: false,
      });
    }
    this.status(
      `✅ ${plan.files.length}ファイルに反映しました(保存はまだしていません)。`,
    );
  }

  /** 計画を作ったあとにファイルが変わっていたら、理由を表示して true */
  private async movedSincePlan(session: LessonSession, services: Services): Promise<boolean> {
    const moved = await changedSince(services.ws, session.lesson.plan.files, "original");
    if (moved.length > 0) {
      this.fail(
        new Error(
          `計画を作ったあとに次のファイルが変更されたため、反映を中止しました: ${moved.join(", ")}\nもう一度依頼すると、今の内容で計画し直します。`,
        ),
        "",
      );
    }
    return moved.length > 0;
  }

  /** 手順で計画したファイルをすべて反映する(確認ダイアログは呼び出し側で出す) */
  private async applyLessonFiles(session: LessonSession, services: Services): Promise<boolean> {
    if (!(await applyPlanFiles(services.ws, session.lesson.plan.files, "apply"))) {
      throw new Error("編集を適用できませんでした。");
    }
    session.applied = true;
    this.post({
      type: "lessonApplied",
      lessonId: session.id,
      canTest: !!readConfig().testCommand,
    });
    return true;
  }

  private async handleLessonRevert(lessonId: string): Promise<void> {
    const session = this.lessons.get(lessonId);
    const services = this.services;
    if (!session || !services || !session.applied) {
      return;
    }
    const { plan } = session.lesson;
    const moved = await changedSince(services.ws, plan.files, "final");
    if (moved.length > 0) {
      this.fail(
        new Error(
          `反映したあとに次のファイルが編集されたため、自動では取り消せません: ${moved.join(", ")}\n各ファイルで元に戻す操作をしてください。`,
        ),
        "",
      );
      return;
    }
    if (!(await applyPlanFiles(services.ws, plan.files, "revert"))) {
      throw new Error("取り消しを適用できませんでした。");
    }
    session.applied = false;
    this.post({ type: "lessonReverted", lessonId });
    this.status("反映を取り消しました。");
  }

  /** 設定されたテストコマンドを、反映したファイルを保存してから実行する */
  private async handleLessonTest(lessonId: string): Promise<void> {
    const session = this.lessons.get(lessonId);
    const services = this.services;
    const command = readConfig().testCommand;
    if (!session || !services || !session.applied || !command) {
      return;
    }
    if (this.busy) {
      this.status("前の処理が終わるまでお待ちください。");
      return;
    }
    if (!vscode.workspace.isTrusted) {
      this.fail(
        new Error(
          "信頼されていないワークスペースでは、テストコマンドを実行しません。",
        ),
        "",
      );
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `テストを実行します: ${command}`,
      {
        modal: true,
        detail: `反映したファイルを保存してから、${services.ws.folder.uri.fsPath} で実行します。`,
      },
      "保存して実行",
    );
    if (choice !== "保存して実行") {
      return;
    }
    await savePlanFiles(services.ws, session.lesson.plan.files);
    this.busy = true;
    this.abort = new AbortController();
    await this.pushState();
    try {
      this.status(`テストを実行中: ${command}`, true);
      const result = await runTestCommand(
        command,
        services.ws.folder.uri.fsPath,
        this.abort.signal,
      );
      this.post({
        type: "lessonTest",
        lessonId,
        ok: result.ok,
        code: result.code,
        output: result.output,
        command,
      });
    } finally {
      this.busy = false;
      this.abort = undefined;
      await this.pushState();
    }
  }

  // ---------- 段階に分けた依頼(依頼全体が完成するまで回す) ----------

  /** 依頼全体の中での今の段階(画面の「段階の地図」用) */
  private stageView(campaign: Campaign): Record<string, unknown> {
    return {
      campaignId: campaign.id,
      index: campaign.current,
      total: campaign.stages.length,
      label: campaign.stages[campaign.current]?.label ?? "",
      roadmap: campaign.stages.map((s, i) => ({
        label: s.label,
        goal: s.goal,
        status:
          i < campaign.current
            ? (campaign.done[i]?.status ?? "applied")
            : i === campaign.current
              ? "current"
              : "todo",
      })),
    };
  }

  /** 手順を終えたときの、次の段階への案内(今の段階の手順でなければ undefined) */
  private nextStageView(session: LessonSession): Record<string, unknown> | undefined {
    const campaign = session.campaignId ? this.campaigns.get(session.campaignId) : undefined;
    if (!campaign || campaign.lessonId !== session.id) {
      return undefined;
    }
    return {
      campaignId: campaign.id,
      index: campaign.current,
      total: campaign.stages.length,
      label: campaign.stages[campaign.current]?.label ?? "",
      next: campaign.stages[campaign.current + 1]?.label,
    };
  }

  /**
   * 今の段階を進める。review: 先に済んだ段階と依頼全体の受け入れ条件を見比べて、残りの段階を見直す。
   * 残りが無ければ完成として締めくくる。計画できない・中止された・API のエラーでも依頼は止めず、計画し直す/飛ばすを選べるようにする。
   */
  private async continueCampaign(
    services: Services,
    agent: QuizAgent,
    campaign: Campaign,
    hooks: RunHooks,
    review: boolean,
  ): Promise<void> {
    campaign.lessonId = undefined;
    try {
      let reason = "";
      if (review) {
        const cfg = readConfig();
        const r = await reviewProgress(
          this.client,
          { level: cfg.level, maxPlaces: STAGE_SIZE.places, maxLines: STAGE_SIZE.lines },
          campaign.overall,
          campaign.done,
          campaign.stages.slice(campaign.current),
          hooks,
        );
        campaign.stages = [...campaign.stages.slice(0, campaign.current), ...r.remaining];
        reason = r.reason;
      }
      if (campaign.current >= campaign.stages.length || campaign.current >= MAX_STAGES) {
        this.finishCampaign(campaign, reason);
        return;
      }
      const spec = stageSpec(campaign.overall, campaign.stages, campaign.current, campaign.done);
      if (campaign.done.length > 0) {
        // 前の段階の変更が入った今のコードで調べ直す(行番号・内容が変わっているため)
        campaign.inv = await agent.investigateStage(
          campaign.inv,
          spec,
          campaign.done.flatMap((d) => d.focus),
          hooks,
        );
      }
      const lesson = await this.buildPlanLesson(services, campaign.inv, spec, hooks);
      campaign.lessonId = this.showLesson(lesson, campaign.query, campaign).id;
    } catch (error) {
      this.post({
        type: "stageBlocked",
        campaignId: campaign.id,
        index: campaign.current,
        total: campaign.stages.length,
        label: campaign.stages[campaign.current]?.label ?? "",
        canSkip: campaign.current < campaign.stages.length,
        reason: hooks.signal?.aborted
          ? "中止しました。"
          : errorMessage(error, "この段階を計画できませんでした。"),
      });
    }
  }

  /** 依頼全体が完成した(または段階の上限に達した)ときのまとめ */
  private finishCampaign(campaign: Campaign, reason: string): void {
    const remaining = campaign.stages.slice(campaign.current);
    this.post({
      type: "campaignDone",
      campaignId: campaign.id,
      query: campaign.query,
      understanding: campaign.overall.understanding,
      criteria: campaign.overall.criteria,
      stages: campaign.done.map((d) => ({
        label: d.label,
        status: d.status,
        statusText: statusLabel(d.status),
        files: d.files,
      })),
      complete: remaining.length === 0,
      remaining: remaining.map((s) => s.label),
      limit: MAX_STAGES,
      reason,
      files: [...new Set(campaign.done.flatMap((d) => d.files))],
    });
  }

  /** 段階を1つ終えたことを記録し、残りを見直して次の段階へ進む */
  private async advanceCampaign(services: Services, campaign: Campaign, result: StageResult): Promise<void> {
    campaign.done.push(result);
    campaign.current++;
    await this.withAgent(services, (agent, hooks) =>
      this.continueCampaign(services, agent, campaign, hooks, true),
    );
  }

  /** 今の段階を終えて次へ(反映していなければ、反映して進むか、そのまま進むかを選んでもらう) */
  private async handleStageNext(campaignId: string): Promise<void> {
    const campaign = this.campaigns.get(campaignId);
    let advanced = false;
    try {
      const session = campaign?.lessonId ? this.lessons.get(campaign.lessonId) : undefined;
      if (!campaign || !session) {
        this.fail(new Error("この依頼の段階は失効しました。もう一度依頼してください。"), "");
        return;
      }
      if (!session.finished) {
        this.fail(new Error("先にこの段階のステップを最後まで確かめてください。"), "");
        return;
      }
      const services = await this.readyServices();
      if (!services) {
        return;
      }
      const stage = campaign.stages[campaign.current]!;
      const name = `${campaign.current + 1}段階目「${stage.label}」`;
      const following = campaign.stages[campaign.current + 1];
      const then = following
        ? `次の段階「${following.label}」の前に、依頼全体の受け入れ条件と見比べて残りの段階を見直し、今のファイルの内容で調べ直します。`
        : "予定した段階はこれで最後です。依頼全体の受け入れ条件と見比べて、完成したかを確かめます(足りなければ段階を足して続けます)。";
      let status: StageResult["status"];
      if (session.applied) {
        const choice = await vscode.window.showWarningMessage(
          `${name}を終えて進みます。`,
          { modal: true, detail: `反映した変更を保存してから進みます。\n${then}` },
          "保存して進む",
        );
        if (choice !== "保存して進む") {
          return;
        }
        status = "applied";
      } else {
        const choice = await vscode.window.showWarningMessage(
          `${name}の変更は、まだファイルに入っていません。`,
          {
            modal: true,
            detail: [
              "反映して進む: 計画した変更をファイルに反映・保存してから進みます。",
              "反映せずに進む: 自分で書いた変更など、今のファイルの内容のまま進みます。",
              "",
              then,
            ].join("\n"),
          },
          "反映して進む",
          "反映せずに進む",
        );
        if (!choice) {
          return;
        }
        if (choice === "反映して進む") {
          if ((await this.movedSincePlan(session, services)) || !(await this.applyLessonFiles(session, services))) {
            return;
          }
          status = "applied";
        } else {
          status = "unapplied";
        }
      }
      if (this.busy) {
        this.status("前の処理が終わるまでお待ちください。");
        return;
      }
      const { plan } = session.lesson;
      if (status === "applied") {
        // 次の段階の型検査はディスクの内容を読むので、反映した変更を保存しておく
        await savePlanFiles(services.ws, plan.files);
      }
      advanced = true;
      await this.advanceCampaign(services, campaign, {
        label: stage.label,
        goal: stage.goal,
        status,
        summary: session.lesson.overall,
        files: plan.files.map((f) => f.path),
        focus: changedFocus(plan.files),
      });
    } finally {
      if (!advanced && campaign) {
        this.post({ type: "stageIdle", campaignId: campaign.id });
      }
    }
  }

  /** 計画できなかった段階を、今の内容で調べ直して計画し直す(完成の確認で止まっていたら、確認をやり直す) */
  private async handleStageRetry(campaignId: string): Promise<void> {
    const campaign = this.campaigns.get(campaignId);
    let started = false;
    try {
      if (!campaign || campaign.lessonId) {
        return;
      }
      const services = await this.readyServices();
      if (!services) {
        return;
      }
      started = true;
      await this.withAgent(services, (agent, hooks) =>
        this.continueCampaign(services, agent, campaign, hooks, campaign.current >= campaign.stages.length),
      );
    } finally {
      if (!started && campaign) {
        this.post({ type: "stageIdle", campaignId: campaign.id });
      }
    }
  }

  /** 計画できなかった段階を飛ばして次へ(飛ばした内容は、残りの段階の見直しで扱う) */
  private async handleStageSkip(campaignId: string): Promise<void> {
    const campaign = this.campaigns.get(campaignId);
    let advanced = false;
    try {
      const stage = campaign?.stages[campaign.current];
      if (!campaign || campaign.lessonId || !stage) {
        return;
      }
      const services = await this.readyServices();
      if (!services) {
        return;
      }
      advanced = true;
      await this.advanceCampaign(services, campaign, {
        label: stage.label,
        goal: stage.goal,
        status: "skipped",
        summary: "",
        files: [],
        focus: [],
      });
    } finally {
      if (!advanced && campaign) {
        this.post({ type: "stageIdle", campaignId: campaign.id });
      }
    }
  }

  // ---------- テストモード: OpenAI API の実行前確認・使用量 ----------

  private async confirmApi(info: ApiRequestInfo): Promise<void> {
    const testMode = readConfig().testMode;
    if (info.channel === "assist-auto") {
      // 自動の候補は確認ダイアログを出さない(テストモードの間は呼ばない)
      if (testMode) {
        throw new LlmError("テストモードのため、自動の候補は出しません。");
      }
      return;
    }
    if (!testMode || (info.channel === "main" && this.approveRest)) {
      return;
    }
    const kind = info.kind === "chat" ? "チャット" : info.kind === "decision" ? "判定" : "埋め込み";
    // 「以降確認しない」は依頼の処理のためのもの(入力補助は1回ずつ確認する)
    const buttons = info.channel === "main" ? ["実行する", "この処理では以降確認しない"] : ["実行する"];
    const choice = await vscode.window.showWarningMessage(
      `OpenAI API を呼び出します: ${info.purpose}`,
      {
        modal: true,
        detail: [
          `入力トークン数: 約 ${info.inputTokens.toLocaleString()}(見積もり)`,
          `モデル: ${info.model}(${kind})`,
          "",
          "この確認はテストモードでだけ行います。サイドバーの設定の「テストモード」または設定 quizSupport.testMode でオフにできます。",
        ].join("\n"),
      },
      ...buttons,
    );
    if (!choice) {
      throw new LlmError("OpenAI API の呼び出しを取り消しました。");
    }
    if (choice === "この処理では以降確認しない") {
      this.approveRest = true;
    }
  }

  private countUsage(info: ApiUsageInfo): void {
    // 入力補助は依頼の処理の集計に混ぜない
    if (info.channel !== "main") {
      this.assistUsage.cached += info.cachedInputTokens ?? 0;
    }
    const u = info.channel === "main" ? this.usage : this.assistUsage;
    u.calls++;
    u.estimated += info.inputTokens;
    u.actual += info.actualInputTokens ?? 0;
    u.output += info.outputTokens ?? 0;
  }

  /** 処理の始めに、確認の省略と使用量の集計を戻す */
  private beginOperation(): void {
    this.approveRest = false;
    this.usage = { calls: 0, estimated: 0, actual: 0, output: 0 };
  }

  /** 処理ごとの使用量はテストモードでだけ表示する */
  private reportUsage(): void {
    const u = this.usage;
    if (u.calls === 0 || !readConfig().testMode) {
      return;
    }
    const input =
      u.actual > 0
        ? `${u.actual.toLocaleString()}(実測)`
        : `約${u.estimated.toLocaleString()}(見積もり)`;
    this.status(
      `API 使用量: ${u.calls}回 / 入力 ${input}${u.output > 0 ? ` / 出力 ${u.output.toLocaleString()}` : ""} トークン`,
    );
  }

  /** 出題を始められる状態か確かめる(できなければ理由を表示して undefined) */
  private async readyServices(): Promise<Services | undefined> {
    if (this.busy) {
      this.status("前の処理が終わるまでお待ちください。");
      return undefined;
    }
    if (!this.apiKey) {
      this.fail(
        new Error(
          "OpenAI APIキーが未設定です。上の案内またはサイドバーの「設定」から設定してください。",
        ),
        "",
      );
      return undefined;
    }
    const services = await this.ensureServices();
    if (!services) {
      this.fail(new Error("フォルダを開いてから使ってください。"), "");
    }
    return services;
  }

  /** 処理中の表示・中止ボタンを有効にして、エージェントを使う処理を行う。 */
  private async withAgent(
    services: Services,
    work: (agent: QuizAgent, hooks: RunHooks) => Promise<void>,
  ): Promise<void> {
    const cfg = readConfig();
    this.busy = true;
    this.abort = new AbortController();
    this.beginOperation();
    await this.pushState();
    try {
      const agent = new QuizAgent({
        llm: this.client,
        decider: this.client,
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
      await work(agent, {
        onStatus: (s) => this.status(cfg.testMode ? s : friendlyStatus(s), true),
        signal: this.abort.signal,
      });
    } finally {
      this.busy = false;
      this.abort = undefined;
      this.reportUsage();
      await this.pushState();
    }
  }

  private async presentQuiz(
    services: Services,
    result: AgentResult,
    query: string,
  ): Promise<void> {
    let questions: McqQuestion[] = [];
    const first = result.quiz.items[0];
    if (readConfig().structureQuestions && first) {
      this.status("呼び出し関係を整理中...", true);
      questions = (
        await buildStructureQuestions(
          { ws: services.ws, lsp: services.lsp },
          first,
          makeRng(Date.now()),
        )
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
    remember(this.sessions, session.id, session, KEEP.quizzes);
    this.post({
      type: "quiz",
      quiz: this.payloadOf(session, query, result.quiz.goal),
    });
    if (result.quiz.notice) {
      this.status(`⚠ ${result.quiz.notice}`);
    }
    if (result.quiz.rejected.length > 0 && readConfig().testMode) {
      this.status(
        `検証に通らなかった${result.quiz.rejected.length}件は作り直し、直らなかったものは除外しました。`,
      );
    }
  }

  private payloadOf(
    session: QuizSession,
    query: string,
    goal: string,
  ): Record<string, unknown> {
    return {
      id: session.id,
      query,
      goal,
      review: session.review,
      items: session.items.map((item, index) => itemPayload(item, index)),
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
      this.fail(
        new Error("この内容は失効しました。もう一度質問してください。"),
        "",
      );
      return;
    }
    if (session.graded) {
      return;
    }
    // 空欄ごとに選んだ選択肢の番号(未選択は -1)
    const picked: number[][] = Array.isArray(m.blanks)
      ? m.blanks.map((a: unknown) => (Array.isArray(a) ? a.map(Number) : []))
      : [];
    const hints: number[][] = Array.isArray(m.hints)
      ? m.hints.map((a: unknown) => (Array.isArray(a) ? a.map(Number) : []))
      : [];
    const choices: number[][] = Array.isArray(m.choices)
      ? m.choices.map((a: unknown) => (Array.isArray(a) ? a.map(Number) : []))
      : [];

    this.status("確認中...", true);
    const results: BlankResult[] = [];
    const itemResults: Array<{
      grades: ReturnType<typeof gradeItem>["grades"];
      explanation: string;
      canApply: boolean;
      completed?: string;
    }> = [];
    let correct = 0;
    let total = 0;

    for (const [i, item] of session.items.entries()) {
      const graded = gradeItem(item, picked[i] ?? [], hints[i] ?? []);
      correct += graded.grades.filter((g) => g.correct).length;
      total += graded.grades.length;
      const answerList = item.blanks.map((b) => b.answer);
      itemResults.push({
        grades: graded.grades,
        explanation: item.explanation,
        canApply: item.kind === "change" && !session.review,
        // 変更問題は、空欄以外も含めた完成形を見せて「どこがどう変わるか」を確認できるようにする
        completed:
          item.kind === "change" && !session.review
            ? compactDiff(
                item.original,
                resolveBlanks(item.quizCode, answerList),
              )
            : undefined,
      });
      results.push(...graded.records);
    }

    const questionResults = session.questions.map((q, i) => {
      const r = gradeQuestion(q, choices[i] ?? []);
      total++;
      if (r.correct) {
        correct++;
      }
      return { ...r, explanation: q.explanation, concept: q.concept };
    });

    session.graded = true;
    await this.log.record(results);
    await this.log.recordConceptOnly(
      questionResults.map((q) => ({ concept: q.concept, correct: q.correct })),
    );
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
      this.fail(
        new Error(
          "反映対象が見つかりません(内容が失効した可能性があります)。",
        ),
        "",
      );
      return;
    }
    if (item.kind !== "change" || session.review) {
      this.fail(
        new Error(
          "これは既存コードを読み解く内容なので、反映するものはありません。",
        ),
        "",
      );
      return;
    }
    if (!session.graded) {
      this.fail(new Error("先に考えを確かめてください。"), "");
      return;
    }
    const uri = services.ws.uriOf(item.path);
    const doc = await vscode.workspace.openTextDocument(uri);
    // 生成時の内容と一致するか検証(不一致なら例外)
    applyItemToText(doc.getText(), item);

    const choice = await vscode.window.showWarningMessage(
      `${item.path} の ${item.startLine}〜${item.endLine} 行目を、このコードで書き換えます。`,
      {
        modal: true,
        detail: "反映後は通常の編集と同じく、元に戻す(Undo)で取り消せます。",
      },
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
    const range = new vscode.Range(
      item.startLine - 1,
      0,
      item.endLine - 1,
      doc.lineAt(item.endLine - 1).text.length,
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, range, resolved);
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error("編集を適用できませんでした。");
    }
    await vscode.window.showTextDocument(doc, {
      preview: false,
      selection: new vscode.Range(item.startLine - 1, 0, item.startLine - 1, 0),
    });
    this.status(
      `✅ ${item.path} の ${item.startLine}〜${item.endLine} 行目に反映しました(Undoで元に戻せます)。`,
    );
  }

  /**
   * ワークスペース内の場所を開く。text があれば、その内容の行を line の近くから探し直す
   * (手順の行番号は計画の途中の位置なので、反映前・反映後どちらでも正しい行を開くため)。
   */
  private async handleOpen(
    relPath: string,
    line: number,
    text?: string,
  ): Promise<void> {
    const services = this.services;
    if (!services || !relPath) {
      return;
    }
    const rel = relPath.replace(/\\/g, "/");
    if (rel.startsWith("/") || rel.split("/").includes("..")) {
      return;
    }
    let target = Math.max(line, 1);
    const wanted = text?.trim();
    if (wanted) {
      const lines = splitLines(await services.ws.readText(rel).catch(() => ""));
      let best = -1;
      lines.forEach((l, i) => {
        if (
          l.trim() === wanted &&
          (best < 0 || Math.abs(i + 1 - line) < Math.abs(best + 1 - line))
        ) {
          best = i;
        }
      });
      if (best >= 0) {
        target = best + 1;
      }
    }
    const pos = new vscode.Position(target - 1, 0);
    await vscode.window.showTextDocument(services.ws.uriOf(rel), {
      selection: new vscode.Range(pos, pos),
      preview: true,
    });
  }

  // ---------- 復習 ----------

  private async handleReview(): Promise<void> {
    if (this.busy) {
      return;
    }
    const cards: ReviewCard[] = this.log.dueCards(Date.now(), 5);
    if (cards.length === 0) {
      this.status("いま振り返る箇所はありません。");
      return;
    }
    const items: QuizItem[] = cards.map((c) => ({
      kind: "read",
      path: c.path,
      startLine: c.startLine,
      endLine: c.endLine,
      original: "",
      quizCode: c.snippet,
      // 旧データの復習カードには選択肢が無いので、正解を少しずつ変えた誤答で作る
      blanks: [
        {
          answer: c.answer,
          concept: c.concept,
          hints: c.hints,
          why: c.why,
          choices: c.choices ?? reviewChoices(c),
        },
      ],
      explanation: "",
    }));
    const session: QuizSession = {
      id: crypto.randomUUID(),
      review: true,
      items,
      questions: [],
      overall:
        "判断が分かれた箇所は、間隔を空けてまた振り返ります。",
      graded: false,
    };
    remember(this.sessions, session.id, session, KEEP.quizzes);
    this.post({
      type: "quiz",
      quiz: this.payloadOf(
        session,
        "振り返り",
        "前に判断が分かれた・手がかりを使った箇所を、もう一度考えます。",
      ),
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
    const plan = await services.index.prepare(undefined, (s) =>
      this.status(s, true),
    );
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
      // 確認画面(トークン数の見積もり)を見せずに埋め込みを始めない。最新の見積もりを出し直して、押し直してもらう
      await this.handlePlan();
      return;
    }
    const plan = this.pendingPlan;
    this.pendingPlan = undefined;
    this.busy = true;
    this.abort = new AbortController();
    this.beginOperation();
    // 更新の画面でトークン数を見せて押してもらっているので、埋め込みの呼び出しごとには確認しない
    this.approveRest = true;
    await this.pushState();
    try {
      const stats = await services.index.commit(
        plan,
        { embed: embed && !!this.apiKey },
        (s) => this.status(s, true),
        this.abort.signal,
      );
      this.status(
        `インデックスを更新しました(${stats.files}ファイル / ${stats.chunks}チャンク / ベクトル${stats.vectors}件${embed ? "" : "・キーワード検索のみ"})。`,
      );
      this.reportUsage();
    } finally {
      this.approveRest = false;
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
    this.status(
      "索引を削除しました。キーワード検索の索引は自動で作り直します(意味検索はサイドバーの「設定」→「索引」から有効にできます)。",
    );
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
