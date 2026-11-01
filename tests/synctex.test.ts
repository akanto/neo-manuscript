import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, searchPath, type CompileContext } from "../core/compile.ts";
import { parseDocument } from "../core/document.ts";
import { lineForPlace, parseSynctex, placeForLine, readSynctex, tagOf } from "../view/synctex.ts";

/** 1in in scaled points, which is 72 PDF points. */
const INCH = 4736286;

const SAMPLE = [
  "SyncTeX Version:1",
  "Input:1:/home/me/paper/./paper.tex",
  "Input:2:/texmf/article.cls",
  "Output:pdf",
  "Magnification:1000",
  "Unit:1",
  "X Offset:0",
  "Y Offset:0",
  "Content:",
  "!4095",
  "{1",
  // The page's box, which only ends on line 40.
  `[1,40:${INCH},${INCH * 10}:${INCH * 6},${INCH * 9},0`,
  // The header: a box of no size, with a kern that carries the line the page was shipped on.
  `[1,40:${INCH},${INCH}:0,0,0`,
  `(1,40:${INCH},${INCH + 100}:0,0,0`,
  `k1,40:${INCH},${INCH + 100}:-3473163`,
  ")",
  "]",
  `(1,12:${INCH},${INCH * 2}:${INCH * 6},${INCH / 8},0`,
  `x1,12:${INCH * 2},${INCH * 2}`,
  `g1,12:${INCH * 3},${INCH * 2}`,
  `x1,14:${INCH},${INCH * 3}`,
  `x2,99:${INCH},${INCH * 4}`,
  ")",
  "]",
  "!120",
  "}1",
  "{2",
  `x1,20:${INCH},${INCH * 2}`,
  "}2",
  "Postamble:",
].join("\n");

describe("SyncTeX", () => {
  const synctex = parseSynctex(SAMPLE);

  test("finds the document's own file among the inputs, by its path from the document's folder", () => {
    expect(tagOf(synctex, "paper.tex")).toBe(1);
    expect(tagOf(synctex, ".latex-build/paper.tex")).toBeNull();
    expect(tagOf(synctex, "other.tex")).toBeNull();
  });

  test("takes a line to the top of its text, in PDF points from the page's top left", () => {
    // Line 12's text sits on a baseline 2in down; a page box ending on line 40 doesn't count.
    const twelve = placeForLine(synctex, 1, 12)!;
    expect([twelve.page, twelve.x, twelve.y].map(Math.round)).toEqual([1, 144, 144 - 10]);
    const twenty = placeForLine(synctex, 1, 20)!;
    expect([twenty.page, twenty.x, twenty.y].map(Math.round)).toEqual([2, 72, 144 - 10]);
  });

  test("takes a line that typeset nothing to the next one that did", () => {
    expect(placeForLine(synctex, 1, 13)?.y).toBeCloseTo(216 - 10, 2);
    expect(placeForLine(synctex, 1, 99)?.page).toBe(1);
  });

  test("takes a place back to the line of the text nearest it, on that page and in that file", () => {
    expect(lineForPlace(synctex, 1, { page: 1, x: 300, y: 140 })).toBe(12);
    expect(lineForPlace(synctex, 1, { page: 1, x: 0, y: 290 })).toBe(14);
    expect(lineForPlace(synctex, 1, { page: 2, x: 0, y: 0 })).toBe(20);
    expect(lineForPlace(synctex, 1, { page: 3, x: 0, y: 0 })).toBeNull();
  });

  test("leaves out lines that print nothing, as the blank line that ends a paragraph", () => {
    expect(lineForPlace(synctex, 1, { page: 1, x: 300, y: 140 }, (line) => line !== 12)).toBe(14);
  });

  test("leaves out what is in boxes of no size, as the page's header", () => {
    expect(lineForPlace(synctex, 1, { page: 1, x: 0, y: 0 })).toBe(12);
  });
});

const haveTex = ["latexmk", "pdflatex"].some((command) => Bun.which(command, { PATH: searchPath() }));

describe.skipIf(!haveTex)("SyncTeX of a build, with the TeX installed here", () => {
  test("takes each heading to its page and back to its line", async () => {
    const lines = ["\\documentclass{article}", "\\begin{document}", "\\section{One}", "", "Some text in the first section.", "\\newpage", "\\section{Two}", "", "More text.", "\\end{document}", ""];
    const text = lines.join("\n");
    const folder = await mkdtemp(join(tmpdir(), "manuscript-test-"));
    await writeFile(join(folder, "paper.tex"), text);
    const context: CompileContext = {
      document: parseDocument(text),
      documentFolder: folder,
      progress: () => {},
      signal: new AbortController().signal,
    };
    await compile(context);
    const synctex = await readSynctex(Bun.file(join(folder, ".latex-build/paper.synctex.gz")));
    const tag = tagOf(synctex, "paper.tex")!;
    expect(tag).not.toBeNull();
    for (const [line, page] of [[3, 1], [5, 1], [7, 2], [9, 2]] as const) {
      const place = placeForLine(synctex, tag, line)!;
      expect(place.page).toBe(page);
      expect(lineForPlace(synctex, tag, { ...place, y: place.y + 10 })).toBe(line);
    }
  }, 60_000);
});
