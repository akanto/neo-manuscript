import type { SessionConfigOption, SessionUpdate, ToolCallContent, ToolCallStatus } from "@agentclientprotocol/sdk";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { ChatEvent, ChatImage } from "../core/chat.ts";
import type { ChatBridge } from "../core/host-api.ts";

export interface ChatOptions {
  chat: ChatBridge;
  /** Opens a link of the agent's answer outside the app. */
  openLink(url: string): void;
}

const STATUS_LABEL: Record<ToolCallStatus, string> = { pending: "…", in_progress: "…", completed: "✓", failed: "✕" };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** Markdown as HTML that can't run anything: the agent's text is the agent's, not the app's. */
function markdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: false }) as string, { FORBID_TAGS: ["style", "form", "input"], FORBID_ATTR: ["style"] });
}

/**
 * The chat with the agent, at the side of the view: what the user and the agent said, the agent's thinking and its
 * tool calls as they go, its questions for permission, and the agent and model to talk to.
 */
export class ChatPanel {
  readonly element = el("aside", "chat");
  private agentSelect = el("select", "chat-agent");
  private configRow = el("div", "chat-config");
  private log = el("div", "chat-log");
  private input = el("textarea", "chat-input");
  private sendButton = el("button", "chat-send", "Send");
  private statusLine = el("div", "chat-status");
  private working = false;
  /** The block the agent is writing into now, and its text so far; a tool call or a message of the user ends it. */
  private current: { kind: "message" | "thought"; node: HTMLElement; text: string } | null = null;
  private tools = new Map<string, HTMLElement>();
  private permissions = new Map<number, HTMLElement>();
  private renderPending = false;
  private stickToBottom = true;
  /** Images pasted or dropped in, to go with the next message. */
  private attachments: ChatImage[] = [];
  private attachmentRow = el("div", "chat-attachments");
  private historyMenu: HTMLElement | null = null;

  constructor(private options: ChatOptions) {
    const header = el("header", "chat-header");
    const newChat = el("button", "", "New chat");
    newChat.type = "button";
    newChat.title = "Start a new conversation";
    newChat.addEventListener("click", () => void options.chat.newChat(this.agentSelect.value));
    this.agentSelect.title = "The agent to talk to";
    this.agentSelect.addEventListener("change", () => void options.chat.newChat(this.agentSelect.value));
    const history = el("button", "", "History");
    history.type = "button";
    history.title = "Take up an earlier conversation about this project";
    history.addEventListener("click", () => void this.showHistory(history));
    header.append(el("span", "chat-title", "Chat"), this.agentSelect, history, newChat);

    const composer = el("form", "chat-composer");
    this.input.placeholder = "Ask the agent… (↵ sends, ⇧↵ for a new line)";
    this.input.rows = 3;
    this.sendButton.type = "submit";
    const column = el("div", "chat-compose-column");
    column.append(this.attachmentRow, this.input);
    composer.append(column, this.sendButton);
    this.input.addEventListener("paste", (event) => {
      const images = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
      if (images.length === 0) return;
      event.preventDefault();
      void this.attach(images);
    });
    composer.addEventListener("dragover", (event) => {
      if (![...(event.dataTransfer?.items ?? [])].some((item) => item.type.startsWith("image/"))) return;
      event.preventDefault();
      composer.classList.add("drop");
    });
    composer.addEventListener("dragleave", () => composer.classList.remove("drop"));
    composer.addEventListener("drop", (event) => {
      composer.classList.remove("drop");
      const images = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith("image/"));
      if (images.length === 0) return;
      event.preventDefault();
      void this.attach(images);
    });
    composer.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.working) return options.chat.cancel();
      this.submit();
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (!this.working) this.submit();
      }
    });
    document.addEventListener("pointerdown", (event) => {
      if (this.historyMenu && !this.historyMenu.contains(event.target as Node)) this.closeHistory();
    });
    this.log.addEventListener("scroll", () => {
      this.stickToBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 40;
    });
    this.log.addEventListener("click", (event) => {
      const link = (event.target as HTMLElement).closest("a");
      if (!link) return;
      event.preventDefault();
      if (/^https?:/.test(link.href)) options.openLink(link.href);
    });
    this.element.append(header, this.configRow, this.log, this.statusLine, composer);
    options.chat.onEvent((event) => (event ? this.handle(event) : this.reset()));
  }

  focus() {
    this.input.focus();
  }

  /** The chat came into sight: the agent starts, and a conversation taken up again shows. */
  shown() {
    this.options.chat.warmUp();
  }

  /** Images to go with the next message, as ACP takes them: their bytes in base64. */
  private async attach(files: File[]) {
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      this.attachments.push({ mimeType: file.type, data: btoa(binary) });
    }
    this.showAttachments();
    this.input.focus();
  }

  private showAttachments() {
    this.attachmentRow.replaceChildren(
      ...this.attachments.map((image, index) => {
        const item = el("span", "chat-attachment");
        const thumb = el("img");
        thumb.src = `data:${image.mimeType};base64,${image.data}`;
        const remove = el("button", "", "×");
        remove.type = "button";
        remove.title = "Leave this image out";
        remove.addEventListener("click", () => {
          this.attachments.splice(index, 1);
          this.showAttachments();
        });
        item.append(thumb, remove);
        return item;
      }),
    );
  }

  private async showHistory(anchor: HTMLElement) {
    if (this.historyMenu) return this.closeHistory();
    const menu = el("div", "chat-history");
    menu.append(el("div", "chat-muted", "Looking for earlier conversations…"));
    const rect = anchor.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.right = `${innerWidth - rect.right}px`;
    document.body.append(menu);
    this.historyMenu = menu;
    try {
      const past = await this.options.chat.pastChats();
      if (this.historyMenu !== menu) return;
      menu.replaceChildren();
      if (past.length === 0) menu.append(el("div", "chat-muted", "No earlier conversations with this agent here."));
      for (const chat of past.slice(0, 30)) {
        const item = el("button", "chat-history-item");
        item.type = "button";
        const when = chat.updatedAt ? new Date(chat.updatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
        item.append(el("span", "", chat.title?.trim() || "Untitled conversation"), el("span", "chat-muted", when));
        item.addEventListener("click", () => {
          this.closeHistory();
          void this.options.chat.resume(chat.sessionId);
        });
        menu.append(item);
      }
    } catch (error) {
      menu.replaceChildren(el("div", "chat-note error", (error as Error).message));
    }
  }

  private closeHistory() {
    this.historyMenu?.remove();
    this.historyMenu = null;
  }

  /** Sends a message as if the user typed it: Ask in the editor, Ask the agent in the synonyms. */
  send(text: string): Promise<void> {
    return this.options.chat.send(text);
  }

  private submit() {
    const text = this.input.value.trim();
    const images = this.attachments;
    if (!text && images.length === 0) return;
    this.input.value = "";
    this.attachments = [];
    this.showAttachments();
    this.stickToBottom = true;
    void this.options.chat.send(text, images).catch((error: Error) => this.note(`The message didn't go: ${error.message}`, "error"));
  }

  private reset() {
    this.log.replaceChildren();
    this.current = null;
    this.tools.clear();
    this.permissions.clear();
    this.configRow.replaceChildren();
    this.setWorking(false);
    this.statusLine.textContent = "";
  }

  private handle(event: ChatEvent) {
    switch (event.type) {
      case "agents": {
        this.agentSelect.replaceChildren(
          ...event.agents.map((agent) => {
            const option = el("option", "", agent.missing ? `${agent.label} (not installed)` : agent.label);
            option.value = agent.id;
            option.disabled = agent.missing !== null;
            option.title = agent.missing ?? "";
            return option;
          }),
        );
        this.agentSelect.value = event.current;
        const missing = event.agents.find((agent) => agent.id === event.current)?.missing;
        if (missing) this.note(missing, "error");
        break;
      }
      case "status":
        if (event.state === "starting") this.statusLine.textContent = "Starting the agent…";
        if (event.state === "ready") this.statusLine.textContent = "";
        if (event.state === "working") this.statusLine.textContent = "Working…";
        this.setWorking(event.state === "working");
        if ((event.state === "failed" || event.state === "closed") && event.message) {
          this.statusLine.textContent = "";
          this.note(event.message, "error");
        }
        break;
      case "config":
        this.showConfig(event.options);
        break;
      case "user": {
        this.endBlock();
        const message = el("div", "chat-user", event.text);
        for (const image of event.images ?? []) {
          const picture = el("img");
          picture.src = `data:${image.mimeType};base64,${image.data}`;
          message.append(picture);
        }
        this.append(message);
        break;
      }
      case "update":
        this.update(event.update);
        break;
      case "permission":
        this.askPermission(event.id, event.request);
        break;
      case "permission-answered": {
        const card = this.permissions.get(event.id);
        if (!card) break;
        for (const button of card.querySelectorAll("button")) {
          button.disabled = true;
          button.classList.toggle("chosen", button.dataset.option === event.optionId);
        }
        if (event.optionId === null) card.append(el("span", "chat-muted", " Not answered"));
        break;
      }
      case "turn-end":
        this.endBlock();
        if (event.stopReason === "cancelled") this.note("Stopped.");
        else if (event.stopReason === "refusal") this.note("The agent declined to go on.");
        else if (event.stopReason === "max_tokens" || event.stopReason === "max_turn_requests") this.note(`The agent stopped: ${event.stopReason.replace(/_/g, " ")}.`);
        else if (event.stopReason.startsWith("error: ")) this.note(event.stopReason.slice(7), "error");
        break;
    }
  }

  private update(update: SessionUpdate) {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        if (update.content.type !== "text") return;
        const kind = update.sessionUpdate === "agent_message_chunk" ? "message" : "thought";
        if (this.current?.kind !== kind) {
          this.endBlock();
          const node = kind === "message" ? el("div", "chat-agent-text") : el("details", "chat-thought");
          if (kind === "thought") node.append(el("summary", "", "Thinking"), el("div", "chat-thought-text"));
          this.append(node);
          this.current = { kind, node, text: "" };
        }
        this.current.text += update.content.text;
        this.scheduleRender();
        return;
      }
      case "tool_call": {
        this.endBlock();
        const card = el("details", "chat-tool");
        card.append(el("summary"), el("div", "chat-tool-body"));
        this.tools.set(update.toolCallId, card);
        this.fillTool(card, update.title, update.status ?? "pending", update.content ?? []);
        this.append(card);
        return;
      }
      case "tool_call_update": {
        const card = this.tools.get(update.toolCallId);
        if (!card) return;
        this.fillTool(card, update.title ?? null, update.status ?? null, update.content ?? null);
        return;
      }
      case "plan": {
        this.endBlock();
        const list = el("ol", "chat-plan");
        for (const entry of update.entries) list.append(el("li", `plan-${entry.status}`, entry.content));
        const last = this.log.lastElementChild;
        if (last?.classList.contains("chat-plan")) last.replaceWith(list);
        else this.append(list);
        return;
      }
      default:
        return;
    }
  }

  private fillTool(card: HTMLElement, title: string | null, status: ToolCallStatus | null, content: ToolCallContent[] | null) {
    const summary = card.querySelector("summary")!;
    if (title !== null) card.dataset.title = title;
    if (status !== null) card.dataset.status = status;
    summary.replaceChildren(el("span", `chat-tool-status ${card.dataset.status}`, STATUS_LABEL[(card.dataset.status ?? "pending") as ToolCallStatus]), el("span", "chat-tool-title", card.dataset.title ?? "Tool"));
    if (content === null) return;
    const body = card.querySelector(".chat-tool-body")!;
    body.replaceChildren();
    for (const item of content) {
      if (item.type === "diff") {
        const before = (item.oldText ?? "").split("\n").length;
        const after = item.newText.split("\n").length;
        body.append(el("div", "chat-diff", `${item.path.split("/").pop()}: ${after >= before ? "+" : ""}${after - before} lines`));
      } else if (item.type === "content" && item.content.type === "text") {
        body.append(el("pre", "", item.content.text.length > 4000 ? `${item.content.text.slice(0, 4000)}\n…` : item.content.text));
      }
    }
  }

  private askPermission(id: number, request: { toolCall: { title?: string | null }; options: { optionId: string; name: string; kind: string }[] }) {
    this.endBlock();
    const card = el("div", "chat-permission");
    card.append(el("div", "", `Allow: ${request.toolCall.title ?? "this"}?`));
    const buttons = el("div", "chat-permission-buttons");
    for (const option of request.options) {
      const button = el("button", option.kind.startsWith("reject") ? "reject" : "allow", option.name);
      button.type = "button";
      button.dataset.option = option.optionId;
      button.addEventListener("click", () => this.options.chat.answerPermission(id, option.optionId));
      buttons.append(button);
    }
    card.append(buttons);
    this.permissions.set(id, card);
    this.append(card);
  }

  private showConfig(options: SessionConfigOption[]) {
    this.configRow.replaceChildren();
    for (const option of options) {
      const label = el("label", "chat-option");
      label.title = option.description ?? option.name;
      if (option.type === "select") {
        const select = el("select");
        for (const entry of option.options) {
          if ("group" in entry) {
            const group = el("optgroup");
            group.label = entry.name;
            for (const choice of entry.options) group.append(this.choice(choice.value, choice.name));
            select.append(group);
          } else select.append(this.choice(entry.value, entry.name));
        }
        select.value = option.currentValue;
        select.addEventListener("change", () => void this.options.chat.setConfig(option.id, select.value).catch((error: Error) => this.note(error.message, "error")));
        label.append(el("span", "", option.name), select);
      } else if (option.type === "boolean") {
        const box = el("input");
        box.type = "checkbox";
        box.checked = option.currentValue;
        box.addEventListener("change", () => void this.options.chat.setConfig(option.id, box.checked).catch((error: Error) => this.note(error.message, "error")));
        label.append(box, el("span", "", option.name));
      } else continue;
      this.configRow.append(label);
    }
  }

  private choice(value: string, name: string) {
    const option = el("option", "", name);
    option.value = value;
    return option;
  }

  private setWorking(working: boolean) {
    this.working = working;
    this.sendButton.textContent = working ? "Stop" : "Send";
    this.sendButton.classList.toggle("stop", working);
  }

  private note(text: string, kind: "info" | "error" = "info") {
    this.endBlock();
    this.append(el("div", `chat-note ${kind}`, text));
  }

  private append(node: HTMLElement) {
    this.log.append(node);
    this.scrollDown();
  }

  /** The agent's text is drawn once a frame, however many pieces of it came. */
  private scheduleRender() {
    if (this.renderPending) return;
    this.renderPending = true;
    requestAnimationFrame(() => {
      this.renderPending = false;
      if (this.current) this.render(this.current);
    });
  }

  private render(block: NonNullable<ChatPanel["current"]>) {
    if (block.kind === "message") block.node.innerHTML = markdown(block.text);
    else block.node.querySelector(".chat-thought-text")!.textContent = block.text;
    this.scrollDown();
  }

  /** The block the agent was writing ends: it is drawn with all its text now. */
  private endBlock() {
    if (this.current) this.render(this.current);
    this.current = null;
  }

  private scrollDown() {
    if (this.stickToBottom) this.log.scrollTop = this.log.scrollHeight;
  }
}
