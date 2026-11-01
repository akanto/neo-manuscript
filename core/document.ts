/**
 * The app's document: the .tex file's text with its line breaks as "\n", so that the host, the editor and every
 * operation count positions the same way, and the line break the file had, for writing it back as it was.
 */
export interface TexDocument {
  text: string;
  eol: "\n" | "\r\n";
}

export function parseDocument(text: string): TexDocument {
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  return { text: eol === "\r\n" ? text.replace(/\r\n/g, "\n") : text, eol };
}

export function serializeDocument({ text, eol }: TexDocument): string {
  return eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** The 1-based line of a position in the text. */
export function lineAt(text: string, position: number): number {
  let line = 1;
  for (let index = text.indexOf("\n"); index !== -1 && index < position; index = text.indexOf("\n", index + 1)) line++;
  return line;
}

/** The offset where each line starts, line 1 first. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) starts.push(index + 1);
  return starts;
}

/** What a new document starts as. */
export const NEW_DOCUMENT = `\\documentclass{article}
\\usepackage{amsmath}

\\title{Untitled}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduction}

Write here.

\\end{document}
`;
