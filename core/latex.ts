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
  return engineLine(text)?.engine ?? null;
}

const ENGINE_LINE = /^\s*%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*([A-Za-z]+)/i;

/** The `% !TEX program` line among the first 30, with its place in the text (the line break left out). */
function engineLine(text: string): { from: number; to: number; engine: Engine | null } | null {
  let from = 0;
  for (const line of text.split("\n", 30)) {
    const match = ENGINE_LINE.exec(line);
    if (match) {
      const name = match[1]!.toLowerCase();
      return { from, to: from + line.length, engine: (ENGINES as readonly string[]).includes(name) ? (name as Engine) : null };
    }
    from += line.length + 1;
  }
  return null;
}

/**
 * The edit that makes the file ask for `engine`, or for none (null): the `% !TEX program` line changed, added at the
 * top, or taken out with its line break. Null when the file asks for it already.
 */
export function engineChange(text: string, engine: Engine | null): { from: number; to: number; insert: string } | null {
  const line = engineLine(text);
  if (!line) return engine ? { from: 0, to: 0, insert: `% !TEX program = ${engine}\n` } : null;
  if (line.engine === engine) return null;
  if (!engine) return { from: line.from, to: Math.min(text.length, line.to + 1), insert: "" };
  return { from: line.from, to: line.to, insert: `% !TEX program = ${engine}` };
}

/** The document class, as `\documentclass[...]{article}` names it. */
export function documentClassOf(text: string): string | null {
  return /^[^%\n]*\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/m.exec(text)?.[1]?.trim() ?? null;
}
