import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGitRefPath, ProjectHost } from "../hosts/desktop/project-host.ts";

const hasGit = Bun.which("git") !== null;

async function run(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  const err = await new Response(child.stderr).text();
  if ((await child.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
}

describe("isGitRefPath", () => {
  test("matches the files that move with HEAD and the tags, reftable ones too", () => {
    for (const path of ["HEAD", "packed-refs", "refs/tags/x", "refs", "reftable/tables.list", "reftable"]) expect(isGitRefPath(path)).toBe(true);
    for (const path of ["index", "objects/ab/cdef", "config", "refsx/a", "COMMIT_EDITMSG"]) expect(isGitRefPath(path)).toBe(false);
  });
});

describe.skipIf(!hasGit)("ProjectHost git changes", () => {
  let root: string;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "neo-host-")));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  test("a tag made in the main repository is seen from a linked worktree", async () => {
    const repo = join(root, "repo");
    const linked = join(root, "linked");
    await mkdir(repo);
    await run(repo, "init");
    await run(repo, "config", "user.name", "Test");
    await run(repo, "config", "user.email", "test@example.com");
    await writeFile(join(repo, "main.tex"), "one\n");
    await run(repo, "add", ".");
    await run(repo, "commit", "-m", "first");
    await run(repo, "worktree", "add", "-b", "linked-branch", linked);
    const project = await ProjectHost.open(linked, { trash: async () => {} });
    try {
      let changes = 0;
      project.onGitChange(() => changes++);
      // The watchers start after git has been asked, so tag until one is seen.
      for (let i = 0; i < 40 && changes === 0; i++) {
        await run(repo, "tag", `t${i}`);
        await Bun.sleep(250);
      }
      expect(changes).toBeGreaterThan(0);
    } finally {
      project.close();
    }
  }, 20000);
});
