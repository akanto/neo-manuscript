import { describe, expect, test } from "bun:test";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";
import { blockLines, codeRanges, markdownLanguage, mathRanges, mdBold, mdCode, mdHeading, mdItalic, mdList, mdMath } from "../view/markdown.ts";

/** Runs a command on the text and gives the result; the selection is between `|`s, or a single `|` for a cursor. */
function run(command: Command, marked: string): string {
  const first = marked.indexOf("|");
  const second = marked.indexOf("|", first + 1);
  const doc = marked.replace(/\|/g, "");
  const selection = second === -1 ? EditorSelection.cursor(first) : EditorSelection.single(first, second - 1);
  let state = EditorState.create({ doc, selection, extensions: [markdownLanguage()] });
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
  } as unknown as EditorView;
  expect(command(view)).toBe(true);
  const { from, to } = state.selection.main;
  const text = state.doc.toString();
  return from === to ? `${text.slice(0, from)}|${text.slice(from)}` : `${text.slice(0, from)}|${text.slice(from, to)}|${text.slice(to)}`;
}

describe("mdBold, mdItalic, mdCode", () => {
  test("wrap the selection and keep it selected", () => {
    expect(run(mdBold, "a |word| here")).toBe("a **|word|** here");
    expect(run(mdItalic, "a |word| here")).toBe("a *|word|* here");
    expect(run(mdCode, "a |word| here")).toBe("a `|word|` here");
  });

  test("put the cursor between markers when nothing is selected", () => {
    expect(run(mdBold, "a | b")).toBe("a **|** b");
  });

  test("keep spaces outside the markers", () => {
    expect(run(mdBold, "a| word |b")).toBe("a **|word|** b");
  });

  test("take the markers away again", () => {
    expect(run(mdBold, "a **|word|** here")).toBe("a |word| here");
    expect(run(mdBold, "a **wo|rd** here")).toBe("a wo|rd here");
    expect(run(mdBold, "a |**word**| here")).toBe("a |word| here");
    expect(run(mdItalic, "a *wo|rd* here")).toBe("a wo|rd here");
    expect(run(mdItalic, "a _wo|rd_ here")).toBe("a wo|rd here");
    expect(run(mdCode, "a `wo|rd` here")).toBe("a wo|rd here");
  });

  test("italic inside bold adds markers instead", () => {
    expect(run(mdItalic, "**|word|**")).toBe("***|word|***");
  });
});

describe("mdHeading", () => {
  test("makes the line a heading, switches level, and turns it off", () => {
    expect(run(mdHeading(1), "Title|")).toBe("# Title|");
    expect(run(mdHeading(2), "# Title|")).toBe("## Title|");
    expect(run(mdHeading(2), "## Title|")).toBe("Title|");
    expect(run(mdHeading(3), "some te|xt")).toBe("### some te|xt");
  });

  test("keeps the cursor at the same place in the text", () => {
    expect(run(mdHeading(1), "Ti|tle")).toBe("# Ti|tle");
    expect(run(mdHeading(3), "## Ti|tle")).toBe("### Ti|tle");
  });

  test("works on the cursor's line only", () => {
    expect(run(mdHeading(1), "one\ntw|o\nthree")).toBe("one\n# tw|o\nthree");
  });
});

describe("mdList", () => {
  test("makes selected lines bullets, then plain again", () => {
    expect(run(mdList(false), "|a\nb\nc|")).toBe("|- a\n- b\n- c|");
    expect(run(mdList(false), "|- a\n- b|")).toBe("|a\nb|");
  });

  test("numbers items, skipping blank lines", () => {
    expect(run(mdList(true), "|a\nb\n\nc|")).toBe("|1. a\n2. b\n\n3. c|");
    expect(run(mdList(true), "|1. a\n2. b|")).toBe("|a\nb|");
  });

  test("switches between bullets and numbers", () => {
    expect(run(mdList(true), "|- a\n- b|")).toBe("|1. a\n2. b|");
    expect(run(mdList(false), "|1. a\n2. b|")).toBe("|- a\n- b|");
  });

  test("keeps indentation", () => {
    expect(run(mdList(false), "|  a\n  b|")).toBe("|  - a\n  - b|");
  });

  test("gives an empty line an empty item", () => {
    expect(run(mdList(false), "|")).toBe("- |");
    expect(run(mdList(true), "|")).toBe("1. |");
  });

  test("a cursor in a line makes it an item and stays at its end", () => {
    expect(run(mdList(false), "a|b")).toBe("- ab|");
  });
});

describe("mdMath", () => {
  test("wraps the selection in dollar signs", () => {
    expect(run(mdMath(false), "x |a+b| y")).toBe("x $|a+b|$ y");
    expect(run(mdMath(false), "x | y")).toBe("x $|$ y");
  });

  test("puts display math on lines of its own", () => {
    expect(run(mdMath(true), "|a+b|")).toBe("$$\n|a+b|\n$$\n");
    expect(run(mdMath(true), "see |a+b|")).toBe("see \n$$\n|a+b|\n$$\n");
  });
});

describe("mathRanges", () => {
  test("finds inline and display formulas", () => {
    const text = "so $a+b$ and\n$$\nx^2\n$$\nend";
    const found = mathRanges(text);
    expect(found.map((m) => [m.source, m.display])).toEqual([["a+b", false], ["x^2", true]]);
    expect(text.slice(found[0]!.from, found[0]!.to)).toBe("$a+b$");
  });

  test("leaves out prices, escaped signs and lone signs", () => {
    expect(mathRanges("it costs $5 and $6 today")).toEqual([]);
    expect(mathRanges("a \\$x\\$ b")).toEqual([]);
    expect(mathRanges("one $ two")).toEqual([]);
    expect(mathRanges("$ a$ and $b $")).toEqual([]);
  });

  test("leaves out excluded ranges", () => {
    const text = "`$a$` and $b$";
    expect(mathRanges(text, [[0, 5]]).map((m) => m.source)).toEqual(["b"]);
    expect(mathRanges(text, codeRanges(text)).map((m) => m.source)).toEqual(["b"]);
  });
});

describe("codeRanges", () => {
  test("finds fenced and inline code", () => {
    const text = "a `x $` b\n```\n$y$\n```\nz";
    const ranges = codeRanges(text);
    expect(ranges.map(([from, to]) => text.slice(from, to))).toEqual(["`x $`", "```\n$y$\n```"]);
  });
});

describe("blockLines", () => {
  test("gives the source line each block starts on", () => {
    const text = "# Title\n\npara one\nstill one\n\n- a\n- b\n\n```\ncode\n\nmore\n```\n\nlast";
    expect(blockLines(text)).toEqual([1, 3, 6, 9, 15]);
  });

  test("counts the lines of a multi-line formula", () => {
    const text = "intro\n\n$$\na\n\nb\n$$\n\nafter";
    expect(blockLines(text)).toEqual([1, 3, 9]);
  });
});
