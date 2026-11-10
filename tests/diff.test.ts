import { describe, expect, test } from "bun:test";
import { changedRanges } from "../core/diff.ts";

/** The words `changedRanges` marks in `after`. */
const marked = (before: string, after: string) => changedRanges(before, after).map(({ from, to }) => after.slice(from, to));

describe("changedRanges", () => {
  test("marks a changed word only", () => {
    expect(marked("The quick brown fox", "The quick red fox")).toEqual(["red"]);
  });

  test("marks nothing for the same text", () => {
    expect(marked("same text", "same text")).toEqual([]);
  });

  test("ignores whitespace and line breaks", () => {
    expect(marked("one two three", "one\ntwo   three")).toEqual([]);
    expect(marked("\\item a\n\\item b", "  \\item a\n    \\item b")).toEqual([]);
  });

  test("leaves no mark where words were removed", () => {
    expect(marked("a b c", "a c")).toEqual([]);
  });

  test("joins words added together into one range", () => {
    expect(marked("a b c", "a b c d e")).toEqual(["d e"]);
  });

  test("marks LaTeX arguments and words apart", () => {
    expect(marked("See \\cite{x} here.", "See \\cite{y} there.")).toEqual(["y", "there"]);
  });

  test("marks all of a text that had none", () => {
    expect(marked("", "new text")).toEqual(["new text"]);
  });
});
