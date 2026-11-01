/** Small LaTeX readers that both the host and the view use. */

/** Where the comment on a line starts (an unescaped %), or the line's length when it has none. */
export function commentStart(line: string): number {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") i++;
    else if (c === "%") return i;
  }
  return line.length;
}

/**
 * The position just after the brace that closes the group opening at `open` (which must be "{"), or -1 when it isn't
 * closed. Escaped braces don't count, and neither do braces in comments.
 */
export function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "%") {
      const end = text.indexOf("\n", i);
      if (end === -1) return -1;
      i = end;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

export const SECTION_LEVELS = ["part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"] as const;
export type SectionCommand = (typeof SECTION_LEVELS)[number];

export interface OutlineEntry {
  command: SectionCommand;
  starred: boolean;
  title: string;
  line: number;
}

/** The document's sectioning commands, in order. */
export function outlineOf(text: string): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  const pattern = new RegExp(`\\\\(${SECTION_LEVELS.join("|")})(\\*?)\\s*(?:\\[[^\\]]*\\])?\\s*\\{`, "g");
  text.split("\n").forEach((line, index) => {
    const code = line.slice(0, commentStart(line));
    for (const match of code.matchAll(pattern)) {
      const open = match.index + match[0].length - 1;
      const close = closingBrace(code, open);
      const title = code.slice(open + 1, close === -1 ? undefined : close - 1).trim();
      entries.push({ command: match[1] as SectionCommand, starred: match[2] === "*", title, line: index + 1 });
    }
  });
  return entries;
}

export const ENGINES = ["latexmk", "pdflatex", "xelatex", "lualatex", "tectonic"] as const;
export type Engine = (typeof ENGINES)[number];

/**
 * The engine a `% !TEX program = xelatex` (or `% !TeX TS-program = ...`) comment at the top of the file asks for, as
 * TeXShop, TeXstudio and VS Code's LaTeX Workshop read it; null when there is none.
 */
export function engineAskedFor(text: string): Engine | null {
  for (const line of text.split("\n", 30)) {
    const match = /^\s*%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*([A-Za-z]+)/i.exec(line);
    if (match) {
      const name = match[1]!.toLowerCase();
      return (ENGINES as readonly string[]).includes(name) ? (name as Engine) : null;
    }
  }
  return null;
}

/** The document class, as `\documentclass[...]{article}` names it. */
export function documentClassOf(text: string): string | null {
  return /^[^%\n]*\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/m.exec(text)?.[1]?.trim() ?? null;
}
