import type { TexDocument } from "./document.ts";
import { documentClassOf, engineAskedFor, outlineOf } from "./latex.ts";
import { OPERATIONS_HELP } from "./ops.ts";
import { looksLikeMarkdown } from "./project.ts";

/** The longest source describe lists in full; past it, the agent reads the file itself. */
const LISTED_LINES = 1500;

/**
 * The document in words, for the agent: what it is, its outline, then its source with line numbers, and how to change
 * it. `compileWith` names what the agent calls to build the PDF in its host, such as `app_run "compile"`.
 */
export function describeDocument({ text, eol }: TexDocument, compileWith: string): string {
  const lines = text.split("\n");
  if (looksLikeMarkdown(text)) return describeMarkdown(lines, eol);
  const outline = outlineOf(text);
  const head = [
    `A LaTeX document of ${lines.length} lines${eol === "\r\n" ? " (CRLF line breaks in the file; positions count each as one character)" : ""}.`,
    `Class: ${documentClassOf(text) ?? "none found"}. Engine: ${engineAskedFor(text) ?? "default (tectonic); a \"% !TEX program = latexmk\" line at the top builds with MacTeX's latexmk instead"}.`,
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

/** A Markdown document in words, for the agent: there is no build. */
function describeMarkdown(lines: string[], eol: TexDocument["eol"]): string {
  const headings = lines.flatMap((line, index) => (/^#{1,6} /.test(line) ? [`- line ${index + 1}: ${line}`] : []));
  const head = [
    `A Markdown document of ${lines.length} lines${eol === "\r\n" ? " (CRLF line breaks in the file; positions count each as one character)" : ""}.`,
    "The user edits the same text in the app's Source and Visual modes, and sees it rendered beside it. Markdown doesn't build: there is no PDF and nothing to compile.",
  ];
  const outlined = headings.length === 0 ? "Outline: no headings." : `Outline:\n${headings.join("\n")}`;
  const width = String(Math.min(lines.length, LISTED_LINES)).length;
  const listed = lines.slice(0, LISTED_LINES).map((line, index) => `${String(index + 1).padStart(width)}| ${line}`).join("\n");
  const rest = lines.length > LISTED_LINES ? `\n… ${lines.length - LISTED_LINES} more lines; read the file for them.` : "";
  return `${head.join("\n")}\n\n${outlined}\n\nSource (the "N| " before each line is not part of the text):\n${listed}${rest}\n\n${OPERATIONS_HELP}`;
}
