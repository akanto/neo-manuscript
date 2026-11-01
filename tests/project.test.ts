import { describe, expect, test } from "bun:test";
import { findMainFile, isProjectPath, kindOf, rootNamedIn, startsDocument } from "../core/project.ts";

const DOCUMENT = "\\documentclass{article}\n\\begin{document}\nHi.\n\\end{document}\n";
const CHAPTER = "\\chapter{Intro}\nText.\n";

describe("main file", () => {
  test("a commented-out \\documentclass doesn't start a document", () => {
    expect(startsDocument("% \\documentclass{article}\n\\section{A}")).toBe(false);
    expect(startsDocument("\\documentclass[11pt]{article}")).toBe(true);
  });

  test("main.tex wins among several documents", () => {
    const files = [{ path: "a.tex", text: DOCUMENT }, { path: "main.tex", text: DOCUMENT }, { path: "z.tex", text: DOCUMENT }];
    expect(findMainFile(files, "thesis")).toBe("main.tex");
  });

  test("the only document, whatever its name; chapters don't count", () => {
    const files = [{ path: "intro.tex", text: CHAPTER }, { path: "paper.tex", text: DOCUMENT }];
    expect(findMainFile(files, "x")).toBe("paper.tex");
  });

  test("the one named like the folder, then the first by name", () => {
    const files = [{ path: "b.tex", text: DOCUMENT }, { path: "Thesis.tex", text: DOCUMENT }, { path: "c.tex", text: DOCUMENT }];
    expect(findMainFile(files, "thesis")).toBe("Thesis.tex");
    expect(findMainFile(files.filter(({ path }) => path !== "Thesis.tex"), "other")).toBe("b.tex");
  });

  test("the user's choice, while it still starts a document", () => {
    const files = [{ path: "main.tex", text: DOCUMENT }, { path: "draft.tex", text: DOCUMENT }, { path: "notes.tex", text: CHAPTER }];
    expect(findMainFile(files, "x", "draft.tex")).toBe("draft.tex");
    expect(findMainFile(files, "x", "notes.tex")).toBe("main.tex");
  });

  test("only files at the top of the project", () => {
    expect(findMainFile([{ path: "old/main.tex", text: DOCUMENT }], "x")).toBeNull();
  });

  test("a % !TEX root line", () => {
    expect(rootNamedIn("% !TEX root = ../main.tex\n\\chapter{A}")).toBe("../main.tex");
    expect(rootNamedIn("\\chapter{A}")).toBeNull();
  });
});

test("file kinds", () => {
  expect(kindOf("chapters/intro.tex")).toBe("tex");
  expect(kindOf("refs.bib")).toBe("text");
  expect(kindOf("fig/plot.PNG")).toBe("image");
  expect(kindOf("fig/plot.pdf")).toBe("pdf");
  expect(kindOf("data.xlsx")).toBe("other");
});

test("paths stay inside the project", () => {
  expect(isProjectPath("chapters/intro.tex")).toBe(true);
  for (const path of ["", "/etc/passwd", "../x.tex", "a/../../x", "a//b", "./a", "C:/x", "a\\b"]) expect(isProjectPath(path)).toBe(false);
});
