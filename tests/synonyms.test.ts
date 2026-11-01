import { describe, expect, test } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { selectedWord, sentenceAround } from "../view/synonyms.ts";

/** The selection is the text between the two `|`s. */
function stateOf(marked: string): EditorState {
  const from = marked.indexOf("|");
  const to = marked.indexOf("|", from + 1) - 1;
  return EditorState.create({ doc: marked.replace(/\|/g, ""), selection: EditorSelection.single(from, to) });
}

describe("selectedWord", () => {
  test("takes one to three whole words of prose", () => {
    expect(selectedWord(stateOf("Compaction |reduces| the count."))).toEqual({ from: 11, to: 18, text: "reduces" });
    expect(selectedWord(stateOf("It |cuts down| the count."))?.text).toBe("cuts down");
    expect(selectedWord(stateOf("\\section{|Introduction|}"))?.text).toBe("Introduction");
    expect(selectedWord(stateOf("in \\textbf{|bold| words}"))?.text).toBe("bold");
  });

  test("leaves out part of a word, long selections, and what isn't a word", () => {
    expect(selectedWord(stateOf("Compaction |reduc|es the count."))).toBeNull();
    expect(selectedWord(stateOf("|one two three four| five"))).toBeNull();
    expect(selectedWord(stateOf("takes |36| files"))).toBeNull();
    expect(selectedWord(stateOf("same| |gap"))).toBeNull();
  });

  test("leaves out commands, formulas, comments and keys", () => {
    expect(selectedWord(stateOf("\\|section|{Introduction}"))).toBeNull();
    expect(selectedWord(stateOf("where $|rate| = 1$ holds"))).toBeNull();
    expect(selectedWord(stateOf("as shown~\\cite{|Kanto|}"))).toBeNull();
    expect(selectedWord(stateOf("see Section~\\ref{|results|}"))).toBeNull();
    expect(selectedWord(stateOf("the \\texttt{|hadoop|} client"))).toBeNull();
    expect(selectedWord(stateOf("text % a |note| here"))).toBeNull();
  });
});

describe("sentenceAround", () => {
  test("quotes the sentence the selection is in", () => {
    const line = "L1 is the raw table. Compaction reduces the count. W3 differs.";
    const at = line.indexOf("reduces");
    expect(sentenceAround(line, at, at + 7)).toBe("Compaction reduces the count.");
    expect(sentenceAround("A single sentence without an end", 2, 8)).toBe("A single sentence without an end");
  });
});
