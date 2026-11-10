import { searchPath } from "./compile.ts";
import type { GitRefs } from "./host-api.ts";
import { isProjectPath } from "./project.ts";

/** Refs git is asked about: names, SHAs and forms like HEAD~1; never an option or anything with spaces. */
const SAFE_REF = /^[A-Za-z0-9._/@{}^~-]+$/;

/** What git said: its output, and whether it succeeded. Null when git isn't installed. */
interface Run {
  ok: boolean;
  out: string;
  err: string;
}

/**
 * Settings a repository's config can't override: no fsmonitor command, which a folder received from someone else could
 * name in its .git/config, and git runs while it reads the working tree.
 */
const SAFE_CONFIG = ["-c", "core.fsmonitor=false"];

let found: Promise<string | null> | null = null;

/**
 * The git to run, found once; null when there is none. On macOS /usr/bin/git is a stub without the command line tools,
 * and running it asks the user to install them, so it counts only when `xcode-select -p` finds them.
 */
function program(): Promise<string | null> {
  found ??= (async () => {
    const path = Bun.which("git", { PATH: searchPath() });
    if (!path || process.platform !== "darwin" || path !== "/usr/bin/git") return path;
    try {
      const check = Bun.spawn(["/usr/bin/xcode-select", "-p"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      return (await check.exited) === 0 ? path : null;
    } catch {
      return null;
    }
  })();
  return found;
}

async function git(folder: string, args: string[]): Promise<Run | null> {
  const path = await program();
  if (!path) return null;
  try {
    const child = Bun.spawn([path, ...SAFE_CONFIG, ...args], {
      cwd: folder,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, PATH: searchPath(), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { ok: code === 0, out, err };
  } catch {
    return null;
  }
}

function checkRef(ref: string) {
  if (!SAFE_REF.test(ref) || ref.startsWith("-")) throw new Error(`"${ref}" isn't a git ref the app can compare with`);
}

/** The absolute path of the repository's .git folder that holds the project folder; null when it isn't in a repository. */
export async function gitDir(folder: string): Promise<string | null> {
  const run = await git(folder, ["rev-parse", "--absolute-git-dir"]);
  return run?.ok ? run.out.trim() || null : null;
}

/** HEAD's commit and the tags, newest first; null when the folder isn't in a git repository. */
export async function gitRefs(folder: string): Promise<GitRefs | null> {
  if (!(await gitDir(folder))) return null;
  const head = await git(folder, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const format = "%(refname:short)%09%(*objectname)%09%(objectname)%09%(creatordate:iso-strict)";
  const list = await git(folder, ["for-each-ref", "--sort=-creatordate", `--format=${format}`, "refs/tags"]);
  const tags = (list?.ok ? list.out : "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", peeled = "", object = "", date = ""] = line.split("\t");
      return { name, commit: peeled || object, date };
    });
  return { head: head?.ok ? head.out.trim() || null : null, tags };
}

/** A file of the project at a ref; null when it isn't there (or the repository has no commits). Throws for a bad ref. */
export async function fileAt(folder: string, ref: string, path: string): Promise<string | null> {
  checkRef(ref);
  if (!isProjectPath(path)) throw new Error(`"${path}" isn't a path in the project`);
  const run = await git(folder, ["show", "--no-textconv", "--end-of-options", `${ref}:./${path}`]);
  if (!run) return null;
  if (run.ok) return run.out;
  if (/does not exist|exists on disk, but not in|not a git repository/.test(run.err)) return null;
  if (ref === "HEAD" && (await gitRefs(folder))?.head === null) return null;
  throw new Error(run.err.trim() || `git couldn't show ${path} at ${ref}`);
}

/**
 * The project's files that differ from a ref on disk: changed, added, and untracked but not ignored. As in the editor's
 * marks, changes of whitespace alone don't count, and files deleted since aren't listed.
 */
export async function changedSince(folder: string, ref: string): Promise<string[]> {
  checkRef(ref);
  const flags = ["--name-only", "-z", "--relative", "--no-ext-diff", "-w", "--ignore-blank-lines", "--diff-filter=d"];
  const diff = await git(folder, ["diff", ...flags, "--end-of-options", ref, "--"]);
  if (!diff) return [];
  if (!diff.ok) throw new Error(diff.err.trim() || `git couldn't compare with ${ref}`);
  const others = await git(folder, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const names = [...diff.out.split("\0"), ...(others?.ok ? others.out.split("\0") : [])];
  return [...new Set(names.filter((name) => name && isProjectPath(name)))];
}
