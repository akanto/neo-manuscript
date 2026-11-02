import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { compile, sourceFileOf, type CompileContext } from "../../core/compile.ts";
import { describeDocument } from "../../core/describe.ts";
import { NEW_DOCUMENT, parseDocument, serializeDocument, type TexDocument } from "../../core/document.ts";
import { applyOperation, parseOperation } from "../../core/ops.ts";
import { kindOf, looksLikeMarkdown, mainFileFor, startsDocument } from "../../core/project.ts";
import type { AppHost, AppTaskContext } from "./api.ts";

const posix = (path: string) => path.split(sep).join("/");

/**
 * Builds the document, or the main file that builds it when it is a part (a chapter): the one its "% !TEX root" line
 * names, else the main file of its folder or of the nearest one above it in the workspace. The build goes in the main
 * file's folder; the report the summary names is named from the workspace, as the view names files.
 */
async function build(context: AppTaskContext<TexDocument>): Promise<string> {
  const { documentFolder, workspaceFolder, document } = context;
  // A Markdown file isn't built: the view renders it.
  const own = await sourceFileOf(documentFolder, document, [".tex", ".md", ".markdown"]);
  if (own ? kindOf(own) === "markdown" : looksLikeMarkdown(document.text)) return `${own ?? "The document"} is Markdown: there is nothing to build.`;

  const ownPath = own && posix(relative(workspaceFolder, join(documentFolder, own)));
  const main = ownPath && !startsDocument(document.text)
    ? await mainFileFor(ownPath, {
        filesIn: async (folder) => (await readdir(join(workspaceFolder, folder), { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile()).map((entry) => entry.name),
        read: (path) => readFile(join(workspaceFolder, path), "utf8").catch(() => null),
      })
    : null;
  const plan: CompileContext = main && main !== ownPath ? { ...context, documentFolder: join(workspaceFolder, dirname(main)), source: main.slice(main.lastIndexOf("/") + 1) } : context;
  const folder = posix(relative(workspaceFolder, plan.documentFolder));
  const fromWorkspace = (text: string) => (folder ? text.replace(/Report: (\S+\.report\.json)/, `Report: ${folder}/$1`) : text);
  try {
    return fromWorkspace(await compile(plan));
  } catch (error) {
    throw new Error(fromWorkspace((error as Error).message));
  }
}

/** The plugin's host module, which Mirador runs in its own process: the document's operations, and the build as a task. */
const host: AppHost<TexDocument> = {
  parse: parseDocument,
  serialize: serializeDocument,
  apply(document, operation) {
    return applyOperation(document, parseOperation(operation));
  },
  describe: (document) => describeDocument(document, 'app_run "compile"'),
  create: (openedFile) => parseDocument(openedFile && kindOf(openedFile) !== "tex" ? "" : NEW_DOCUMENT),
  tasks: {
    compile: { title: "Compile the PDF", run: build },
  },
};

export default host;
