/**
 * Mirador's app plugin API (version 21), as this plugin uses it. Mirador doesn't publish these types, so this is a copy of
 * the parts of its shared/apps.ts that we need. The view's side of it is core/host-api.ts.
 */
import type { Author, Change, GitRefs, HostBridge } from "../../core/host-api.ts";

/** What the host module exports. Mirador calls it in its own process and shows what a call throws to whoever made the change. */
export interface AppHost<Document = unknown> {
  parse(text: string): Document;
  serialize(document: Document): string;
  apply(document: Document, operation: unknown, author: Author): { document: Document; inverse: unknown; summary: string; touched?: string[] };
  describe(document: Document): string;
  create?(openedFile?: string): Document;
  tasks?: Record<string, AppTask<Document>>;
}

export interface AppTask<Document = unknown> {
  title: string;
  run(context: AppTaskContext<Document>): Promise<string>;
}

export interface AppTaskContext<Document = unknown> {
  document: Document;
  /** The absolute path of a file in the document's folder or below; a path that leads out of the folder throws. */
  file(path: string): string;
  documentFolder: string;
  workspaceFolder: string;
  pluginFolder: string;
  author: Author;
  apply(operation: unknown): Promise<Change>;
  progress(done: number | null, text?: string): void;
  signal: AbortSignal;
}

/**
 * `window.mirador` in an app's view, as plugin API 6 makes it: HostBridge, with `readFile` reaching the whole workspace
 * through "../" from the document's folder, the state naming its `file` in the workspace, and the workspace's files.
 * Plugin API 21 adds the workspace's git refs; a Mirador before it has none of those four methods.
 */
export interface MiradorBridge<Document = unknown> extends HostBridge<Document> {
  readFile(path: string): Promise<Blob>;
  /** The workspace's files, named from it: those git lists (tracked, or untracked but not ignored), or all of them. */
  listFiles(): Promise<{ files: string[]; truncated: boolean }>;
  /** Opens the app on another file of the workspace, named from it; refused while a task runs. */
  open(file: string): Promise<void>;
  /** Called when the workspace's files may have changed: after a task, an agent's turn, an open. */
  onFiles(listener: () => void): () => void;
  /** The workspace's HEAD and tags; null when it isn't in a git repository. */
  gitRefs?(): Promise<GitRefs | null>;
  /** A file of the workspace, named from it, as it is at a ref (HEAD, a tag or a SHA); null when it isn't there at that ref. */
  readFileAt?(ref: string, path: string): Promise<Blob | null>;
  /** The workspace's files, named from it, that differ from a ref: changed, added, and untracked but not ignored. */
  changedSince?(ref: string): Promise<string[]>;
  /** Called when HEAD or the tags may have moved, once the view asked for the refs. */
  onGitChange?(listener: () => void): () => void;
}
