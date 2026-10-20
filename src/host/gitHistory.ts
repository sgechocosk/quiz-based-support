import { execFile } from "node:child_process";
import type { HistoryPort } from "../core/ports";

/** `git log --name-only --format=%x1e` の出力を、コミットごとのファイル一覧にする */
export function parseGitLog(output: string): string[][] {
  return output
    .split("\x1e")
    .map((block) =>
      block
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    )
    .filter((files) => files.length > 0);
}

/** git の変更履歴(一緒に変更されてきたファイルを調べるのに使う)。git が無い・リポジトリでなければ空 */
export class GitHistory implements HistoryPort {
  private cache?: { head: string; commits: string[][] };

  constructor(
    private readonly root: string,
    private readonly limit = 400,
  ) {}

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        { cwd: this.root, maxBuffer: 32 * 1024 * 1024, timeout: 8000, windowsHide: true },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
  }

  private changedCache?: { at: number; files: string[] };

  /** 未コミットの変更があるファイル(ワークスペース相対。10秒は覚えておく)。取得できなければ空配列 */
  async changedFiles(): Promise<string[]> {
    if (this.changedCache && Date.now() - this.changedCache.at < 10_000) {
      return this.changedCache.files;
    }
    let files: string[] = [];
    try {
      const out = await this.run(["-c", "core.quotepath=off", "status", "--porcelain", "--untracked-files=normal", "--", "."]);
      files = out
        .split(/\r?\n/)
        .map((l) => l.slice(3).replace(/^.* -> /, "").trim())
        .filter(Boolean)
        .slice(0, 30);
    } catch {
      files = [];
    }
    this.changedCache = { at: Date.now(), files };
    return files;
  }

  async commits(): Promise<string[][]> {
    try {
      const head = (await this.run(["rev-parse", "HEAD"])).trim();
      if (this.cache?.head === head) {
        return this.cache.commits;
      }
      // --relative: このフォルダからの相対パスにし、フォルダの外の変更は含めない
      const out = await this.run([
        "-c",
        "core.quotepath=off",
        "log",
        "--no-merges",
        "--relative",
        "--name-only",
        "--format=%x1e",
        `-n${this.limit}`,
        "--",
        ".",
      ]);
      const commits = parseGitLog(out);
      this.cache = { head, commits };
      return commits;
    } catch {
      return [];
    }
  }
}
