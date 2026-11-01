import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bibliographyProblemsIn, bibliographyTool, citationsIn, compile, isUpToDate, planBuild, problemsIn, searchPath, type CompileContext } from "../core/compile.ts";
import { reportNamedIn, type BuildReport } from "../core/build.ts";
import { parseDocument } from "../core/document.ts";

describe("planBuild", () => {
  const all = (command: string) => `/bin/${command}`;
  const only = (...names: string[]) => (command: string) => (names.includes(command) ? `/bin/${command}` : null);

  test("uses latexmk when there is one, with the engine the file asks for", () => {
    expect(planBuild("x", "a.tex", all).command.slice(0, 2)).toEqual(["/bin/latexmk", "-pdf"]);
    expect(planBuild("% !TEX program = xelatex\nx", "a.tex", all).command.slice(0, 2)).toEqual(["/bin/latexmk", "-pdfxe"]);
  });

  test("runs the engine itself without latexmk, and tectonic without TeX", () => {
    expect(planBuild("x", "a.tex", only("pdflatex", "tectonic")).engine).toBe("pdflatex");
    expect(planBuild("x", "a.tex", only("tectonic")).engine).toBe("tectonic");
    expect(planBuild("% !TeX TS-program = tectonic\n", "a.tex", all).engine).toBe("tectonic");
  });

  test("says how to install TeX when there is none", () => {
    expect(() => planBuild("x", "a.tex", only())).toThrow(/Install MacTeX or TeX Live/);
  });
});

describe("problemsIn", () => {
  test("reads file:line errors, ! errors with their l. line, and warnings", () => {
    const log = [
      "./paper.tex:12: Undefined control sequence.",
      "l.12 \\foo",
      "! Missing $ inserted.",
      "<inserted text>",
      "l.20 a_b",
      "LaTeX Warning: Reference `sec:x' on page 1 undefined on input line 31.",
      "Package hyperref Warning: Token not allowed in a PDF string (Unicode):",
      "(hyperref)                removing `math shift' on input line 9.",
      "error: paper.tex:7: Missing \\begin{document}",
    ].join("\n");
    expect(problemsIn(log)).toEqual([
      { severity: "error", file: "paper.tex", line: 12, message: "Undefined control sequence." },
      { severity: "error", file: null, line: 20, message: "Missing $ inserted." },
      { severity: "warning", file: null, line: 31, message: "Reference `sec:x' on page 1 undefined" },
      { severity: "warning", file: null, line: 9, message: "hyperref: Token not allowed in a PDF string (Unicode): removing `math shift'" },
      { severity: "error", file: "paper.tex", line: 7, message: "Missing \\begin{document}" },
    ]);
  });
});

describe("bibliographies", () => {
  test("BibTeX for \\bibdata in the .aux, else Biber for a fresh .bcf", () => {
    expect(bibliographyTool("\\citation{a}\n\\bibdata{refs}\n", false)).toBe("bibtex");
    expect(bibliographyTool("\\bibdata{paper-blx,refs}", true)).toBe("bibtex");
    expect(bibliographyTool("\\abx@aux@cite{0}{a}", true)).toBe("biber");
    expect(bibliographyTool("\\relax", false)).toBeNull();
  });

  test("reads BibTeX's errors and warnings, and Biber's", () => {
    const bibtex = [
      "This is BibTeX, Version 0.99d",
      "I couldn't open database file refs.bib",
      "---line 4 of file paper.aux",
      " : \\bibdata{refs",
      "I was expecting a `,' or a `}'---line 3 of file /Users/a/paper/refs.bib",
      'Warning--I didn\'t find a database entry for "nokey"',
    ].join("\n");
    expect(bibliographyProblemsIn(bibtex, "bibtex")).toEqual([
      { severity: "error", file: null, line: null, message: "BibTeX: I couldn't open database file refs.bib" },
      { severity: "error", file: null, line: null, message: "BibTeX: I was expecting a `,' or a `}' (refs.bib, line 3)" },
      { severity: "warning", file: null, line: null, message: 'BibTeX: I didn\'t find a database entry for "nokey"' },
    ]);
    expect(bibliographyProblemsIn("INFO - Found 1 citekeys\nWARN - I didn't find a database entry for 'x' (section 0)\nERROR - Cannot find 'refs.bib'!", "biber")).toEqual([
      { severity: "warning", file: null, line: null, message: "Biber: I didn't find a database entry for 'x' (section 0)" },
      { severity: "error", file: null, line: null, message: "Biber: Cannot find 'refs.bib'!" },
    ]);
  });

  test("reads the citations' labels from the .aux, natbib's too", () => {
    expect(citationsIn("\\bibcite{knuth1984}{1}\n\\bibcite{v2017}{{2}{2017}{{Vaswani et~al.}}{{}}}\n")).toEqual({ knuth1984: "1", v2017: "2" });
  });

  test("takes latexmk's nothing-to-do for a success, and nothing else", () => {
    const said = "Latexmk: Nothing to do for 'paper.tex'.\nLatexmk: All targets (.latex-build/paper.pdf) are up-to-date\n";
    expect(isUpToDate("latexmk", 0, said)).toBe(true);
    expect(isUpToDate("latexmk", 12, said)).toBe(false);
    expect(isUpToDate("pdflatex", 0, said)).toBe(false);
    expect(isUpToDate("latexmk", 0, "Latexmk: Run number 1 of rule 'pdflatex'\n")).toBe(false);
  });
});

const haveTex = ["latexmk", "pdflatex", "tectonic"].some((command) => Bun.which(command, { PATH: searchPath() }));

async function contextFor(text: string): Promise<{ context: CompileContext; folder: string }> {
  const folder = await mkdtemp(join(tmpdir(), "manuscript-test-"));
  await writeFile(join(folder, "paper.tex"), text);
  const context: CompileContext = {
    document: parseDocument(text),
    documentFolder: folder,
    progress: () => {},
    signal: new AbortController().signal,
  };
  return { context, folder };
}

describe.skipIf(!haveTex)("compile, with the TeX installed here", () => {
  test("builds the PDF and writes a report the summary names", async () => {
    const { context, folder } = await contextFor("\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n");
    const summary = await compile(context);
    expect(summary).toMatch(/^Compiled paper\.tex with \w+ to \.latex-build\/paper\.pdf: 1 page, 0 errors/);
    const report = JSON.parse(await readFile(join(folder, reportNamedIn(summary)!), "utf8")) as BuildReport;
    expect(report).toMatchObject({ source: "paper.tex", pdf: ".latex-build/paper.pdf", fresh: true, pages: 1 });
    expect(existsSync(join(folder, ".latex-build/paper.pdf"))).toBe(true);
  }, 60_000);

  test("compiles again with no change in between, which leaves the PDF as it is", async () => {
    const { context, folder } = await contextFor("\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n");
    await compile(context);
    const summary = await compile(context);
    expect(summary).toMatch(/^Compiled paper\.tex with \w+ to \.latex-build\/paper\.pdf: 1 page, 0 errors/);
    const report = JSON.parse(await readFile(join(folder, reportNamedIn(summary)!), "utf8")) as BuildReport;
    expect(report).toMatchObject({ pdf: ".latex-build/paper.pdf", fresh: true, pages: 1 });
  }, 60_000);

  test("makes the bibliography from a .bib file", async () => {
    const { context, folder } = await contextFor("\\documentclass{article}\n\\begin{document}\nSee~\\cite{knuth1984}.\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n");
    await writeFile(join(folder, "refs.bib"), "@book{knuth1984, author={Donald E. Knuth}, title={The TeXbook}, publisher={Addison-Wesley}, year={1984}}\n");
    const summary = await compile(context);
    expect(summary).toMatch(/0 errors, 0 warnings/);
    const report = JSON.parse(await readFile(join(folder, reportNamedIn(summary)!), "utf8")) as BuildReport;
    expect(report.citations).toEqual({ knuth1984: "1" });
  }, 60_000);

  test("reports errors with their lines", async () => {
    const { context } = await contextFor("\\documentclass{article}\n\\begin{document}\nHello \\nosuchcommand.\n\\end{document}\n");
    const outcome = await compile(context).then((summary) => summary, (error: Error) => error.message);
    expect(outcome).toMatch(/line 3: Undefined control sequence/);
  }, 60_000);
});
