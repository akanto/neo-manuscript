import type { TexDocument } from "./document.ts";
import { documentClassOf, engineAskedFor, outlineOf } from "./latex.ts";
import { OPERATIONS_HELP } from "./ops.ts";

/** The longest source describe lists in full; past it, the agent reads the file itself. */
const LISTED_LINES = 1500;

/**
 * The document in words, for the agent: what it is, its outline, then its source with line numbers, and how to change
 * it. `compileWith` names what the agent calls to build the PDF in its host, such as `app_run "compile"`.
 */
export function describeDocument({ text, eol }: TexDocument, compileWith: string): string {
  const lines = text.split("\n");
  const outline = outlineOf(text);
  const head = [
    `A LaTeX document of ${lines.length} lines${eol === "\r\n" ? " (CRLF line breaks in the file; positions count each as one character)" : ""}.`,
    `Class: ${documentClassOf(text) ?? "none found"}. Engine: ${engineAskedFor(text) ?? "default (latexmk, else pdflatex, else tectonic); a \"% !TEX program = xelatex\" line at the top picks another"}.`,
    "The user edits the same text in the app's Source and Visual modes, and sees the compiled PDF beside it.",
  ];
  const outlined = outline.length === 0
    ? "Outline: no sectioning commands."
    : `Outline:\n${outline.map(({ command, starred, title, line }) => `- line ${line}: \\${command}${starred ? "*" : ""} ${title}`).join("\n")}`;
  const width = String(Math.min(lines.length, LISTED_LINES)).length;
  const listed = lines.slice(0, LISTED_LINES).map((line, index) => `${String(index + 1).padStart(width)}| ${line}`).join("\n");
  const rest = lines.length > LISTED_LINES ? `\n… ${lines.length - LISTED_LINES} more lines; read the file for them.` : "";
  return `${head.join("\n")}\n\n${outlined}\n\nSource (the "N| " before each line is not part of the text):\n${listed}${rest}\n\n${OPERATIONS_HELP}\nAfter changing the document, ${compileWith} builds the PDF and reports LaTeX errors with their lines.`;
}
