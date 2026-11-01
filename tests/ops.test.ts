import { describe, expect, test } from "bun:test";
import host from "../hosts/mirador/host.ts";
import { ANCHOR_LENGTH, type Operation } from "../core/ops.ts";
import { parseDocument } from "../core/document.ts";

const you = { kind: "you" } as const;
const doc = (text: string) => parseDocument(text);
const apply = (text: string, operation: unknown) => host.apply(doc(text), operation, you);
const undo = (text: string, operation: unknown) => {
  const applied = apply(text, operation);
  return host.apply(applied.document, applied.inverse, you).document.text;
};

const SAMPLE = "\\documentclass{article}\n\\begin{document}\nHello world.\n\nSecond line.\n\\end{document}\n";

describe("parse and serialize", () => {
  test("keep the file's CRLF line breaks while the document counts each as one character", () => {
    const text = "a\r\nb\r\n";
    const parsed = host.parse(text);
    expect(parsed.text).toBe("a\nb\n");
    expect(host.serialize(parsed)).toBe(text);
  });
});

describe("edit", () => {
  test("replaces at the position when the text there is as expected, and undoes", () => {
    const op = { op: "edit", changes: [{ from: 37, to: 42, insert: "there", expect: "world" }] };
    expect(apply(SAMPLE, op).document.text).toContain("Hello there.");
    expect(undo(SAMPLE, op)).toBe(SAMPLE);
  });

  test("finds its place again when the text moved under it", () => {
    const at = SAMPLE.indexOf("world");
    const change = { from: at, to: at + 5, insert: "there", expect: "world", prefix: SAMPLE.slice(at - ANCHOR_LENGTH, at), suffix: SAMPLE.slice(at + 5, at + 5 + ANCHOR_LENGTH) };
    const moved = SAMPLE.replace("\\begin{document}\n", "\\begin{document}\n% added above\n");
    expect(apply(moved, { op: "edit", changes: [change] }).document.text).toContain("Hello there.");
  });

  test("anchors an insertion by the text around it", () => {
    const at = SAMPLE.indexOf(" world");
    const change = { from: at, to: at, insert: ",", expect: "", prefix: "Hello", suffix: " world" };
    const moved = `% first\n${SAMPLE}`;
    expect(apply(moved, { op: "edit", changes: [change] }).document.text).toContain("Hello, world.");
  });

  test("refuses when the text it changes is gone", () => {
    const op = { op: "edit", changes: [{ from: 37, to: 42, insert: "there", expect: "world", prefix: "Hello " }] };
    expect(() => apply(SAMPLE.replace("Hello world", "Bye"), op)).toThrow(/no longer has “world”/);
  });

  test("makes several changes, with an inverse for all of them", () => {
    const op = {
      op: "edit",
      changes: [
        { from: 37, to: 42, insert: "there", expect: "world" },
        { from: 45, to: 51, insert: "Next", expect: "Second" },
      ],
    };
    const applied = apply(SAMPLE, op);
    expect(applied.document.text).toContain("Hello there.\n\nNext line.");
    expect(applied.summary).toBe("Edited lines 3 and 5");
    expect(applied.touched).toEqual(["line:3", "line:5"]);
    expect(undo(SAMPLE, op)).toBe(SAMPLE);
  });

  test("refuses overlapping changes", () => {
    const op = { op: "edit", changes: [{ from: 37, to: 42, insert: "", expect: "world" }, { from: 40, to: 42, insert: "", expect: "ld" }] };
    expect(() => apply(SAMPLE, op)).toThrow(/overlap/);
  });
});

describe("the agent's operations", () => {
  const cases: [string, Operation, string][] = [
    ["replace", { op: "replace", find: "Hello world", with: "Hi" }, "Hi."],
    ["replace all", { op: "replace", find: "line", with: "row", all: true }, "Second row."],
    ["insert after", { op: "insert", after: "Hello world.", text: " More." }, "Hello world. More."],
    ["insert before", { op: "insert", before: "Second", text: "The " }, "The Second"],
    ["insert at end of body", { op: "insert", at: "end_of_body", text: "Last." }, "Last.\n\\end{document}"],
    ["insert at end of preamble", { op: "insert", at: "end_of_preamble", text: "\\usepackage{x}" }, "\\usepackage{x}\n\\begin{document}"],
    ["replace_lines", { op: "replace_lines", from: 3, to: 5, text: "One line." }, "\\begin{document}\nOne line.\n\\end{document}"],
    ["replace_lines inserting", { op: "replace_lines", from: 3, to: 2, text: "New first." }, "\\begin{document}\nNew first.\nHello"],
    ["set_text", { op: "set_text", text: SAMPLE.replace("world", "everyone") }, "Hello everyone."],
  ];
  for (const [name, op, expected] of cases) {
    test(`${name} changes the text and its inverse restores it`, () => {
      const applied = apply(SAMPLE, op);
      expect(applied.document.text).toContain(expected);
      expect(applied.summary.length).toBeGreaterThan(0);
      expect(undo(SAMPLE, op)).toBe(SAMPLE);
    });
  }

  test("replace says where the text occurs when it isn't unique", () => {
    expect(() => apply(SAMPLE, { op: "replace", find: "e", with: "x" })).toThrow(/occurs \d+ times \(lines/);
  });

  test("unknown operations list the ones there are", () => {
    expect(() => apply(SAMPLE, { op: "delete" })).toThrow(/replace_lines/);
  });

  test("replace_lines refuses lines outside the document", () => {
    expect(() => apply(SAMPLE, { op: "replace_lines", from: 40, to: 41, text: "" })).toThrow(/outside the document/);
  });
});

describe("describe", () => {
  test("gives the outline and the numbered source", () => {
    const text = "\\documentclass{article}\n\\begin{document}\n\\section{Intro} % first\n\\subsection*{Detail}\n\\end{document}\n";
    const described = host.describe(doc(text));
    expect(described).toContain("Class: article");
    expect(described).toContain("- line 3: \\section Intro");
    expect(described).toContain("- line 4: \\subsection* Detail");
    expect(described).toContain("3| \\section{Intro} % first");
  });
});
