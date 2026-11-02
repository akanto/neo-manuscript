import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { compile, sourceFileOf, type CompileContext } from "../../core/compile.ts";
import { describeDocument } from "../../core/describe.ts";
import { NEW_DOCUMENT, parseDocument, serializeDocument, type TexDocument } from "../../core/document.ts";
import { applyOperation, parseOperation } from "../../core/ops.ts";
import { listProject, PROJECT_LISTING } from "../../core/project-files.ts";
import { kindOf, looksLikeMarkdown, startsDocument, type ProjectState } from "../../core/project.ts";
import type { AppHost } from "./api.ts";

/**
 * Writes the project's files, its main file and the document's own file to PROJECT_LISTING, where the view reads them:
 * Mirador's view can read files next to the document, but can't list them. The project is the document's folder.
 */
async function writeListing(context: CompileContext): Promise<ProjectState> {
  const folder = context.documentFolder;
  const { entries, main } = await listProject(folder);
  const listing: ProjectState = { name: basename(folder), entries, main, open: await sourceFileOf(folder, context.document, [".tex", ".md", ".markdown"]) };
  const path = join(folder, PROJECT_LISTING);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(listing)}\n`);
  return listing;
}

/** Builds the document, or the project's main file when the document is a part of it (a chapter), and lists the files. */
async function build(context: CompileContext): Promise<string> {
  try {
    // A Markdown file isn't built: the view renders it.
    const file = await sourceFileOf(context.documentFolder, context.document, [".tex", ".md", ".markdown"]);
    if (file ? kindOf(file) === "markdown" : looksLikeMarkdown(context.document.text)) return `${file ?? "The document"} is Markdown: there is nothing to build.`;
    if (startsDocument(context.document.text)) return await compile(context);
    const { main } = await listProject(context.documentFolder);
    return await compile(main ? { ...context, source: main } : context);
  } finally {
    await writeListing(context).catch(() => {});
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
  create: () => parseDocument(NEW_DOCUMENT),
  tasks: {
    compile: { title: "Compile the PDF", run: build },
    files: {
      title: "List the project's files",
      run: async (context) => {
        const { entries, main } = await writeListing(context);
        return `Listed ${entries.filter((entry) => entry.kind === "file").length} files; the main file is ${main ?? "not there"}.`;
      },
    },
  },
};

export default host;
