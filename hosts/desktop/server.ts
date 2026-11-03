import type { AgentId } from "./agents.ts";
import type { ChatImage } from "../../core/chat.ts";
import { ChatSession } from "./chat.ts";
import { installedEngines } from "../../core/compile.ts";
import { pageFor, startPage } from "./pages.ts";
import type { ProjectHost } from "./project-host.ts";

/**
 * The app's window talks to its main process through this server, on 127.0.0.1 and only with the token of this run:
 * the view's operations, files and builds come here, and the open file's states and the project's go back as
 * server-sent events. A browser can open the same page, which is how the view is tested outside the app.
 */
export interface AppServer {
  url: string;
  /** Shows another project (or none) in the window, which then loads the page again. */
  show(project: ProjectHost | null): void;
  stop(): void;
}

export interface AppServerOptions {
  port?: number;
  /** The view's bundle, as built by `bun scripts/build-desktop.ts`. */
  viewCode: () => Promise<string>;
  /** The view's settings, kept by the app between runs. */
  storage: { all(): Record<string, string>; set(key: string, value: string | null): void };
  /** Asks the user for a folder or file to open (the start page's "Open…"); absent where there is no native dialog. */
  chooseProject?: () => void;
  /** Where the agents' ACP sides are, as built by `bun scripts/build-desktop.ts`. */
  agentsFolder: string;
  /** Opens a web link outside the app, in the user's browser. */
  openExternal?: (url: string) => void;
  /** Each project's last conversation with each agent, kept by the app, to take up again when the project opens. */
  chats: { last(folder: string, agent: string): string | null; remember(folder: string, agent: string, sessionId: string): void };
}

const token = () => crypto.getRandomValues(new Uint8Array(24)).reduce((text, byte) => text + byte.toString(16).padStart(2, "0"), "");

export function startServer({ port = 0, viewCode, storage, chooseProject, agentsFolder, openExternal, chats }: AppServerOptions): AppServer {
  const secret = token();
  let project: ProjectHost | null = null;
  /** Each open page's event stream, to tell it to load again when the project changes. */
  const pages = new Set<(event: string, data: unknown) => void>();
  const broadcast = (event: string, data: unknown) => {
    for (const send of pages) send(event, data);
  };

  /**
   * The conversation with the agent about the open project: the last one with that agent, taken up again, or a new one
   * (with another agent, or when asked for), or one of the past.
   */
  let chat: ChatSession | null = null;
  const chatAgent = (): AgentId => (storage.all().agent === "pi" ? "pi" : "claude");
  const startChat = (open: ProjectHost, agent = chatAgent(), resume: string | null = chats.last(open.folder, agent)): ChatSession => {
    chat?.close();
    storage.set("agent", agent);
    const next = new ChatSession(agent, {
      project: open,
      agentsFolder,
      appUrl: `http://127.0.0.1:${server.port}`,
      token: secret,
      resume,
      onSession: (sessionId) => chats.remember(open.folder, agent, sessionId),
    });
    chat = next;
    broadcast("chat-reset", null);
    for (const event of next.all()) broadcast("chat", event);
    next.onEvent((event) => broadcast("chat", event));
    open.outsideAuthor = () => next.author();
    return next;
  };

  const events = () => {
    let stop = () => {};
    const stream = new ReadableStream<string>({
      start(controller) {
        const send = (event: string, data: unknown) => controller.enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        pages.add(send);
        const unsubscribe = [project?.onState((state) => send("state", state)), project?.onProject((state) => send("project", state))];
        if (project) {
          send("project", project.projectState());
          send("state", project.state());
          // A new conversation is told to every page as it starts; one going on is told to this page from its start.
          if (!chat) startChat(project);
          else {
            send("chat-reset", null);
            for (const event of chat.all()) send("chat", event);
          }
        }
        // A comment now and then keeps the stream open through WebKit's idle timeout.
        const keepAlive = setInterval(() => controller.enqueue(": \n\n"), 20_000);
        stop = () => {
          pages.delete(send);
          for (const off of unsubscribe) off?.();
          clearInterval(keepAlive);
        };
      },
      cancel: () => stop(),
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  };

  /** Runs what a request asks of the project; what it throws goes back as a 400 with its message. */
  const attempt = async (work: () => Promise<unknown>) => {
    try {
      const result = await work();
      return new Response(typeof result === "string" ? result : "ok");
    } catch (error) {
      return new Response((error as Error).message, { status: 400 });
    }
  };

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (process.env.NEO_DEBUG) console.log("request", request.method, url.pathname, url.searchParams.get("path") ?? "");
      if ((request.headers.get("x-token") ?? url.searchParams.get("t")) !== secret) return new Response("forbidden", { status: 403 });
      const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      const post = request.method === "POST";

      if (url.pathname === "/") return html(project ? pageFor(secret, project.name, storage.all()) : startPage(secret, Boolean(chooseProject)));
      if (url.pathname === "/view.js") return new Response(await viewCode(), { headers: { "content-type": "text/javascript", "cache-control": "no-store" } });
      if (url.pathname === "/events") return events();
      if (url.pathname === "/open-project" && post) {
        chooseProject?.();
        return new Response("ok");
      }
      if (url.pathname === "/open-url" && post) {
        const { url: link } = (await request.json()) as { url: string };
        if (/^https?:\/\//.test(link)) openExternal?.(link);
        return new Response("ok");
      }
      if (url.pathname === "/engines") return Response.json(installedEngines());
      if (url.pathname === "/storage" && post) {
        const { key, value } = (await request.json()) as { key: string; value: string | null };
        storage.set(key, value);
        return new Response("ok");
      }
      if (!project) return new Response("no project", { status: 409 });
      const open = project;

      if (url.pathname === "/apply" && post) {
        const { file, operation } = (await request.json()) as { file?: string; operation: unknown };
        return attempt(() => open.apply(operation, { kind: "you" }, file));
      }
      if (url.pathname === "/run" && post) {
        // The view follows the build in the states it gets, so its outcome isn't awaited here.
        open.compile({ kind: "you" }).catch(() => {});
        return new Response("ok");
      }
      if (url.pathname === "/stop" && post) {
        open.stopTask();
        return new Response("ok");
      }
      if (url.pathname === "/file") {
        let file;
        try {
          file = Bun.file(open.pathOf(url.searchParams.get("path") ?? ""));
        } catch (error) {
          return new Response((error as Error).message, { status: 403 });
        }
        return (await file.exists()) ? new Response(file, { headers: { "cache-control": "no-store" } }) : new Response("missing", { status: 404 });
      }
      if (url.pathname === "/agent/compile" && post) {
        // For the agent, by curl: the build's summary, or what went wrong, as text.
        try {
          return new Response(`${await open.compileWhenFree({ kind: "agent", conversationId: "", turnSeq: null })}\n`);
        } catch (error) {
          return new Response(`${(error as Error).message}\n`);
        }
      }
      if (post && url.pathname.startsWith("/chat/")) {
        const body = (await request.json()) as { text?: string; images?: ChatImage[]; id?: number; optionId?: string | null; configId?: string; value?: string | boolean; agent?: AgentId; sessionId?: string };
        const action = url.pathname.slice("/chat/".length);
        const agent = body.agent === "pi" || body.agent === "claude" ? body.agent : chatAgent();
        if (action === "new") {
          // Another agent takes up its last conversation; a new chat with the same agent is new.
          startChat(open, agent, agent === chat?.agent ? null : undefined).warmUp();
          return new Response("ok");
        }
        if (action === "resume" && body.sessionId) {
          startChat(open, agent, body.sessionId).warmUp();
          return new Response("ok");
        }
        const current = chat ?? startChat(open);
        if (action === "past") return attempt(async () => JSON.stringify(await current.pastChats()));
        if (action === "send" && (body.text || body.images?.length)) {
          // The answer comes as events; the turn isn't awaited here.
          current.send(body.text ?? "", body.images ?? []).catch(() => {});
          return new Response("ok");
        }
        if (action === "warm-up") current.warmUp();
        if (action === "sign-in") return attempt(() => current.signIn());
        if (action === "cancel") current.cancel();
        if (action === "permission" && typeof body.id === "number") current.answer(body.id, body.optionId ?? null);
        if (action === "config" && body.configId && body.value !== undefined) return attempt(() => current.setConfig(body.configId!, body.value!));
        return new Response("ok");
      }
      if (url.pathname === "/upload" && post) {
        const bytes = new Uint8Array(await request.arrayBuffer());
        return attempt(() => open.upload(url.searchParams.get("folder") ?? "", url.searchParams.get("name") ?? "file", bytes));
      }
      if (post && url.pathname.startsWith("/project/")) {
        const { path, to } = (await request.json()) as { path: string; to?: string };
        const action = url.pathname.slice("/project/".length);
        if (action === "open") return attempt(() => open.openFile(path));
        if (action === "create-file") return attempt(() => open.createFile(path));
        if (action === "create-folder") return attempt(() => open.createFolder(path));
        if (action === "rename") return attempt(() => open.rename(path, to ?? ""));
        if (action === "remove") return attempt(() => open.remove(path));
        if (action === "set-main") return attempt(() => open.setMain(path));
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/?t=${secret}`,
    show(next) {
      chat?.close();
      chat = null;
      project = next;
      broadcast("reload", null);
    },
    stop: () => {
      chat?.close();
      server.stop(true);
    },
  };
}
