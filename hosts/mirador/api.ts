/**
 * Mirador's app plugin API (version 4), as this plugin uses it. Mirador doesn't publish these types, so this is a copy of
 * the parts of its shared/apps.ts that we need. The view's side of it is core/host-api.ts.
 */
import type { Author, Change } from "../../core/host-api.ts";

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
