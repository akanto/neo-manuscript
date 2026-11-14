import { describe, expect, test } from "bun:test";
import type { DocumentState, GitRefs } from "../core/host-api.ts";
import type { MiradorBridge } from "../hosts/mirador/api.ts";
import { miradorBridge } from "../hosts/mirador/project.ts";

const HEAD_SHA = "a".repeat(40);

/** A workspace with files now and at HEAD, as Mirador's bridge serves them; `chapters/intro.tex` is the open document. */
function fakeMirador({ git }: { git: boolean }) {
  const now: Record<string, string> = {
    "main.tex": "\\documentclass{article}\nOne sentence.\n",
    "chapters/intro.tex": "Words   reflowed\nhere.\n",
    "chapters/new.tex": "Brand new.\n",
    "figure.pdf": "%PDF",
  };
  const atHead: Record<string, string> = {
    "main.tex": "\\documentclass{article}\nAnother sentence.\n",
    "chapters/intro.tex": "Words reflowed here.\n",
    "figure.pdf": "%PDF-old",
  };
  const gitListeners = new Set<() => void>();
  const asked: string[] = [];
  const base = {
    onState(listener: (state: DocumentState<unknown>) => void) {
      listener({ document: null, file: "chapters/intro.tex", lastChange: null, problem: null, task: null } as unknown as DocumentState<unknown>);
      return () => {};
    },
    apply() {},
    readFile: async (path: string) => {
      // Named from the document's folder, as Mirador's readFile names them.
      const named = path.replace(/^\.\.\//, "");
      if (!(named in now)) throw new Error(`${path} doesn't exist.`);
      return new Blob([now[named]!]);
    },
    listFiles: async () => ({ files: Object.keys(now), truncated: false }),
    open: async () => {},
    onFiles: () => () => {},
  };
  const gitMethods = {
    gitRefs: async (): Promise<GitRefs | null> => ({ head: HEAD_SHA, tags: [{ name: "v1", commit: HEAD_SHA, date: "2026-11-01T10:00:00+01:00" }] }),
    readFileAt: async (ref: string, path: string) => {
      asked.push(`${ref}:${path}`);
      return path in atHead ? new Blob([atHead[path]!]) : null;
    },
    changedSince: async () => ["main.tex", "chapters/intro.tex", "chapters/new.tex", "figure.pdf", "../outside.tex"],
    onGitChange: (listener: () => void) => {
      gitListeners.add(listener);
      return () => gitListeners.delete(listener);
    },
  };
  const mirador = Object.freeze(git ? { ...base, ...gitMethods } : base) as unknown as MiradorBridge<unknown>;
  return { mirador, gitListeners, asked };
}

describe("Mirador's view bridge and git", () => {
  test("a Mirador without the git methods gives the project none, so the view compares with the text as opened", () => {
    const { project } = miradorBridge(fakeMirador({ git: false }).mirador);
    expect(project.gitRefs).toBeUndefined();
    expect(project.fileAt).toBeUndefined();
    expect(project.changedSince).toBeUndefined();
    expect(project.onGitChange).toBeUndefined();
  });

  test("the refs and a file at a ref come from Mirador, as text, and null where the file isn't there", async () => {
    const { mirador, asked } = fakeMirador({ git: true });
    const { project } = miradorBridge(mirador);
    expect(await project.gitRefs!()).toEqual({ head: HEAD_SHA, tags: [{ name: "v1", commit: HEAD_SHA, date: "2026-11-01T10:00:00+01:00" }] });
    expect(await project.fileAt!("v1", "main.tex")).toBe("\\documentclass{article}\nAnother sentence.\n");
    expect(await project.fileAt!("HEAD", "chapters/new.tex")).toBeNull();
    expect(asked).toEqual(["v1:main.tex", "HEAD:chapters/new.tex"]);
  });

  test("changed files keep those with changed words, new ones and other kinds, and drop reflowed ones and paths out of the project", async () => {
    const { project } = miradorBridge(fakeMirador({ git: true }).mirador);
    expect((await project.changedSince!("HEAD")).sort()).toEqual(["chapters/new.tex", "figure.pdf", "main.tex"]);
  });

  test("Mirador's git changes reach the project's listeners until they stop listening", () => {
    const { mirador, gitListeners } = fakeMirador({ git: true });
    const { project } = miradorBridge(mirador);
    let heard = 0;
    const stop = project.onGitChange!(() => heard++);
    for (const listener of gitListeners) listener();
    expect(heard).toBe(1);
    stop();
    expect(gitListeners.size).toBe(0);
  });
});
