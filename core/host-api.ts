/**
 * What the view and a host say to each other, whatever the host is: the Mirador plugin, or a standalone app. The view
 * gets a HostBridge and nothing else from its host. The shapes are those of Mirador's app API (version 4), so that
 * Mirador's `window.mirador` is a HostBridge as it is.
 */

import type { RewriteRequest } from "./assist.ts";
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
  /** The TeX engines this machine can build with (see core/latex.ts); without it the view offers them all. */
  engines?(): Promise<string[]>;
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
  /** Signs the agent in, for a host that can (after a "signed-out" status); the agent then starts again. */
  signIn?(): Promise<void>;
  /**
   * Has the agent rewrite a passage on the side, out of the conversation, and answers with what it said (see
   * core/assist.ts). A new rewrite stops the one before it.
   */
  rewrite?(request: RewriteRequest, signal?: AbortSignal): Promise<string>;
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
  /**
   * The git refs the project's files can be compared with, for the change highlight; null when the project's folder
   * isn't in a git repository. A host without these four lets the view compare with the text as it was when opened.
   */
  gitRefs?(): Promise<GitRefs | null>;
  /** A text file of the project as it is at a ref (HEAD, a tag or a commit); null when it doesn't exist there. */
  fileAt?(ref: string, path: string): Promise<string | null>;
  /** The project's files that differ from a ref on disk: changed, added, and untracked but not ignored. */
  changedSince?(ref: string): Promise<string[]>;
  /** Called when HEAD or the tags may have moved: a commit, a checkout, a new tag. */
  onGitChange?(listener: () => void): () => void;
}

/** A repository's HEAD and tags, as the change highlight offers them. */
export interface GitRefs {
  /** The commit HEAD names (its SHA); null in a repository with no commits yet. */
  head: string | null;
  /** Newest first. `date` is the tag's (or its commit's) date, ISO 8601. */
  tags: { name: string; commit: string; date: string }[];
}
