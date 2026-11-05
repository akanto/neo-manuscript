import { describe, expect, test } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { rewriteFrom, rewritePrompt } from "../core/assist.ts";
import { wordDiff } from "../core/diff.ts";
import { contextAround, selectedPassage } from "../view/assist.ts";

/** The selection is the text between the two `|`s. */
function stateOf(marked: string): EditorState {
  const from = marked.indexOf("|");
  const to = marked.indexOf("|", from + 1) - 1;
  return EditorState.create({ doc: marked.replace(/\|/g, ""), selection: EditorSelection.single(from, to) });
}

describe("selectedPassage", () => {
  test("takes a sentence", () => {
    const passage = selectedPassage(stateOf("|Compaction reduces the number of files.| Next."), "latex");
    expect(passage?.text).toBe("Compaction reduces the number of files.");
    expect(passage?.from).toBe(0);
  });

  test("leaves out one to three words, and nothing selected", () => {
    expect(selectedPassage(stateOf("a |cuts down| b"), "latex")).toBeNull();
    expect(selectedPassage(stateOf("a |one two three| b"), "latex")).toBeNull();
    expect(selectedPassage(stateOf("a |\\textbf{one} \\emph{two} three| b"), "latex")).toBeNull();
    expect(selectedPassage(EditorState.create({ doc: "some words here now" }), "latex")).toBeNull();
  });

  test("leaves out text wholly in math or a comment", () => {
    expect(selectedPassage(stateOf("where $|a b c d e f|$ holds"), "latex")).toBeNull();
    expect(selectedPassage(stateOf("text % |a long note about this here|"), "latex")).toBeNull();
  });

  test("takes a passage with a citation and math inside", () => {
    const text = "The rate $x$ grows as shown~\\cite{Kanto} in the table.";
    expect(selectedPassage(stateOf(`|${text}|`), "latex")?.text).toBe(text);
  });

  test("takes Markdown, without the token check", () => {
    expect(selectedPassage(stateOf("|The rate grows as shown in the table.|"), "markdown")?.text).toBe("The rate grows as shown in the table.");
    expect(selectedPassage(stateOf("a |b c| d"), "markdown")).toBeNull();
  });
});

describe("contextAround", () => {
  test("stops at blank lines", () => {
    const doc = "Old paragraph.\n\nStart of it. SELECTED text here. End of it.\n\nNext paragraph.";
    const from = doc.indexOf("SELECTED");
    const to = from + "SELECTED text here.".length;
    expect(contextAround(EditorState.create({ doc }), from, to)).toEqual({ before: "Start of it. ", after: " End of it." });
  });

  test("caps its length at the far end", () => {
    const doc = `${"a".repeat(3000)}[SEL]${"b".repeat(3000)}`;
    const { before, after } = contextAround(EditorState.create({ doc }), 3000, 3005);
    expect(before).toBe("a".repeat(1000));
    expect(after).toBe("b".repeat(1000));
  });
});

describe("wordDiff", () => {
  test("marks removed and added words", () => {
    const parts = wordDiff("the big dog", "the small dog");
    expect(parts.filter((part) => part.kind === "removed").map((part) => part.text.trim())).toEqual(["big"]);
    expect(parts.filter((part) => part.kind === "added").map((part) => part.text.trim())).toEqual(["small"]);
    expect(parts.map((part) => part.text).filter((_, i) => parts[i]!.kind !== "added").join("")).toBe("the big dog");
  });

  test("gives one same part for equal text", () => {
    expect(wordDiff("same text", "same text")).toEqual([{ kind: "same", text: "same text" }]);
  });
});

describe("rewriteFrom", () => {
  test("reads the tagged text", () => {
    expect(rewriteFrom("Sure.\n<rewrite>\nNew text.\n</rewrite>\nDone.", "Old text.")).toBe("New text.");
  });

  test("reads a fenced answer", () => {
    expect(rewriteFrom("```latex\nNew text.\n```", "Old.")).toBe("New text.");
    expect(rewriteFrom("<rewrite>\n```\nNew.\n```\n</rewrite>", "Old.")).toBe("New.");
  });

  test("reads an answer with no tags", () => {
    expect(rewriteFrom("  New text.  ", "Old.")).toBe("New text.");
  });

  test("keeps the original's leading and trailing whitespace", () => {
    expect(rewriteFrom("<rewrite>New.</rewrite>", "\n  Old.\n")).toBe("\n  New.\n");
  });

  test("throws on an empty answer", () => {
    expect(() => rewriteFrom("<rewrite>\n</rewrite>", "Old.")).toThrow();
    expect(() => rewriteFrom("   ", "Old.")).toThrow();
  });
});

describe("rewritePrompt", () => {
  const base = { text: "We was here.", before: "Before.", after: "After.", language: "latex" as const };

  test("holds the passage and the action's instruction", () => {
    const prompt = rewritePrompt({ ...base, action: "grammar" });
    expect(prompt).toContain("We was here.");
    expect(prompt).toContain("grammar");
    expect(prompt).toContain("Before.");
    expect(rewritePrompt({ ...base, action: "shorten" })).toContain("concise");
  });

  test("carries the user's instruction for custom", () => {
    expect(rewritePrompt({ ...base, action: "custom", instruction: "make it rhyme" })).toContain("make it rhyme");
  });
});
