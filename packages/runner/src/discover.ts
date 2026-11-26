/** Find test files: a small glob (`**`, `*`, `?`) over the tree under the config. */
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".argus", ".wrangler"]);

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` spans any number of directories, including none.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += /[\\^$+.()|{}[\]]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`);
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (entry.isFile()) out.push(join(dir, entry.name));
  }
}

/** Absolute paths of the files under `rootDir` matching any pattern, sorted. */
export function discover(rootDir: string, patterns: string[]): string[] {
  const matchers = patterns.map((p) => globToRegExp(p.replace(/^\.\//, "")));
  const files: string[] = [];
  walk(rootDir, files);
  return files
    .filter((f) => {
      const rel = relative(rootDir, f).split(sep).join("/");
      return matchers.some((m) => m.test(rel));
    })
    .sort();
}
