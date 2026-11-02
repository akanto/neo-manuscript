import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";
import { parseDocument, serializeDocument, type TexDocument } from "./document.ts";
import { engineAskedFor, type Engine } from "./latex.ts";
import { BUILD_FOLDER, type BuildReport, type Problem, reportPath } from "./build.ts";

/** Where TeX is often installed, which an app started from the Dock doesn't have on its PATH. */
const TEX_DIRS = ["/Library/TeX/texbin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/usr/texbin"];

export function searchPath(): string {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return [...new Set([...dirs, ...TEX_DIRS])].join(delimiter);
}

const which = (command: string) => Bun.which(command, { PATH: searchPath() });

/** What a build needs from its host. Mirador's task context is one, as it is. */
export interface CompileContext {
  document: TexDocument;
  documentFolder: string;
  /**
   * The file to build, relative to the document's folder, when the host knows it: a project's main file, which may not
   * be the document open. Without it, the build finds the document's file by its text.
   */
  source?: string;
  progress(done: number | null, text?: string): void;
  signal: AbortSignal;
}

/** The .tex file (or a file of another of `extensions`) in the document's folder that holds the document, as the task isn't told which file it is. */
export async function sourceFileOf(folder: string, document: TexDocument, extensions = [".tex"]): Promise<string | null> {
  const names = (await readdir(folder)).filter((name) => extensions.some((extension) => name.endsWith(extension))).sort();
  for (const name of names) {
    const text = await readFile(join(folder, name), "utf8").catch(() => null);
    if (text !== null && parseDocument(text).text === document.text) return name;
  }
  return null;
}

interface Plan {
  engine: Engine;
  /** The program and its arguments, for each run; the plain engines run again while the log asks for it. */
  command: string[];
  rerun: boolean;
}

/** How to build the file: what its `% !TEX program` asks for, else latexmk, else pdflatex, else tectonic. */
export function planBuild(text: string, file: string, found: (command: string) => string | null = which): Plan {
  const asked = engineAskedFor(text);
  const plain = (engine: "pdflatex" | "xelatex" | "lualatex", path: string): Plan => ({
    engine,
    command: [path, "-interaction=nonstopmode", "-file-line-error", "-synctex=1", `-output-directory=${BUILD_FOLDER}`, file],
    rerun: true,
  });
  const latexmk = (path: string, engine: "pdflatex" | "xelatex" | "lualatex"): Plan => ({
    engine: "latexmk",
    command: [path, { pdflatex: "-pdf", xelatex: "-pdfxe", lualatex: "-pdflua" }[engine], "-interaction=nonstopmode", "-file-line-error", "-synctex=1", `-outdir=${BUILD_FOLDER}`, file],
    rerun: false,
  });
  const tectonic = (path: string): Plan => ({
    engine: "tectonic",
    command: [path, "-X", "compile", file, "--outdir", BUILD_FOLDER, "--synctex", "--keep-logs"],
    rerun: false,
  });
  const missing = (what: string) =>
    new Error(`${what} isn't installed (looked on the PATH and in ${TEX_DIRS.join(", ")}). Install MacTeX or TeX Live, or Tectonic (brew install tectonic), or name another engine with a "% !TEX program = ..." line at the top of the file.`);

  if (asked === "tectonic") {
    const path = found("tectonic");
    if (!path) throw missing("tectonic");
    return tectonic(path);
  }
  const engine = asked === null || asked === "latexmk" ? "pdflatex" : asked;
  const latexmkPath = found("latexmk");
  if (latexmkPath) return latexmk(latexmkPath, engine);
  if (asked === "latexmk") throw missing("latexmk");
  const enginePath = found(engine);
  if (enginePath) return plain(engine, enginePath);
  const tectonicPath = asked === null ? found("tectonic") : null;
  if (tectonicPath) return tectonic(tectonicPath);
  throw missing(engine);
}

const MAX_RUNS = 3;
const RUN_LIMIT_MS = 120_000;

async function run(command: string[], cwd: string, signal: AbortSignal, env: Record<string, string> = {}): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, PATH: searchPath(), ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stop = () => child.kill();
  signal.addEventListener("abort", stop);
  const timer = setTimeout(stop, RUN_LIMIT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (signal.aborted) throw new Error("The build was stopped.");
    return { code, output: `${stdout}\n${stderr}` };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}

/**
 * The errors and warnings in a TeX log written with -file-line-error ("./paper.tex:12: Undefined control sequence.",
 * then the "l.12 ..." context), and in Tectonic's output ("error: paper.tex:12: ...").
 */
export function problemsIn(log: string): Problem[] {
  const problems: Problem[] = [];
  const seen = new Set<string>();
  const add = (problem: Problem) => {
    const key = `${problem.severity}:${problem.file}:${problem.line}:${problem.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      problems.push(problem);
    }
  };
  const lines = log.split(/\r?\n/);
  lines.forEach((line, index) => {
    const fileLine = /^(?:error: |warning: )?(\.?\/?[^:\s][^:]*\.(?:tex|sty|cls|bib|bbl|aux)):(\d+): (.*)$/.exec(line);
    if (fileLine) {
      const severity = line.startsWith("warning: ") ? "warning" : "error";
      let message = fileLine[3]!.trim();
      // A message that goes on past the end of the log line continues on the next one.
      const following = lines[index + 1];
      if (following && !/^(l\.\d+|\s*$|[!.]|\(|<)/.test(following) && message.length >= 70) message += following.trim();
      add({ severity, file: fileLine[1]!.replace(/^\.\//, ""), line: Number(fileLine[2]), message });
      return;
    }
    if (/^! /.test(line)) {
      const context = lines.slice(index + 1, index + 12).find((next) => /^l\.\d+/.test(next));
      add({ severity: "error", file: null, line: context ? Number(/^l\.(\d+)/.exec(context)![1]) : null, message: line.slice(2).trim() });
      return;
    }
    const warning = /^(?:LaTeX|Package (\S+)|Class (\S+)) Warning: (.*)$/.exec(line);
    if (warning) {
      let message = warning[3]!;
      for (let next = index + 1; next < lines.length && /^\(\S+\)\s/.test(lines[next]!); next++) message += ` ${lines[next]!.replace(/^\(\S+\)\s+/, "")}`;
      const onLine = /on input line (\d+)\.?/.exec(message);
      const who = warning[1] ?? warning[2];
      add({ severity: "warning", file: null, line: onLine ? Number(onLine[1]) : null, message: `${who ? `${who}: ` : ""}${message.replace(/\s*on input line \d+\.?/, "").trim()}` });
    }
  });
  return problems;
}

/**
 * What makes the bibliography after a plain engine's first pass: BibTeX when the .aux names the .bib files with
 * \bibdata (\bibliography, natbib, biblatex's bibtex backend), Biber when biblatex wrote a .bcf for it.
 */
export function bibliographyTool(aux: string, bcf: boolean): "bibtex" | "biber" | null {
  if (/\\bibdata\s*\{/.test(aux)) return "bibtex";
  return bcf ? "biber" : null;
}

/** BibTeX's errors (a message, then "---line 3 of file refs.bib") and warnings, and Biber's ERROR and WARN lines. */
export function bibliographyProblemsIn(output: string, tool: "bibtex" | "biber"): Problem[] {
  const problems: Problem[] = [];
  const lines = output.split(/\r?\n/);
  const add = (severity: Problem["severity"], message: string) => {
    if (!problems.some((problem) => problem.severity === severity && problem.message === message)) problems.push({ severity, file: null, line: null, message });
  };
  if (tool === "biber") {
    for (const line of lines) {
      const said = /^(ERROR|WARN) - (.*)$/.exec(line);
      if (said) add(said[1] === "ERROR" ? "error" : "warning", `Biber: ${said[2]!.trim()}`);
    }
    return problems;
  }
  lines.forEach((line, index) => {
    const warning = /^Warning--(.*)$/.exec(line);
    if (warning) return add("warning", `BibTeX: ${warning[1]!.trim()}`);
    const where = /^(.*?)---line (\d+) of file (.+)$/.exec(line);
    if (!where) return;
    const message = where[1]!.trim() || lines[index - 1]?.trim() || "error";
    // The .aux's lines mean nothing to the writer; a .bib's do.
    const file = basename(where[3]!.trim());
    add("error", `BibTeX: ${message}${file.endsWith(".aux") ? "" : ` (${file}, line ${where[2]})`}`);
  });
  return problems;
}

/** The numbers or labels the document's citations got, from the \bibcite lines of the .aux (natbib's first group). */
export function citationsIn(aux: string): Record<string, string> {
  const citations: Record<string, string> = {};
  for (const match of aux.matchAll(/\\bibcite\{([^}]*)\}\{/g)) {
    let depth = 1;
    let end = match.index + match[0].length;
    while (end < aux.length && depth > 0) {
      if (aux[end] === "{") depth++;
      else if (aux[end] === "}") depth--;
      end++;
    }
    const label = aux.slice(match.index + match[0].length, end - 1);
    citations[match[1]!] = (/^\{([^{}]*)\}/.exec(label)?.[1] ?? label).trim();
  }
  return citations;
}

const RERUN = /Rerun to get|Label\(s\) may have changed|Rerun LaTeX|There were undefined references/;

function pagesIn(log: string): number | null {
  const match = /Output written on .*?\((\d+) pages?/.exec(log);
  return match ? Number(match[1]) : null;
}

/**
 * Runs BibTeX or Biber when the first pass asks for one, so the next pass reads the .bbl; returns what it reported, or
 * null when the document has no bibliography to make.
 */
async function makeBibliography(context: CompileContext, buildDir: string, job: string, started: number): Promise<Problem[] | null> {
  const { documentFolder, signal } = context;
  const aux = await readFile(join(buildDir, `${job}.aux`), "utf8").catch(() => "");
  const bcf = await stat(join(buildDir, `${job}.bcf`)).catch(() => null);
  const tool = bibliographyTool(aux, bcf !== null && bcf.mtimeMs >= started - 1000);
  if (!tool) return null;
  const path = which(tool);
  if (!path) {
    return [{ severity: "error", file: null, line: null, message: `${tool === "bibtex" ? "BibTeX" : "Biber"} isn't installed, so the citations from the .bib file stay undefined. Install it with TeX Live (tlmgr install ${tool}), or install latexmk.` }];
  }
  context.progress(null, `Running ${tool}…`);
  const { output } =
    tool === "bibtex"
      ? // From the build folder: TeX Live won't let BibTeX write into a folder whose name starts with a dot. The .bib and
        // .bst files are looked for next to the document, then where TeX keeps its own.
        await run([path, job], buildDir, signal, { BIBINPUTS: `${documentFolder}${delimiter}`, BSTINPUTS: `${documentFolder}${delimiter}` })
      : await run([path, "--output-directory", BUILD_FOLDER, job], documentFolder, signal);
  return bibliographyProblemsIn(output, tool);
}

/** Whether latexmk found nothing to do, as no source changed since its last build: a success with no new PDF. */
export function isUpToDate(engine: Engine, code: number, output: string): boolean {
  return engine === "latexmk" && code === 0 && /All targets \(.*\) are up-to-date/.test(output);
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/** Builds the document's PDF in .latex-build/ next to it, and writes the build's report there for the view. */
export async function compile(context: CompileContext): Promise<string> {
  const { document, documentFolder, signal } = context;
  const buildDir = join(documentFolder, BUILD_FOLDER);
  await mkdir(buildDir, { recursive: true });

  let file = context.source ?? (await sourceFileOf(documentFolder, document));
  if (!file) {
    // The file on disk isn't the document as it is now (it may not be written yet): build a copy of the document.
    file = join(BUILD_FOLDER, "_document.tex");
    await writeFile(join(documentFolder, file), serializeDocument(document));
  }
  const job = basename(file, ".tex");
  const plan = planBuild(context.source ? parseDocument(await readFile(join(documentFolder, file), "utf8")).text : document.text, file);
  const pdf = join(BUILD_FOLDER, `${job}.pdf`);
  const started = Date.now();

  let output = "";
  let code = 0;
  let log = "";
  const bibliographyProblems: Problem[] = [];
  for (let runs = 1; ; runs++) {
    context.progress(null, `Running ${plan.engine}${runs > 1 ? ` (pass ${runs})` : ""}…`);
    ({ output, code } = await run(plan.command, documentFolder, signal));
    log = await readFile(join(buildDir, `${job}.log`), "utf8").catch(() => "");
    // latexmk and Tectonic make the bibliography themselves; a plain engine needs BibTeX or Biber between its passes.
    const made = plan.rerun && runs === 1 ? await makeBibliography(context, buildDir, job, started) : null;
    if (made) bibliographyProblems.push(...made);
    if (!plan.rerun || runs >= MAX_RUNS || (!made && !RERUN.test(log)) || problemsIn(log).some((p) => p.severity === "error")) break;
  }

  // latexmk echoes every pass, and the first ones warn of citations and labels that the last pass resolved; its last
  // pass's log holds what is still wrong.
  const problems = [...problemsIn(plan.engine === "latexmk" ? log : `${log}\n${output}`), ...bibliographyProblems];
  const pdfStat = await stat(join(documentFolder, pdf)).catch(() => null);
  // latexmk leaves a PDF that is already up to date with its sources as it is, so its time doesn't move.
  const upToDate = isUpToDate(plan.engine, code, output);
  const fresh = pdfStat !== null && (pdfStat.mtimeMs >= started - 1000 || upToDate);
  const errors = problems.filter((problem) => problem.severity === "error");
  const warnings = problems.length - errors.length;
  const report: BuildReport = {
    source: file,
    pdf: fresh || (pdfStat && existsSync(join(documentFolder, pdf))) ? pdf : null,
    fresh,
    engine: plan.engine,
    pages: pagesIn(log),
    problems,
    citations: citationsIn(await readFile(join(buildDir, `${job}.aux`), "utf8").catch(() => "")),
    at: Date.now(),
  };
  await writeFile(join(documentFolder, reportPath(job)), `${JSON.stringify(report, null, 2)}\n`);

  const firstErrors = errors.slice(0, 5).map((error) => `- ${error.line ? `line ${error.line}: ` : ""}${error.message}`);
  const reportNote = `Report: ${reportPath(job)}.`;
  if (!fresh) {
    const why = firstErrors.length > 0 ? firstErrors.join("\n") : `- ${output.trim().split("\n").slice(-6).join("\n  ")}`;
    throw new Error(`${file} didn't compile with ${plan.engine}${report.pdf ? "; the PDF shown is from an earlier build" : ""}.\n${why}\n${reportNote}`);
  }
  const pages = report.pages === null ? "" : `${count(report.pages, "page")}, `;
  return [`Compiled ${file} with ${plan.engine} to ${pdf}: ${pages}${count(errors.length, "error")}, ${count(warnings, "warning")}.`, ...firstErrors, reportNote].join("\n");
}
