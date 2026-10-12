/**
 * 最小限の .gitignore 解釈(コメント、否定 !、先頭/、末尾/、*、**、?)。
 * 完全互換ではないが、node_modules/dist/build 等の典型的な除外を賄う。
 */
interface Rule {
  regex: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

function globToRegexSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close > i) {
        const alts = glob.slice(i + 1, close).split(",").map(globToRegexSource);
        out += `(?:${alts.join("|")})`;
        i = close;
      } else {
        out += "\\{";
      }
    } else if (/[.+^$()|\\[\]]/.test(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return out;
}

export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${globToRegexSource(glob)}$`);
}

export class IgnoreFilter {
  private readonly rules: Rule[] = [];

  constructor(patterns: string[]) {
    for (const raw of patterns) {
      let line = raw.replace(/\r$/, "").trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      let negate = false;
      if (line.startsWith("!")) {
        negate = true;
        line = line.slice(1);
      }
      let dirOnly = false;
      if (line.endsWith("/")) {
        dirOnly = true;
        line = line.slice(0, -1);
      }
      const anchored = line.startsWith("/") || line.slice(0, -1).includes("/");
      line = line.replace(/^\//, "");
      const source = globToRegexSource(line);
      const regex = new RegExp(anchored ? `^${source}$` : `^(?:.*/)?${source}$`);
      this.rules.push({ regex, negate, dirOnly });
    }
  }

  /** 相対パス(/区切り)が除外対象か。親ディレクトリの除外も考慮する。 */
  isIgnored(relPath: string): boolean {
    const parts = relPath.split("/");
    let ignored = false;
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join("/");
      const isDir = i < parts.length;
      for (const rule of this.rules) {
        if (rule.dirOnly && !isDir) {
          continue;
        }
        if (rule.regex.test(sub)) {
          ignored = !rule.negate;
        }
      }
      if (ignored && isDir) {
        return true;
      }
    }
    return ignored;
  }
}

export const DEFAULT_IGNORES = [
  "node_modules/",
  ".git/",
  "dist/",
  "out/",
  "build/",
  "coverage/",
  ".vscode-test/",
  ".next/",
  "target/",
  "__pycache__/",
  "*.min.js",
  "*.map",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
];
