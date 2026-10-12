import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_IGNORES, IgnoreFilter } from "../../../core/ignore";
import type { FileInfo, WorkspacePort } from "../../../core/ports";

export async function makeTempDir(prefix = "qbs-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
  }
}

export class NodeWorkspace implements WorkspacePort {
  readonly id: string;
  private filter: IgnoreFilter;

  constructor(private readonly root: string) {
    this.id = root;
    this.filter = new IgnoreFilter(DEFAULT_IGNORES);
  }

  async loadGitignore(): Promise<void> {
    try {
      const text = await fs.readFile(path.join(this.root, ".gitignore"), "utf8");
      this.filter = new IgnoreFilter([...DEFAULT_IGNORES, ...text.split("\n")]);
    } catch {
      // .gitignore なし
    }
  }

  async listFiles(): Promise<FileInfo[]> {
    const out: FileInfo[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(this.root, full).split(path.sep).join("/");
        if (this.filter.isIgnored(entry.isDirectory() ? rel + "/x" : rel)) {
          continue;
        }
        if (entry.isDirectory()) {
          await walk(full);
        } else {
          const st = await fs.stat(full);
          out.push({ path: rel, size: st.size, mtime: Math.floor(st.mtimeMs) });
        }
      }
    };
    await walk(this.root);
    return out;
  }

  async stat(p: string): Promise<FileInfo | undefined> {
    if (this.filter.isIgnored(p)) {
      return undefined;
    }
    try {
      const st = await fs.stat(path.join(this.root, p));
      return st.isFile() ? { path: p, size: st.size, mtime: Math.floor(st.mtimeMs) } : undefined;
    } catch {
      return undefined;
    }
  }

  readText(p: string): Promise<string> {
    return fs.readFile(path.join(this.root, p), "utf8");
  }
}

/** 文字列のハッシュから決定的に作る疑似埋め込み(単語袋)。意味は無いが共通語が多いほど近くなる。 */
export class FakeEmbedder {
  calls = 0;
  texts = 0;
  constructor(private readonly dim = 64) {}

  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    this.texts += texts.length;
    return texts.map((t) => {
      const v = new Array<number>(this.dim).fill(0);
      for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let h = 2166136261;
        for (let i = 0; i < w.length; i++) {
          h = Math.imul(h ^ w.charCodeAt(i), 16777619) >>> 0;
        }
        v[h % this.dim]! += 1;
      }
      return v;
    });
  }
}
