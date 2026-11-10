import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedSince, fileAt, gitDir, gitRefs } from "../core/git.ts";

const hasGit = Bun.which("git") !== null;

async function run(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  const err = await new Response(child.stderr).text();
  if ((await child.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
}

describe.skipIf(!hasGit)("git", () => {
  let root: string;
  let repo: string;
  let plain: string;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "neo-git-")));
    repo = join(root, "repo");
    plain = join(root, "plain");
    await mkdir(join(repo, "sub"), { recursive: true });
    await mkdir(plain);
    await run(repo, "init");
    await run(repo, "config", "user.name", "Test");
    await run(repo, "config", "user.email", "test@example.com");
    await writeFile(join(repo, "main.tex"), "one\n");
    await writeFile(join(repo, "sub", "chapter.tex"), "chapter one\n");
    await writeFile(join(repo, ".gitignore"), "*.log\n");
    await run(repo, "add", ".");
    await run(repo, "commit", "-m", "first");
    await run(repo, "tag", "-a", "-m", "submitted", "submission-v1");
    await writeFile(join(repo, "main.tex"), "two\n");
    await writeFile(join(repo, "sub", "chapter.tex"), "chapter two\n");
    await writeFile(join(repo, "new.tex"), "new\n");
    await writeFile(join(repo, "sub", "extra.tex"), "extra\n");
    await writeFile(join(repo, "build.log"), "log\n");
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  test("gitRefs gives HEAD and the tags, an annotated one as its commit", async () => {
    const refs = await gitRefs(repo);
    const head = (await Bun.$`git rev-parse HEAD`.cwd(repo).text()).trim();
    expect(refs?.head).toBe(head);
    expect(refs?.tags.map((tag) => tag.name)).toEqual(["submission-v1"]);
    expect(refs?.tags[0]?.commit).toBe(head);
    expect(Number.isNaN(Date.parse(refs!.tags[0]!.date))).toBe(false);
  });

  test("gitRefs is null outside a repository, and has no head before a commit", async () => {
    expect(await gitRefs(plain)).toBeNull();
    expect(await gitDir(plain)).toBeNull();
    const empty = join(root, "empty");
    await mkdir(empty);
    await run(empty, "init");
    expect(await gitRefs(empty)).toEqual({ head: null, tags: [] });
    expect(await fileAt(empty, "HEAD", "main.tex")).toBeNull();
  });

  test("gitDir is the repository's .git folder, from a subfolder too", async () => {
    expect(await gitDir(repo)).toBe(join(repo, ".git"));
    expect(await gitDir(join(repo, "sub"))).toBe(join(repo, ".git"));
  });

  test("fileAt reads a file at HEAD or a tag, and gives null for one that isn't there", async () => {
    expect(await fileAt(repo, "HEAD", "main.tex")).toBe("one\n");
    expect(await fileAt(repo, "submission-v1", "sub/chapter.tex")).toBe("chapter one\n");
    expect(await fileAt(repo, "HEAD", "new.tex")).toBeNull();
    expect(await fileAt(repo, "HEAD", "nothing.tex")).toBeNull();
  });

  test("fileAt throws for a bad ref and a bad path", async () => {
    await expect(fileAt(repo, "no-such-tag", "main.tex")).rejects.toThrow();
    await expect(fileAt(repo, "HEAD", "../main.tex")).rejects.toThrow();
  });

  test("changedSince lists changed and untracked files, not ignored ones", async () => {
    expect((await changedSince(repo, "HEAD")).sort()).toEqual(["main.tex", "new.tex", "sub/chapter.tex", "sub/extra.tex"]);
    expect((await changedSince(repo, "submission-v1")).sort()).toEqual(["main.tex", "new.tex", "sub/chapter.tex", "sub/extra.tex"]);
  });

  test("a project in a subfolder gets paths relative to it, and only its own", async () => {
    const sub = join(repo, "sub");
    expect((await changedSince(sub, "HEAD")).sort()).toEqual(["chapter.tex", "extra.tex"]);
    expect(await fileAt(sub, "HEAD", "chapter.tex")).toBe("chapter one\n");
  });

  test("changedSince leaves out whitespace-only changes and deleted files, and runs no fsmonitor the repository names", async () => {
    const other = join(root, "other");
    await mkdir(other);
    await run(other, "init");
    await run(other, "config", "user.name", "Test");
    await run(other, "config", "user.email", "test@example.com");
    await writeFile(join(other, "spaced.tex"), "a b\nc\n");
    await writeFile(join(other, "gone.tex"), "gone\n");
    await run(other, "add", ".");
    await run(other, "commit", "-m", "first");
    await writeFile(join(other, "spaced.tex"), "a    b\n\nc\n");
    await rm(join(other, "gone.tex"));
    const marker = join(root, "fsmonitor-ran");
    await run(other, "config", "core.fsmonitor", `touch ${marker}`);
    expect(await changedSince(other, "HEAD")).toEqual([]);
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("refs that could be options or odd text are refused", async () => {
    await expect(changedSince(repo, "--output=x")).rejects.toThrow();
    await expect(fileAt(repo, "--output=x", "main.tex")).rejects.toThrow();
    await expect(changedSince(repo, "a b")).rejects.toThrow();
    await expect(changedSince(repo, "")).rejects.toThrow();
  });
});
