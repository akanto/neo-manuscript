import type { TexDocument } from "../../core/document.ts";
import type { ChatEvent, PastChat } from "../../core/chat.ts";
import type { ChatBridge, DocumentState, HostBridge, ProjectBridge, ProjectState } from "../../core/host-api.ts";
import { startView } from "../../view/main.ts";
import type { PageConfig } from "./pages.ts";

declare global {
  interface Window {
    /** What the app's page puts here for the view: see pages.ts. */
    __neoManuscript: PageConfig;
  }
}

const { token, storage: kept } = window.__neoManuscript;

const post = (path: string, body: unknown) => fetch(path, { method: "POST", headers: { "x-token": token, "content-type": "application/json" }, body: JSON.stringify(body) });

/** The view's settings: kept in the page, and sent to the app, which keeps them between runs. */
function appStorage(): Storage {
  const items = new Map(Object.entries(kept));
  const keep = (key: string, value: string | null) => void post("/storage", { key, value });
  return {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem(key, value) {
      items.set(key, String(value));
      keep(key, String(value));
    },
    removeItem(key) {
      items.delete(key);
      keep(key, null);
    },
    clear() {
      for (const key of items.keys()) keep(key, null);
      items.clear();
    },
  };
}

/** What a request the app turned down said, as an error. */
async function sent(response: Promise<Response>): Promise<void> {
  const answer = await response;
  if (!answer.ok) throw new Error((await answer.text()) || `The app answered ${answer.status}`);
}

function projectBridge(events: EventSource): ProjectBridge {
  const listeners = new Set<(state: ProjectState) => void>();
  let latest: ProjectState | null = null;
  events.addEventListener("project", (event) => {
    latest = JSON.parse((event as MessageEvent<string>).data) as ProjectState;
    for (const listener of listeners) listener(latest);
  });
  const act = (action: string, body: { path: string; to?: string }) => sent(post(`/project/${action}`, body));
  return {
    onProject(listener) {
      listeners.add(listener);
      if (latest) listener(latest);
      return () => listeners.delete(listener);
    },
    open: (path) => act("open", { path }),
    applyTo(path, operation) {
      void post("/apply", { file: path, operation });
    },
    createFile: (path) => act("create-file", { path }),
    createFolder: (path) => act("create-folder", { path }),
    rename: (path, to) => act("rename", { path, to }),
    remove: (path) => act("remove", { path }),
    setMain: (path) => act("set-main", { path }),
    async upload(folder, files) {
      for (const file of files) {
        const query = `folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(file.name)}`;
        await sent(fetch(`/upload?${query}`, { method: "POST", headers: { "x-token": token }, body: file }));
      }
    },
  };
}

function chatBridge(events: EventSource): ChatBridge {
  const listeners = new Set<(event: ChatEvent | null) => void>();
  /** The conversation so far, for a listener that comes later. */
  let log: (ChatEvent | null)[] = [];
  const emit = (event: ChatEvent | null) => {
    log = event === null ? [] : [...log, event];
    for (const listener of listeners) listener(event);
  };
  events.addEventListener("chat-reset", () => emit(null));
  events.addEventListener("chat", (event) => emit(JSON.parse((event as MessageEvent<string>).data) as ChatEvent));
  const act = (action: string, body: object = {}) => sent(post(`/chat/${action}`, body));
  return {
    onEvent(listener) {
      listeners.add(listener);
      for (const event of log) listener(event);
      return () => listeners.delete(listener);
    },
    send: (text, images) => act("send", { text, images }),
    cancel: () => void act("cancel"),
    newChat: (agent) => act("new", { agent }),
    async pastChats() {
      const answer = await post("/chat/past", {});
      if (!answer.ok) throw new Error(await answer.text());
      return (await answer.json()) as PastChat[];
    },
    resume: (sessionId) => act("resume", { sessionId }),
    warmUp: () => void act("warm-up"),
    setConfig: (configId, value) => act("config", { configId, value }),
    answerPermission: (id, optionId) => void act("permission", { id, optionId }),
    openLink: (url) => void post("/open-url", { url }),
    signIn: () => act("sign-in"),
    async rewrite(request, signal) {
      const answer = await fetch("/chat/rewrite", { method: "POST", headers: { "x-token": token, "content-type": "application/json" }, body: JSON.stringify(request), signal });
      if (!answer.ok) throw new Error((await answer.text()) || `The app answered ${answer.status}`);
      return answer.text();
    },
  };
}

function desktopBridge(): HostBridge<TexDocument> {
  const listeners = new Set<(state: DocumentState<TexDocument>) => void>();
  let latest: DocumentState<TexDocument> | null = null;
  const events = new EventSource(`/events?t=${token}`);
  // The project's states first: the view wants to know the project before the document of one of its files.
  const project = projectBridge(events);
  const chat = chatBridge(events);
  events.addEventListener("state", (event) => {
    const state = JSON.parse((event as MessageEvent<string>).data) as DocumentState<TexDocument> | null;
    // None while no file is open; the project's state says so.
    if (!state) return;
    latest = state;
    for (const listener of listeners) listener(latest);
  });
  // Another document was opened in the window.
  events.addEventListener("reload", () => location.reload());

  return {
    onState(listener) {
      listeners.add(listener);
      if (latest) listener(latest);
      return () => listeners.delete(listener);
    },
    apply(operation) {
      void post("/apply", { operation });
    },
    async readFile(path) {
      const response = await fetch(`/file?path=${encodeURIComponent(path)}`, { headers: { "x-token": token } });
      if (!response.ok) throw new Error(`${path} not found`);
      return response.blob();
    },
    run(task) {
      void post("/run", { task });
    },
    stopTask() {
      void post("/stop", {});
    },
    storage: appStorage(),
    async engines() {
      const response = await fetch("/engines", { headers: { "x-token": token } });
      return response.ok ? ((await response.json()) as string[]) : [];
    },
    project,
    chat,
  };
}

startView(desktopBridge());
