/**
 * A project is a folder, as on Overleaf: the main .tex file the build compiles, and the files it brings in (chapters
 * through \input and \include, a .bib, figures, a class or style). These are the parts a host needs whatever it is.
 */
import { commentStart } from "./latex.ts";

/** A file or folder of the project, by its path relative to the project's folder, with "/" between folders. */
export interface ProjectEntry {
  path: string;
  kind: "file" | "folder";
}

/** What the view shows of the project, and the file it has open. */
export interface ProjectState {
  name: string;
  entries: ProjectEntry[];
  /** The file the build compiles; null when no .tex file at the top of the project starts a document. */
  main: string | null;
  /** The text file open in the editor; null before one is. */
  open: string | null;
}

/** Folders and files a project doesn't show: the build's, version control's, and the system's own. */
const HIDDEN = new Set([".latex-build", ".git", ".svn", ".hg", "node_modules", ".DS_Store", "Thumbs.db", ".hutch"]);

/** Whether a name in the project is left out of it: those above, and every other dotfile. */
export const isHidden = (name: string) => HIDDEN.has(name) || name.startsWith(".");

/** The files the editor opens as text; anything else (an image, a PDF) is only shown. */
const TEXT_EXTENSIONS = new Set(["tex", "ltx", "latex", "bib", "bbx", "cbx", "sty", "cls", "clo", "def", "cfg", "bst", "txt", "md", "markdown", "csv", "tsv", "dat", "json", "yaml", "yml", "xml", "toml", "lua", "py", "r", "m", "sh", "mk", "makefile", "latexmkrc", "gitignore", "dtx", "ins", "tikz", "pgf", "asy", "gp", "svg"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

export const extensionOf = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(dot + 1);
};

export type FileKind = "tex" | "text" | "image" | "pdf" | "other";

export function kindOf(path: string): FileKind {
  const extension = extensionOf(path);
  if (extension === "tex" || extension === "ltx" || extension === "latex") return "tex";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (extension === "pdf") return "pdf";
  return "other";
}

export const isTextFile = (path: string) => kindOf(path) === "tex" || kindOf(path) === "text";

/** Whether a .tex file's text starts a document: a \documentclass that isn't commented out. */
export function startsDocument(text: string): boolean {
  for (const line of text.split("\n")) {
    const code = line.slice(0, commentStart(line));
    if (/\\documentclass\s*[[{]/.test(code)) return true;
  }
  return false;
}

/** The root a "% !TEX root = ../main.tex" line at the top of a file names, as written. */
export function rootNamedIn(text: string): string | null {
  for (const line of text.split("\n").slice(0, 20)) {
    const root = /^\s*%\s*!TEX\s+root\s*=\s*(.+?)\s*$/i.exec(line);
    if (root) return root[1]!;
  }
  return null;
}

/**
 * The project's main file, of the .tex files at its top (`candidates`, with their texts): the one the user chose while
 * it still starts a document, else main.tex, else the only one, else the one named like the folder, else the first by
 * name. Only files that start a document count.
 */
export function findMainFile(candidates: { path: string; text: string }[], folderName: string, chosen: string | null = null): string | null {
  const documents = candidates.filter(({ path, text }) => !path.includes("/") && kindOf(path) === "tex" && startsDocument(text)).map(({ path }) => path).sort();
  if (chosen && documents.includes(chosen)) return chosen;
  if (documents.includes("main.tex")) return "main.tex";
  if (documents.length <= 1) return documents[0] ?? null;
  return documents.find((path) => path.replace(/\.[^.]+$/, "").toLowerCase() === folderName.toLowerCase()) ?? documents[0]!;
}

/** Whether a path, as the view or the agent gives it, stays inside the project: relative, and with no "..". */
export function isProjectPath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[a-zA-Z]:/.test(path)) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
