/**
 * A stand-in for Mirador around the view, to run it in a browser: the page gets a `window.mirador` whose operations,
 * files and tasks go to this server, which runs the plugin's real host code on a .tex file in a folder of its own.
 * `bun e2e/harness.ts <file.tex>` serves it on http://127.0.0.1:4810.
 */
import { mkdtemp, readdir, readFile, writeFile, cp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, normalize, relative } from "node:path";
import type { Author, Change, DocumentState, TaskState } from "../core/host-api.ts";
import type { TexDocument } from "../core/document.ts";
import host from "../hosts/mirador/host.ts";

export interface Harness {
  url: string;
  folder: string;
  file: string;
  /** Applies an operation as the agent would. */
  agentApply(operation: unknown): Promise<void>;
  text(): Promise<string>;
  stop(): void;
}

const BRIDGE = `
(() => {
  const listeners = new Set();
  let latest;
  const items = new Map();
  const storage = {
    get length() { return items.size; },
    key: (i) => [...items.keys()][i] ?? null,
    getItem: (k) => items.has(k) ? items.get(k) : null,
    setItem: (k, v) => { items.set(k, String(v)); },
    removeItem: (k) => { items.delete(k); },
    clear: () => items.clear(),
  };
  const fileListeners = new Set();
  const emit = (state) => {
    const filesChanged = latest !== undefined && latest.filesChange !== state.filesChange;
    latest = state;
    listeners.forEach((l) => l(state));
    if (filesChanged) fileListeners.forEach((l) => l());
  };
  const answered = (r) => r.ok ? r : r.text().then((message) => Promise.reject(new Error(message)));
  const poll = async () => {
    let seen = -1;
    for (;;) {
      const response = await fetch("/state?after=" + seen).catch(() => null);
      if (!response) { await new Promise((r) => setTimeout(r, 500)); continue; }
      const { version, state } = await response.json();
      seen = version;
      emit(state);
    }
  };
  window.__prompts = [];
  window.mirador = {
    onState(listener) { listeners.add(listener); if (latest) listener(latest); return () => listeners.delete(listener); },
    apply(op) { fetch("/apply", { method: "POST", body: JSON.stringify({ op, author: { kind: "you" } }) }); },
    prompt(text) { window.__prompts.push(text); return Promise.resolve(); },
    readFile(path) { return fetch("/file?path=" + encodeURIComponent(path)).then((r) => r.ok ? r.blob() : Promise.reject(new Error(path + " not found"))); },
    listFiles() { return fetch("/files").then(answered).then((r) => r.json()); },
    open(file) { return fetch("/open?file=" + encodeURIComponent(file), { method: "POST" }).then(answered).then(() => undefined); },
    onFiles(listener) { fileListeners.add(listener); return () => fileListeners.delete(listener); },
    run(task) { fetch("/run", { method: "POST", body: JSON.stringify({ task }) }); },
    stopTask() {},
    storage,
  };
  poll();
})();`;

/**
 * Mirador's own canvas code, where Mirador is installed: with it, the view runs in a frame exactly as Mirador makes it.
 * MIRADOR_CANVAS names the file when Mirador is somewhere else than ~/Applications.
 */
export const MIRADOR_CANVAS = process.env.MIRADOR_CANVAS ?? join(homedir(), "Applications/Mirador.app/Contents/Resources/app/mirador/shared/canvas-document.ts");

/** The parts of Mirador's canvas-document.ts the harness uses (typed here, so typechecking doesn't read Mirador's code). */
interface MiradorCanvas {
  CANVAS_SHELL_PAGE: string;
  canvasShellPolicy(assetsOrigins: string[]): string;
  appViewPage(viewUrl: string, frameId: string, storage: Record<string, string>): string;
  buildCanvasDocument(html: string, itemId: string, assetsOrigin: string, theme: "light" | "dark"): string;
}

/**
 * The page that frames the view as Mirador's panel does: a sandboxed frame from another origin (the "assets"), with
 * Mirador's shell, Content-Security-Policy, error reporter and `window.mirador` bridge, talking to this page by
 * messages, which this page relays to the server. The frame's errors are kept in `window.__frameErrors`.
 */
function miradorParentPage(canvas: MiradorCanvas, assets: string) {
  const frameId = "app:test/neo-manuscript";
  const page = canvas.buildCanvasDocument(canvas.appViewPage(`${assets}/view.js`, frameId, {}), frameId, assets, "light");
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style>
<iframe sandbox="allow-scripts" src="${assets}/canvas-shell.html"></iframe>
<script>
  const frame = document.querySelector("iframe");
  const page = ${JSON.stringify(page).replace(/</g, "\\u003c")};
  const post = (message, transfer) => frame.contentWindow.postMessage(message, "*", transfer);
  window.__frameErrors = [];
  window.__prompts = [];
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    let seen = -1;
    for (;;) {
      const { version, state } = await (await fetch("/state?after=" + seen)).json();
      seen = version;
      post({ source: "mirador-canvas", kind: "app-state", state });
    }
  };
  addEventListener("message", async (event) => {
    if (event.source !== frame.contentWindow) return;
    const m = event.data;
    if (!m || m.source !== "mirador-canvas") return;
    if (m.kind === "shell-ready") post({ source: "mirador-canvas", kind: "page", document: page });
    if (m.kind === "error") { window.__frameErrors.push(m.message); console.log("FRAME ERROR: " + m.message); }
    if (m.kind === "app-ready") poll();
    if (m.kind === "app-apply") fetch("/apply", { method: "POST", body: JSON.stringify({ op: m.op, author: { kind: "you" } }) });
    if (m.kind === "app-run") fetch("/run", { method: "POST", body: JSON.stringify({ task: m.task }) });
    if (m.kind === "app-prompt") { window.__prompts.push(m.text); post({ source: "mirador-canvas", kind: "app-answer", requestId: m.requestId, value: null }); }
    const answer = (value) => post({ source: "mirador-canvas", kind: "app-answer", requestId: m.requestId, value });
    const refuse = (message) => post({ source: "mirador-canvas", kind: "app-answer-failed", requestId: m.requestId, message });
    if (m.kind === "app-list-files") fetch("/files").then((r) => r.json()).then(answer);
    if (m.kind === "app-open") fetch("/open?file=" + encodeURIComponent(m.file), { method: "POST" }).then(async (r) => (r.ok ? answer(null) : refuse(await r.text())));
    if (m.kind === "app-read-file") {
      const response = await fetch("/file?path=" + encodeURIComponent(m.path));
      if (!response.ok) post({ source: "mirador-canvas", kind: "app-file-failed", requestId: m.requestId, message: m.path + " not found" });
      else {
        const bytes = await response.arrayBuffer();
        post({ source: "mirador-canvas", kind: "app-file", requestId: m.requestId, bytes, type: response.headers.get("content-type") || "" }, [bytes]);
      }
    }
  });
</script>`;
}

export interface HarnessOptions {
  port?: number;
  /** Frame the view as Mirador does (needs Mirador installed); otherwise the page is the view, with a simpler bridge. */
  mirador?: boolean;
}

export async function startHarness(source: string, { port = 0, mirador = false }: HarnessOptions = {}): Promise<Harness> {
  const canvas = mirador ? ((await import(MIRADOR_CANVAS)) as MiradorCanvas) : null;
  const folder = await mkdtemp(join(tmpdir(), "manuscript-harness-"));
  /** The open document's file, as Mirador's API 6 names it: from the workspace, which is the folder. */
  let file = join(folder, basename(source));
  await cp(source, file);
  for (const extra of ["figure.png", "figure.pdf"]) await cp(join(dirname(source), extra), join(folder, extra)).catch(() => {});

  let document: TexDocument = host.parse(await readFile(file, "utf8"));
  let lastChange: Change | null = null;
  let task: TaskState | null = null;
  let version = 0;
  let seq = 0;
  let waiting: (() => void)[] = [];
  const view = await readFile(join(import.meta.dir, "..", "dist", "view.js"), "utf8");

  /** Moves when the folder's files may have changed: after a task and an open, as in Mirador. */
  let filesChange = 0;
  const state = (): DocumentState<TexDocument> & { filesChange: number } => ({ workspaceId: "test", app: "neo-manuscript", file: relative(folder, file), filesChange, document, lastChange, problem: null, task });
  const changed = () => {
    version++;
    waiting.forEach((wake) => wake());
    waiting = [];
  };
  const apply = async (operation: unknown, author: Author) => {
    const applied = host.apply(document, operation, author);
    document = applied.document;
    lastChange = { seq: ++seq, author, summary: applied.summary, touched: applied.touched ?? [], at: Date.now() };
    await writeFile(file, host.serialize(document));
    changed();
  };
  let runId = 0;
  const runTask = async (name: string) => {
    const started = Date.now();
    task = { name, title: name, runId: ++runId, state: "running", author: { kind: "you" }, done: null, text: null, summary: null, problem: null, startedAt: started, endedAt: null };
    changed();
    try {
      const summary = await host.tasks![name]!.run({
        document,
        file: (path) => join(dirname(file), path),
        documentFolder: dirname(file),
        workspaceFolder: folder,
        pluginFolder: join(import.meta.dir, ".."),
        author: { kind: "you" },
        apply: () => Promise.reject(new Error("not here")),
        progress: (_done, text) => {
          if (task) task = { ...task, text: text ?? null };
          changed();
        },
        signal: new AbortController().signal,
      });
      task = { ...task!, state: "done", summary, endedAt: Date.now() };
    } catch (error) {
      task = { ...task!, state: "failed", problem: (error as Error).message, endedAt: Date.now() };
    }
    filesChange++;
    changed();
  };

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      const assets: string = `http://localhost:${server.port}`;
      if (url.pathname === "/" && canvas) return new Response(miradorParentPage(canvas, assets), { headers: { "content-type": "text/html" } });
      if (url.pathname === "/canvas-shell.html" && canvas) {
        return new Response(canvas.CANVAS_SHELL_PAGE, { headers: { "content-type": "text/html", "content-security-policy": canvas.canvasShellPolicy([assets]), "access-control-allow-origin": "*" } });
      }
      if (url.pathname === "/") return new Response(`<!doctype html><meta charset="utf-8"><script>${BRIDGE}</script><script type="module" src="/view.js"></script>`, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/view.js") return new Response(view, { headers: { "content-type": "text/javascript", "access-control-allow-origin": "*" } });
      if (url.pathname === "/state") {
        const after = Number(url.searchParams.get("after"));
        if (after >= version) await new Promise<void>((wake) => waiting.push(wake));
        return Response.json({ version, state: state() });
      }
      if (url.pathname === "/apply") {
        const { op, author } = (await request.json()) as { op: unknown; author: Author };
        try {
          await apply(op, author);
          return new Response("ok");
        } catch (error) {
          console.error("apply failed:", (error as Error).message);
          return new Response((error as Error).message, { status: 400 });
        }
      }
      if (url.pathname === "/run") {
        const { task: name } = (await request.json()) as { task: string };
        if (task?.state !== "running") void runTask(name);
        return new Response("ok");
      }
      if (url.pathname === "/file") {
        // Named from the document's folder; "../" leads up to the workspace, not out of it.
        const path = relative(folder, join(dirname(file), url.searchParams.get("path") ?? ""));
        if (path.startsWith("..")) return new Response("outside", { status: 403 });
        const target = Bun.file(join(folder, path));
        return (await target.exists()) ? new Response(target) : new Response("missing", { status: 404 });
      }
      if (url.pathname === "/files") {
        const files = (await readdir(folder, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => relative(folder, join(entry.parentPath, entry.name)));
        return Response.json({ files: files.filter((path) => !path.startsWith(".latex-build")).sort(), truncated: false });
      }
      if (url.pathname === "/open" && request.method === "POST") {
        const path = normalize(url.searchParams.get("file") ?? "");
        if (path.startsWith("..") || !(await Bun.file(join(folder, path)).exists())) return new Response(`${path} isn't a file of the workspace.`, { status: 400 });
        if (task?.state === "running") return new Response("A task is running.", { status: 409 });
        file = join(folder, path);
        document = host.parse(await readFile(file, "utf8"));
        lastChange = null;
        filesChange++;
        changed();
        return new Response("ok");
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/`,
    folder,
    file,
    agentApply: (operation) => apply(operation, { kind: "agent", conversationId: "c", turnSeq: 1 }),
    text: async () => (await readFile(file, "utf8")).replace(/\r\n/g, "\n"),
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const source = args.find((arg) => !arg.startsWith("--")) ?? join(import.meta.dir, "..", "examples", "paper.tex");
  const harness = await startHarness(source, { port: 4810, mirador: args.includes("--mirador") });
  console.log(`${harness.url} on ${harness.file}`);
}
