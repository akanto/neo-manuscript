import { describe, expect, test } from "bun:test";
import { engineAskedFor, engineChange } from "../core/latex.ts";

const apply = (text: string, change: { from: number; to: number; insert: string } | null) =>
  change ? text.slice(0, change.from) + change.insert + text.slice(change.to) : text;

describe("engineAskedFor", () => {
  test("reads the % !TEX program line", () => {
    expect(engineAskedFor("% !TEX program = xelatex\n\\documentclass{article}")).toBe("xelatex");
    expect(engineAskedFor("%!TeX TS-program = LuaLaTeX\n")).toBe("lualatex");
    expect(engineAskedFor("\\documentclass{article}")).toBeNull();
    expect(engineAskedFor("% !TEX program = context\n")).toBeNull();
  });
});

describe("engineChange", () => {
  const doc = "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n";

  test("adds the line at the top", () => {
    const text = apply(doc, engineChange(doc, "tectonic"));
    expect(text).toBe(`% !TEX program = tectonic\n${doc}`);
    expect(engineAskedFor(text)).toBe("tectonic");
  });

  test("changes the line where it is", () => {
    const text = `% a note\n% !TeX program = pdflatex\n${doc}`;
    expect(apply(text, engineChange(text, "xelatex"))).toBe(`% a note\n% !TEX program = xelatex\n${doc}`);
  });

  test("takes the line out for Auto", () => {
    const text = `% !TEX program = xelatex\n${doc}`;
    expect(apply(text, engineChange(text, null))).toBe(doc);
  });

  test("changes nothing when the file asks for that already", () => {
    expect(engineChange(`% !TEX program = xelatex\n${doc}`, "xelatex")).toBeNull();
    expect(engineChange(doc, null)).toBeNull();
  });
});
