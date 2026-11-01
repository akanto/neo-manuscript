import { readFile, writeFile } from "node:fs/promises";
import { parseDocument, serializeDocument, type TexDocument } from "../../core/document.ts";
import type { Author, Change } from "../../core/host-api.ts";
import { applyOperation, parseOperation } from "../../core/ops.ts";

/**
 * One text file of a project, open for the view or the agent: its text, changed by operations and written back to the
 * file after every change, and read again when it changes outside the app.
 */
export class DocumentHost {
  private document: TexDocument;
  private change: Change | null = null;
  private seq = 0;
  private listeners = new Set<() => void>();
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    /** The file's path in the project. */
    readonly path: string,
    /** The file's absolute path. */
    readonly file: string,
    document: TexDocument,
  ) {
    this.document = document;
  }

  /** Opens a text file; one that doesn't exist yet starts as `initial` and is written at once. */
  static async open(path: string, file: string, initial = ""): Promise<DocumentHost> {
    const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const host = new DocumentHost(path, file, parseDocument(text ?? initial));
    if (text === null) await host.write();
    return host;
  }

  current(): TexDocument {
    return this.document;
  }

  get lastChange(): Change | null {
    return this.change;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  /** Applies an operation; returns what it did, in a few words. Throws what the operation can't do. */
  async apply(operation: unknown, author: Author): Promise<string> {
    const applied = applyOperation(this.document, parseOperation(operation));
    this.document = applied.document;
    this.change = { seq: ++this.seq, author, summary: applied.summary, touched: applied.touched ?? [], at: Date.now() };
    this.changed();
    await this.write();
    return applied.summary;
  }

  /** Writes the document to its file, one write at a time and in the order of the changes. */
  private write(): Promise<void> {
    const text = serializeDocument(this.document);
    this.writing = this.writing.then(() => writeFile(this.file, text)).catch((error) => console.error(`Writing ${this.file} failed:`, error));
    return this.writing;
  }

  /** Resolves once every change is in the file. */
  written(): Promise<void> {
    return this.writing;
  }

  /** The file changed on disk: takes in its text, unless it is what the app wrote. */
  async readOutsideChange(author: Author = { kind: "outside" }) {
    await this.writing;
    const text = await readFile(this.file, "utf8").catch(() => null);
    if (text === null || text === serializeDocument(this.document)) return;
    this.document = parseDocument(text);
    this.change = { seq: ++this.seq, author, summary: author.kind === "agent" ? "Edited the file" : "Edited in another program", touched: [], at: Date.now() };
    this.changed();
  }

  close() {
    this.listeners.clear();
  }
}
