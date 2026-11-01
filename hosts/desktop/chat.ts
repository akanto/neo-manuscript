import { client, methods, ndJsonStream, type ClientConnection } from "@agentclientprotocol/sdk";
import type { ContentBlock, RequestPermissionRequest, SessionUpdate, SetSessionConfigOptionRequest } from "@agentclientprotocol/sdk";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { ChatEvent, ChatImage, PastChat } from "../../core/chat.ts";
import type { Author } from "../../core/host-api.ts";
import { isTextFile } from "../../core/project.ts";
import { agentCommand, agents, type AgentId } from "./agents.ts";
import type { ProjectHost } from "./project-host.ts";

export interface ChatOptions {
  project: ProjectHost;
  /** Where the agents' ACP sides are, as built (see agents.ts). */
  agentsFolder: string;
  /** How the agent reaches the app to build the PDF: its server's address and the run's token. */
  appUrl: string;
  token: string;
  /** A conversation of the past to take up again, by its session's id, rather than starting a new one. */
  resume?: string | null;
  /** Called with the session's id once it is known, for taking it up again the next time. */
  onSession?: (sessionId: string) => void;
}

/**
 * The context the first message carries after the user's words (see introduction()), left out when a conversation
 * shows again. It goes after them because agents name a conversation by the start of its first message.
 */
const CONTEXT = /\s*<context>[\s\S]*?(<\/context>\s*$|$)/;

/**
 * A conversation with an agent about the project: the agent's process, its ACP session in the project's folder, and
 * what it said. The agent changes files with its own tools; the app sees them as changes made outside it, and while
 * the agent has its turn, it names the agent as their author. Its reads and writes through ACP (Claude's, when the
 * client offers them) go through the documents open in the app, so it reads what the user sees, typing included.
 */
export class ChatSession {
  private events: ChatEvent[] = [];
  private listeners = new Set<(event: ChatEvent) => void>();
  private process: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private connection: ClientConnection | null = null;
  private sessionId: string | null = null;
  private starting: Promise<void> | null = null;
  private permissions = new Map<number, (optionId: string | null) => void>();
  private nextPermission = 1;
  private turn = 0;
  private working = false;
  private introduced = false;
  private canTakeImages = false;
  private canList = false;
  /** While a conversation of the past loads, the user's messages come back as pieces, made one message here. */
  private loading = false;
  private userPieces: { text: string; images: ChatImage[] } | null = null;
  /** pi-acp sends its startup notes (pi's version, extensions) as the first part of its first answer. */
  private skipStartupNotes: boolean;

  constructor(readonly agent: AgentId, private options: ChatOptions) {
    this.skipStartupNotes = agent === "pi";
    void agents().then((list) => this.emit({ type: "agents", agents: list, current: agent }));
  }

  all(): readonly ChatEvent[] {
    return this.events;
  }

  onEvent(listener: (event: ChatEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ChatEvent) {
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }

  /** Who changes made outside the app are by just now: the agent while it has its turn. */
  author(): Author | null {
    return this.working ? { kind: "agent", conversationId: this.sessionId ?? "", turnSeq: this.turn } : null;
  }

  private start(): Promise<void> {
    this.starting ??= this.connect().catch((error: Error) => {
      this.starting = null;
      this.emit({ type: "status", state: "failed", message: error.message });
      this.close();
      throw error;
    });
    return this.starting;
  }

  private async connect() {
    this.emit({ type: "status", state: "starting" });
    const { project, agentsFolder, appUrl, token } = this.options;
    const { command, env } = await agentCommand(this.agent, agentsFolder, { NEO_MANUSCRIPT_URL: appUrl, NEO_MANUSCRIPT_TOKEN: token });
    const child = Bun.spawn(command, { cwd: project.folder, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.process = child;
    let stderr = "";
    void (async () => {
      for await (const chunk of child.stderr) stderr = (stderr + new TextDecoder().decode(chunk)).slice(-4000);
    })();
    void child.exited.then((code) => {
      if (this.process !== child) return;
      this.process = null;
      this.connection = null;
      this.sessionId = null;
      this.starting = null;
      this.working = false;
      const said = stderr.trim().split("\n").slice(-4).join("\n");
      this.emit({ type: "status", state: "closed", message: `The agent stopped (${code})${said ? `: ${said}` : ""}` });
    });

    const input = new WritableStream<Uint8Array>({
      write(chunk) {
        child.stdin.write(chunk);
        child.stdin.flush();
      },
    });
    const app = client({ name: "neo-manuscript" })
      .onNotification(methods.client.session.update, ({ params }) => {
        if (params.sessionId === this.sessionId || this.loading) this.updated(params.update);
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) => this.askPermission(params))
      .onRequest(methods.client.fs.readTextFile, ({ params }) => this.readTextFile(params.path, params.line ?? null, params.limit ?? null))
      .onRequest(methods.client.fs.writeTextFile, async ({ params }) => {
        await this.writeTextFile(params.path, params.content);
        return {};
      });
    const connection = app.connect(ndJsonStream(input, child.stdout));
    this.connection = connection;
    const initialized = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientInfo: { name: "neo-manuscript", title: "NeoManuscript", version: "0.1.0" },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    });
    const capabilities = initialized.agentCapabilities;
    this.canTakeImages = capabilities?.promptCapabilities?.image === true;
    this.canList = Boolean(capabilities?.sessionCapabilities?.list);
    const resume = this.options.resume;
    if (resume && capabilities?.loadSession) {
      try {
        this.loading = true;
        this.sessionId = resume;
        const loaded = await connection.agent.request(methods.agent.session.load, { sessionId: resume, cwd: project.folder, mcpServers: [] });
        this.flushUser();
        this.introduced = true;
        if (loaded.configOptions) this.emit({ type: "config", options: loaded.configOptions });
        this.emit({ type: "status", state: "ready" });
        return;
      } catch {
        // The conversation is gone (or the agent can't find it): a new one starts.
        this.sessionId = null;
        this.flushUser();
      } finally {
        this.loading = false;
      }
    }
    const session = await connection.agent.request(methods.agent.session.new, { cwd: project.folder, mcpServers: [] });
    this.sessionId = session.sessionId;
    this.options.onSession?.(session.sessionId);
    if (session.configOptions) this.emit({ type: "config", options: session.configOptions });
    this.emit({ type: "status", state: "ready" });
  }

  /** The user's message of a conversation that loads, once its pieces are all in. */
  private flushUser() {
    const pieces = this.userPieces;
    this.userPieces = null;
    if (pieces) this.emit({ type: "user", text: pieces.text.replace(CONTEXT, ""), ...(pieces.images.length > 0 && { images: pieces.images }) });
  }

  /** The agent's earlier conversations in the project's folder, the latest first; none when it can't list them. */
  async pastChats(): Promise<PastChat[]> {
    await this.start();
    if (!this.connection || !this.canList) return [];
    const listed = await this.connection.agent.request(methods.agent.session.list, { cwd: this.options.project.folder });
    return listed.sessions
      .filter((session) => session.sessionId !== this.sessionId)
      .map((session) => ({ sessionId: session.sessionId, title: session.title?.replace(CONTEXT, "") || null, updatedAt: session.updatedAt ?? null }))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  private updated(update: SessionUpdate) {
    // A loading conversation's user messages; while it goes on, the app shows the user's own as they are sent.
    if (update.sessionUpdate === "user_message_chunk") {
      if (!this.loading) return;
      this.userPieces ??= { text: "", images: [] };
      if (update.content.type === "text") this.userPieces.text += update.content.text;
      if (update.content.type === "image") this.userPieces.images.push({ mimeType: update.content.mimeType, data: update.content.data });
      return;
    }
    this.flushUser();
    if (this.skipStartupNotes && update.sessionUpdate === "agent_message_chunk") {
      this.skipStartupNotes = false;
      if (update.content.type === "text" && /^pi v\d/.test(update.content.text)) return;
    }
    if (update.sessionUpdate === "config_option_update") this.emit({ type: "config", options: update.configOptions });
    this.emit({ type: "update", update });
  }

  /** Sends the user's message; resolves when the agent's turn ends. */
  async send(text: string, images: ChatImage[] = []) {
    await this.start();
    if (!this.connection || !this.sessionId) throw new Error("The agent isn't running");
    if (images.length > 0 && !this.canTakeImages) throw new Error("This agent doesn't take images");
    this.emit({ type: "user", text, ...(images.length > 0 && { images }) });
    const prompt = this.introduced ? text : `${text}\n\n${this.introduction()}`;
    this.introduced = true;
    this.working = true;
    this.turn++;
    this.emit({ type: "status", state: "working" });
    try {
      const blocks: ContentBlock[] = [{ type: "text", text: prompt }, ...images.map((image): ContentBlock => ({ type: "image", ...image }))];
      const result = await this.connection.agent.request(methods.agent.session.prompt, { sessionId: this.sessionId, prompt: blocks });
      this.emit({ type: "turn-end", stopReason: result.stopReason });
    } catch (error) {
      this.emit({ type: "turn-end", stopReason: `error: ${(error as Error).message}` });
    } finally {
      this.working = false;
      if (this.connection) this.emit({ type: "status", state: "ready" });
    }
  }

  /** What the agent is told first: where it is, and how to build the PDF the user sees. */
  private introduction(): string {
    const { project } = this.options;
    const state = project.projectState();
    const build = 'curl -s -X POST "$NEO_MANUSCRIPT_URL/agent/compile" -H "x-token: $NEO_MANUSCRIPT_TOKEN"';
    return [
      "<context>",
      "You are helping the user write a LaTeX document in NeoManuscript, an editor that shows the source and the typeset PDF side by side.",
      `The project is the folder ${project.folder} (your working folder). Its main file, the one the build compiles, is ${state.main ?? "not there yet: no .tex file at the top of the folder has a \\documentclass"}.`,
      state.open ? `The user has ${state.open} open in the editor.` : "",
      "Change the project's files with your own tools; the user sees each change in the editor at once, so keep changes to what was asked.",
      `To build the PDF and see LaTeX's errors and warnings, run \`${build}\`: the app builds the main file into .latex-build/ and shows the new PDF to the user. Don't run LaTeX yourself.`,
      "</context>",
    ].filter(Boolean).join("\n");
  }

  cancel() {
    if (this.connection && this.sessionId) void this.connection.agent.notify(methods.agent.session.cancel, { sessionId: this.sessionId });
    for (const answer of this.permissions.values()) answer(null);
  }

  async setConfig(configId: string, value: string | boolean) {
    await this.start();
    if (!this.connection || !this.sessionId) return;
    const params: SetSessionConfigOptionRequest = typeof value === "boolean" ? { sessionId: this.sessionId, configId, type: "boolean", value } : { sessionId: this.sessionId, configId, value };
    const response = await this.connection.agent.request(methods.agent.session.setConfigOption, params);
    this.emit({ type: "config", options: response.configOptions });
  }

  /** Starts the agent before the first message, so the user can choose its model meanwhile. */
  warmUp() {
    void this.start().catch(() => {});
  }

  private askPermission(request: RequestPermissionRequest) {
    const id = this.nextPermission++;
    this.emit({ type: "permission", id, request });
    return new Promise<{ outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } }>((resolve) => {
      this.permissions.set(id, (optionId) => {
        this.permissions.delete(id);
        this.emit({ type: "permission-answered", id, optionId });
        resolve({ outcome: optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId } });
      });
    });
  }

  answer(id: number, optionId: string | null) {
    this.permissions.get(id)?.(optionId);
  }

  /** A path the agent gives, as a text file of the project, if it is one. */
  private projectFile(path: string): string | null {
    const { project } = this.options;
    const inside = relative(project.folder, path);
    if (!isAbsolute(path) || inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
    const projectPath = inside.split(sep).join("/");
    return isTextFile(projectPath) ? projectPath : null;
  }

  private async readTextFile(path: string, line: number | null, limit: number | null) {
    const inProject = this.projectFile(path);
    const text = inProject ? (await this.options.project.document(inProject)).current().text : await readFile(path, "utf8");
    if (line === null && limit === null) return { content: text };
    const lines = text.split("\n");
    const from = Math.max(0, (line ?? 1) - 1);
    return { content: lines.slice(from, limit === null ? undefined : from + limit).join("\n") };
  }

  private async writeTextFile(path: string, content: string) {
    const inProject = this.projectFile(path);
    if (!inProject) return writeFile(path, content);
    const { project } = this.options;
    // A new file is made first, so the change to it is one the editor can show.
    if (!project.has(inProject)) await project.createFile(inProject, { open: false });
    await project.apply({ op: "set_text", text: content }, this.author() ?? { kind: "agent", conversationId: this.sessionId ?? "", turnSeq: this.turn }, inProject);
  }

  close() {
    for (const answer of this.permissions.values()) answer(null);
    this.connection?.close();
    this.connection = null;
    const child = this.process;
    this.process = null;
    child?.kill();
    this.listeners.clear();
  }
}
