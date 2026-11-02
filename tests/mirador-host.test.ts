import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchPath } from "../core/compile.ts";
import { parseDocument, type TexDocument } from "../core/document.ts";
import host from "../hosts/mirador/host.ts";
import type { AppTaskContext } from "../hosts/mirador/api.ts";

const haveTex = ["latexmk", "pdflatex", "tectonic"].some((command) => Bun.which(command, { PATH: searchPath() }));

/** What Mirador gives a task, for a document in a folder of a workspace. */
function contextFor(workspace: string, folder: string, text: string): AppTaskContext<TexDocument> {
  const documentFolder = join(workspace, folder);
  return {
    document: parseDocument(text),
    file: (path) => join(documentFolder, path),
    documentFolder,
    workspaceFolder: workspace,
    pluginFolder: join(import.meta.dir, ".."),
    author: { kind: "you" },
    apply: () => Promise.reject(new Error("not here")),
    progress: () => {},
    signal: new AbortController().signal,
  };
}

describe("the Mirador host's compile task", () => {
  test("a Markdown file has nothing to build", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "neo-mirador-"));
    await writeFile(join(workspace, "README.md"), "# Notes\n\nSome *text*.\n");
    const summary = await host.tasks!.compile!.run(contextFor(workspace, "", "# Notes\n\nSome *text*.\n"));
    expect(summary).toBe("README.md is Markdown: there is nothing to build.");
  });

  test.skipIf(!haveTex)("a chapter builds with the main file above it, and the report is named from the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "neo-mirador-"));
    const chapter = "\\section{Intro}\nA chapter.\n";
    await mkdir(join(workspace, "paper", "chapters"), { recursive: true });
    await writeFile(join(workspace, "paper", "main.tex"), "\\documentclass{article}\n\\begin{document}\n\\input{chapters/intro}\n\\end{document}\n");
    await writeFile(join(workspace, "paper", "chapters", "intro.tex"), chapter);
    const summary = await host.tasks!.compile!.run(contextFor(workspace, "paper/chapters", chapter));
    expect(summary).toStartWith("Compiled main.tex with ");
    expect(summary).toContain("Report: paper/.latex-build/main.report.json.");
  }, 60_000);
});
