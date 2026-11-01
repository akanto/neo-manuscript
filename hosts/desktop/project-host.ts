import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { compile } from "../../core/compile.ts";
import { NEW_DOCUMENT, parseDocument, type TexDocument } from "../../core/document.ts";
import type { Author, DocumentState, TaskState } from "../../core/host-api.ts";
import { listProject } from "../../core/project-files.ts";
import { isHidden, isProjectPath, isTextFile, kindOf, type ProjectEntry, type ProjectState } from "../../core/project.ts";
import { DocumentHost } from "./document-host.ts";

/** How long the folder has to stay still after a change before the project is listed again. */
const SETTLE_MS = 150;

export interface ProjectOptions {
  /** The main file the user chose before, if any. */
  main?: string | null;
  /** The file to open first, if any; else the main file. */
  open?: string | null;
  /** Moves a file or folder (by its absolute path) to the trash. */
  trash(path: string): Promise<void>;
}

/** What a project remembers for the next time it opens, told to the app as it changes. */
export interface ProjectMemory {
  main: string | null;
  open: string | null;
}

/**
 * A project open in the app: a folder, its files, its main file, the text files open for the view and the agent, and
 * the build of the main file as a task. The view sees one file at a time, the open one.
 */
export class ProjectHost {
  readonly name: string;
  private entries: ProjectEntry[] = [];
  private main: string | null = null;
  private chosenMain: string | null;
  private documents = new Map<string, DocumentHost>();
  private openPath: string | null = null;
  private task: TaskState | null = null;
  private runId = 0;
  private abort: AbortController | null = null;
  private building: Promise<unknown> | null = null;
  private stateListeners = new Set<(state: DocumentState<TexDocument> | null) => void>();
  private projectListeners = new Set<(state: ProjectState) => void>();
  private watcher: FSWatcher | null = null;
  private listTimer: ReturnType<typeof setTimeout> | null = null;
  private stopListening: (() => void) | null = null;
  /** Called when what the project remembers changes. */
  onMemory: (memory: ProjectMemory) => void = () => {};
  /** Who a change made to a file outside the app is by, when the app knows: the agent, while it has its turn. */
  outsideAuthor: () => Author | null = () => null;

  private constructor(readonly folder: string, private readonly options: ProjectOptions) {
    this.name = basename(folder);
    this.chosenMain = options.main ?? null;
  }

  /** Opens a folder, by its real path: agents name their conversations' folders by it, and see through links. */
  static async open(folder: string, options: ProjectOptions): Promise<ProjectHost> {
    if (!(await stat(folder)).isDirectory()) throw new Error(`${folder} isn't a folder`);
    const project = new ProjectHost(await realpath(folder), options);
    await project.list();
    const first = [options.open, project.main].find((path): path is string => !!path && project.has(path) && isTextFile(path));
    if (first) await project.openFile(first);
    project.watch();
    return project;
  }

  // --- What the view sees -------------------------------------------------------------------------------------------

  /** The open file's state, with the project's build; null with no file open. */
  state(): DocumentState<TexDocument> | null {
    const open = this.openPath === null ? null : this.documents.get(this.openPath);
    if (!open) return null;
    return { workspaceId: this.folder, app: "neo-manuscript", document: open.current(), file: open.path, lastChange: open.lastChange, problem: null, task: this.task };
  }

  projectState(): ProjectState {
    return { name: this.name, entries: this.entries, main: this.main, open: this.openPath };
  }

  onState(listener: (state: DocumentState<TexDocument> | null) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onProject(listener: (state: ProjectState) => void): () => void {
    this.projectListeners.add(listener);
    return () => this.projectListeners.delete(listener);
  }

  private stateChanged() {
    const state = this.state();
    for (const listener of this.stateListeners) listener(state);
  }

  private projectChanged() {
    const state = this.projectState();
    for (const listener of this.projectListeners) listener(state);
    this.onMemory({ main: this.chosenMain, open: this.openPath });
  }

  // --- Files ----------------------------------------------------------------------------------------------------------

  has(path: string): boolean {
    return this.entries.some((entry) => entry.path === path);
  }

  /** The absolute path of a path in the project; throws for one that leads out of it. */
  pathOf(path: string): string {
    if (!isProjectPath(path)) throw new Error(`"${path}" isn't a path in the project`);
    return join(this.folder, ...path.split("/"));
  }

  /** A text file of the project, opened for the view or the agent if it isn't yet. */
  async document(path: string): Promise<DocumentHost> {
    const known = this.documents.get(path);
    if (known) return known;
    if (!isTextFile(path)) throw new Error(`${path} isn't a text file`);
    const opened = await DocumentHost.open(path, this.pathOf(path));
    // Another call may have opened it meanwhile.
    const raced = this.documents.get(path);
    if (raced) return raced;
    this.documents.set(path, opened);
    return opened;
  }

  /** Shows a text file in the view. */
  async openFile(path: string) {
    const document = await this.document(path);
    this.stopListening?.();
    this.stopListening = document.onChange(() => this.stateChanged());
    this.openPath = path;
    this.stateChanged();
    this.projectChanged();
  }

  /** Applies an operation to a file (the open one by default); returns what it did. */
  async apply(operation: unknown, author: Author, path = this.openPath): Promise<string> {
    if (path === null) throw new Error("No file is open");
    return (await this.document(path)).apply(operation, author);
  }

  /** Creates a file and opens it; the first .tex file at the top of a project starts as a small article. */
  async createFile(path: string, { open = true } = {}) {
    const file = this.pathOf(path);
    const text = kindOf(path) === "tex" && !path.includes("/") && this.main === null ? NEW_DOCUMENT : "";
    if (await exists(file)) throw new Error(`${path} exists already`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text, { flag: "wx" });
    await this.list();
    if (open && isTextFile(path)) await this.openFile(path);
  }

  async createFolder(path: string) {
    const folder = this.pathOf(path);
    if (await exists(folder)) throw new Error(`${path} exists already`);
    await mkdir(folder, { recursive: true });
    await this.list();
  }

  /** Writes a file the user brought in (dropped on the view), keeping one there already under another name. */
  async upload(folder: string, name: string, bytes: Uint8Array): Promise<string> {
    if (folder !== "" && !isProjectPath(folder)) throw new Error(`"${folder}" isn't a folder in the project`);
    const base = basename(name);
    let path = folder ? `${folder}/${base}` : base;
    for (let copy = 2; await exists(this.pathOf(path)); copy++) {
      const dot = base.lastIndexOf(".");
      const numbered = dot > 0 ? `${base.slice(0, dot)} ${copy}${base.slice(dot)}` : `${base} ${copy}`;
      path = folder ? `${folder}/${numbered}` : numbered;
    }
    await mkdir(dirname(this.pathOf(path)), { recursive: true });
    await writeFile(this.pathOf(path), bytes);
    await this.list();
    return path;
  }

  /** Renames or moves a file or folder; open files under it move with it. */
  async rename(from: string, to: string) {
    const source = this.pathOf(from);
    const target = this.pathOf(to);
    if (await exists(target)) throw new Error(`${to} exists already`);
    await Promise.all([...this.documents.values()].map((document) => document.written()));
    await mkdir(dirname(target), { recursive: true });
    await rename(source, target);
    const moved = (path: string) => (path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : null);
    for (const [path, document] of [...this.documents]) {
      if (moved(path) === null) continue;
      document.close();
      this.documents.delete(path);
    }
    if (this.chosenMain && moved(this.chosenMain)) this.chosenMain = moved(this.chosenMain);
    await this.list();
    const open = this.openPath && moved(this.openPath);
    if (open) await this.openFile(open);
  }

  /** Moves a file or folder to the trash; the open file, if it goes, gives way to the main file. */
  async remove(path: string) {
    const gone = (other: string) => other === path || other.startsWith(`${path}/`);
    for (const [other, document] of [...this.documents]) {
      if (!gone(other)) continue;
      await document.written();
      document.close();
      this.documents.delete(other);
    }
    await this.options.trash(this.pathOf(path));
    await this.list();
    if (this.openPath && gone(this.openPath)) {
      this.stopListening?.();
      this.openPath = null;
      if (this.main) await this.openFile(this.main);
      else this.stateChanged();
    }
  }

  async setMain(path: string) {
    this.chosenMain = path;
    await this.list();
    if (this.main !== path) throw new Error(`${path} doesn't start a document (it has no \\documentclass)`);
  }

  /** Lists the project's files again, and finds its main file. */
  private async list() {
    const { entries, main } = await listProject(this.folder, { textOf: (path) => this.documents.get(path)?.current().text ?? null, chosen: this.chosenMain });
    this.entries = entries;
    this.main = main;
    this.projectChanged();
  }

  /** Watches the folder and everything in it: files added, removed or renamed, and text files changed outside the app. */
  private watch() {
    const changed = new Set<string>();
    this.watcher = watch(this.folder, { recursive: true }, (_event, name) => {
      const path = name?.toString().split(/[\\/]/).join("/") ?? null;
      if (path && path.split("/").some(isHidden)) return;
      if (path) changed.add(path);
      if (this.listTimer) clearTimeout(this.listTimer);
      this.listTimer = setTimeout(() => {
        this.listTimer = null;
        const author = this.outsideAuthor() ?? { kind: "outside" };
        for (const path of changed) void this.documents.get(path)?.readOutsideChange(author);
        changed.clear();
        void this.list();
      }, SETTLE_MS);
    });
  }

  // --- Building -------------------------------------------------------------------------------------------------------

  /** Builds the main file once the build running, if any, is done: for the agent, who wants a build of its changes. */
  async compileWhenFree(author: Author): Promise<string> {
    while (this.building) await this.building.catch(() => {});
    return this.compile(author);
  }

  /** Builds the main file. A build already running is left to finish. Resolves to the build's summary. */
  compile(author: Author): Promise<string> {
    if (this.task?.state === "running") return Promise.reject(new Error("A build is running already"));
    const building = this.build(author).finally(() => {
      if (this.building === building) this.building = null;
    });
    this.building = building;
    return building;
  }

  private async build(author: Author): Promise<string> {
    const main = this.main;
    if (!main) throw new Error("The project has no main file: no .tex file at its top starts a document with \\documentclass");
    const abort = (this.abort = new AbortController());
    this.task = { name: "compile", title: "Compile the PDF", runId: ++this.runId, state: "running", author, done: null, text: null, summary: null, problem: null, startedAt: Date.now(), endedAt: null };
    this.stateChanged();
    try {
      await Promise.all([...this.documents.values()].map((document) => document.written()));
      const document = this.documents.get(main)?.current() ?? parseDocument(await readFile(this.pathOf(main), "utf8"));
      const summary = await compile({
        document,
        documentFolder: this.folder,
        source: main,
        progress: (done, text) => {
          if (this.task) this.task = { ...this.task, done, text: text ?? null };
          this.stateChanged();
        },
        signal: abort.signal,
      });
      this.task = { ...this.task, state: "done", summary, endedAt: Date.now() };
      return summary;
    } catch (error) {
      const message = (error as Error).message;
      this.task = { ...this.task, state: abort.signal.aborted ? "stopped" : "failed", problem: message, endedAt: Date.now() };
      throw error;
    } finally {
      this.abort = null;
      this.stateChanged();
    }
  }

  stopTask() {
    this.abort?.abort();
  }

  close() {
    this.watcher?.close();
    if (this.listTimer) clearTimeout(this.listTimer);
    this.abort?.abort();
    this.stopListening?.();
    for (const document of this.documents.values()) document.close();
    this.stateListeners.clear();
    this.projectListeners.clear();
  }
}

const exists = (path: string) => stat(path).then(() => true, () => false);
