/** The pages the app's window loads from its server. */

/** What the page tells the view's bridge: the run's token and the settings kept from earlier runs. */
export interface PageConfig {
  token: string;
  storage: Record<string, string>;
}

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const asScript = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

/** The editor on a document. */
export function pageFor(token: string, title: string, storage: Record<string, string>): string {
  const config: PageConfig = { token, storage };
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>html,body{margin:0;height:100%}</style>
<script>window.__neoManuscript = ${asScript(config)};</script>
<script type="module" src="/view.js?t=${token}"></script>
</head><body></body></html>`;
}

/** What the window shows with no document open. */
export function startPage(token: string, canOpen: boolean): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>NeoManuscript</title>
<style>
  :root { color-scheme: light dark; font: 15px/1.5 -apple-system, system-ui, sans-serif; }
  body { margin: 0; height: 100vh; display: grid; place-items: center; }
  main { text-align: center; }
  h1 { font-size: 28px; font-weight: 600; margin: 0 0 6px; }
  p { margin: 0 0 20px; opacity: .7; }
  button { font: inherit; padding: 8px 18px; border-radius: 8px; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: color-mix(in srgb, currentColor 6%, transparent); color: inherit; cursor: pointer; }
</style></head>
<body><main>
  <h1>NeoManuscript</h1>
  <p>${canOpen ? "Open a project folder, or a .tex file, to start." : "Start with a project folder."}</p>
  ${canOpen ? `<button id="open">Open…</button> <kbd>⌘O</kbd>` : ""}
</main>
<script>
  const token = ${asScript(token)};
  document.getElementById("open")?.addEventListener("click", () => fetch("/open-project", { method: "POST", headers: { "x-token": token } }));
  // The app tells the page when a document opens.
  new EventSource("/events?t=" + token).addEventListener("reload", () => location.reload());
</script>
</body></html>`;
}
