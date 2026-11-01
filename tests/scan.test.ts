import { describe, expect, test } from "bun:test";
import { lineForPdfText } from "../view/pdf-sync.ts";
import { macrosOf, scan, type Token } from "../view/scan.ts";

const kinds = (text: string) => scan(text).map((token) => (token.kind === "command" || token.kind === "begin" || token.kind === "end" ? `${token.kind}:${token.name}` : token.kind));
const commandArgs = (text: string, token: Token) => (token.kind === "command" ? token.args.map((arg) => text.slice(arg.from, arg.to)) : []);

describe("scan", () => {
  test("reads commands with their arguments, and reads on inside formatting", () => {
    const text = "\\section*{A \\emph{b}} and \\textbf{c}";
    expect(kinds(text)).toEqual(["command:section", "command:emph", "command:textbf"]);
    const [section] = scan(text);
    expect(section).toMatchObject({ star: true });
    expect(commandArgs(text, section!)).toEqual(["A \\emph{b}"]);
  });

  test("keeps math whole, inline and display, and math environments", () => {
    const text = "$a$ \\(b\\) \\[c\\] $$d$$ \\begin{align*}e\\end{align*}";
    const math = scan(text).filter((token) => token.kind === "math");
    expect(math.map((token) => token.kind === "math" && [text.slice(token.inner.from, token.inner.to), token.display, token.env])).toEqual([
      ["a", false, null],
      ["b", false, null],
      ["c", true, null],
      ["d", true, null],
      ["e", true, "align*"],
    ]);
  });

  test("doesn't take an escaped dollar or a comment's content for math", () => {
    expect(kinds("costs \\$5 % and $x$")).toEqual(["command:$", "comment"]);
  });

  test("skips the content of verbatim environments", () => {
    expect(kinds("\\begin{verbatim}\\textbf{x} $y\\end{verbatim} \\emph{z}")).toEqual(["verbatim", "command:emph"]);
  });

  test("reads quotes, dashes and ties as the characters they print", () => {
    const specials = scan("``a''--b---c~d").flatMap((token) => (token.kind === "special" ? [token.text] : []));
    expect(specials).toEqual(["“", "”", "–", "—", "\u00a0"]);
  });

  test("an unclosed argument doesn't swallow the rest of the text", () => {
    expect(kinds("\\textbf{open\n\n\\section{Next}")).toEqual(["command:textbf", "command:section"]);
  });

  test("macrosOf gives KaTeX the preamble's simple macros", () => {
    const text = "\\newcommand{\\R}{\\mathbb{R}}\\DeclareMathOperator*{\\argmax}{arg\\,max}";
    expect(macrosOf(text, scan(text))).toEqual({ "\\R": "\\mathbb{R}", "\\argmax": "\\operatorname*{arg\\,max}" });
  });
});

describe("lineForPdfText", () => {
  const source = "\\section{Introduction}\nLet $f$ be a smooth function. Its gradient points\nwhere $f$ grows fastest --- a fact we use\n% where it grows\n";
  test("finds the source line a line of the PDF came from", () => {
    expect(lineForPdfText(source, "Let f : Rn → R be a smooth function. Its gradient ∇f points")).toBe(2);
    expect(lineForPdfText(source, "1 Introduction")).toBe(1);
    expect(lineForPdfText(source, "where f grows fastest — a fact")).toBe(3);
  });
  test("gives null for words the source doesn't have", () => {
    expect(lineForPdfText(source, "xyzzy plugh")).toBeNull();
  });
});
