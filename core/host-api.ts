/**
 * What the view and a host say to each other, whatever the host is: the Mirador plugin, or a standalone app. The view
 * gets a HostBridge and nothing else from its host. The shapes are those of Mirador's app API (version 4), so that
 * Mirador's `window.mirador` is a HostBridge as it is.
 */

import type { ChatEvent, ChatImage, PastChat } from "./chat.ts";
import type { ProjectState } from "./project.ts";

export type { ProjectState };

/** Who made a change: the agent, the user in the view, or someone editing the file outside the app. */
export type Author =
  | { kind: "agent"; conversationId: string; turnSeq: number | null }
  | { kind: "you" }
  | { kind: "outside" };

export interface Change {
  seq: number;
  author: Author;
  summary: string;
  touched: string[];
  at: number;
}

export interface TaskState {
  name: string;
  title: string;
  runId: number;
  state: "running" | "done" | "failed" | "stopped";
  author: Author;
  done: number | null;
  text: string | null;
  summary: string | null;
  problem: string | null;
  startedAt: number;
  endedAt: number | null;
}

/** What the view gets on every change. */
export interface DocumentState<Document = unknown> {
  workspaceId: string;
  app: string;
  document: Document;
  /** The document's file, relative to the project's folder, from a host with projects; another file means another document. */
  file?: string;
  lastChange: Change | null;
  /** Why the file isn't shown as it is now: it stopped parsing after an edit made outside the app. */
  problem: string | null;
  task: TaskState | null;
}

/** The view's way to its host. What is optional, a host may not offer: the view then leaves out what needs it. */
export interface HostBridge<Document = unknown> {
  onState(listener: (state: DocumentState<Document>) => void): () => void;
  apply(operation: unknown): void;
  /** Sends the agent a message. */
  prompt?(text: string, options?: { images?: Blob[] }): Promise<void>;
  /** Reads a file in the document's folder or below, by a path relative to that folder. */
  readFile?(path: string): Promise<Blob>;
  run?(task: string): void;
  stopTask?(): void;
  storage?: Storage;
  /** A host with a project of several files: the view then shows its files, and opens one in place of another. */
  project?: ProjectBridge;
  /** A host with a chat of its own with an agent: the view then shows it, and its Ask goes there. */
  chat?: ChatBridge;
}

/**
 * The chat's side of a HostBridge. Its events are those of an ACP conversation, in order (see hosts/desktop/chat.ts); a
 * `null` means the conversation started again, and the events that follow are the new one's.
 */
export interface ChatBridge {
  onEvent(listener: (event: ChatEvent | null) => void): () => void;
  send(text: string, images?: ChatImage[]): Promise<void>;
  cancel(): void;
  /** Starts a new conversation, or with another agent, takes up the last one with it. */
  newChat(agent?: string): Promise<void>;
  /** The agent's earlier conversations about the project, the latest first. */
  pastChats(): Promise<PastChat[]>;
  /** Takes up a conversation of the past again. */
  resume(sessionId: string): Promise<void>;
  /** Starts the agent before the first message, so its models can be chosen. */
  warmUp(): void;
  setConfig(configId: string, value: string | boolean): Promise<void>;
  answerPermission(id: number, optionId: string | null): void;
  /** Opens a link of the agent's answer outside the app. */
  openLink(url: string): void;
}

/**
 * The project's side of a HostBridge. Paths are relative to the project's folder, with "/" between folders. A host
 * lists the project's files; what else it can do is optional, and the view offers only that: Mirador's plugin, for one,
 * can't open another file in the editor, nor change the project's files.
 */
export interface ProjectBridge {
  onProject(listener: (state: ProjectState) => void): () => void;
  /** Lists the project's files again, for a host that doesn't see them change. */
  refresh?(): void;
  /** Opens a text file in the editor; the document's states then are that file's. */
  open?(path: string): Promise<void>;
  /** Applies an operation to a file: the one the editor had open, which may not be the open one by the time it lands. */
  applyTo?(path: string, operation: unknown): void;
  createFile?(path: string): Promise<void>;
  createFolder?(path: string): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
  /** Moves a file or folder to the trash. */
  remove?(path: string): Promise<void>;
  setMain?(path: string): Promise<void>;
  /** Puts files dropped on the view into a folder of the project ("" for its top). */
  upload?(folder: string, files: File[]): Promise<void>;
}
