/**
 * The desktop app's main process (Electrobun): one window on the app's server, the menus, the native file dialog, and
 * the app's updates. The window loads the view from the server, as a browser would; see server.ts.
 */
import Electrobun, { ApplicationMenu, BrowserWindow, PATHS, Utils, type ApplicationMenuItemConfig } from "electrobun/bun";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ProjectHost } from "./project-host.ts";
import { startServer } from "./server.ts";
import { Settings } from "./settings.ts";
import { AppUpdates } from "./updates.ts";

const settings = new Settings(Utils.paths.userData);
let project: ProjectHost | null = null;

const server = startServer({
  viewCode: () => Bun.file(join(PATHS.VIEWS_FOLDER, "neo-manuscript", "view.js")).text(),
  storage: settings.view,
  chooseProject: () => void chooseProject(),
  agentsFolder: join(PATHS.VIEWS_FOLDER, "neo-manuscript", "agents"),
  openExternal: (url) => void Utils.openExternal(url),
  chats: settings.chats,
});

// NEO_DEBUG=1 prints the page's address, to open it in a browser too, or to drive the app from a script.
if (process.env.NEO_DEBUG) console.log(`page: ${server.url}`);

const window = new BrowserWindow({
  title: "NeoManuscript",
  url: server.url,
  frame: { width: 1400, height: 900, x: 120, y: 80 },
});

const updates = new AppUpdates(() => server.stop());
updates.onChange = () => setMenu();

// The agents' processes go with the app.
Electrobun.events.on("before-quit", () => server.stop());

/** Opens a project folder, or the folder of a file with that file open. */
async function open(path: string) {
  const isFile = statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  let folder = isFile ? dirname(path) : path;
  try {
    folder = realpathSync(folder);
  } catch {
    // It's gone: opening it says so below.
  }
  const memory = settings.project(folder);
  try {
    const next = await ProjectHost.open(folder, {
      main: memory.main,
      open: isFile ? basename(path) : memory.open,
      trash: async (target) => void Utils.moveToTrash(target),
    });
    next.onMemory = (changed) => settings.remember(folder, changed);
    project?.close();
    project = next;
    settings.opened(folder);
    server.show(next);
    window.setTitle(`${next.name} — NeoManuscript`);
  } catch (error) {
    settings.forget(folder);
    await Utils.showMessageBox({ type: "error", title: "Can't open the project", message: `${basename(folder)} can't be opened.`, detail: (error as Error).message, buttons: ["OK"] });
  }
  setMenu();
}

async function chooseProject() {
  const [chosen] = await Utils.openFileDialog({
    startingFolder: project ? dirname(project.folder) : homedir(),
    allowedFileTypes: "tex",
    canChooseFiles: true,
    canChooseDirectory: true,
    allowsMultipleSelection: false,
  });
  if (chosen) await open(chosen);
}

function setMenu() {
  const recent: ApplicationMenuItemConfig[] = settings.recent.map((folder) => ({ label: folder.replace(homedir(), "~"), action: "open-recent", data: folder }));
  ApplicationMenu.setApplicationMenu([
    {
      label: "NeoManuscript",
      submenu: [
        { role: "about" },
        updates.ready ? { label: `Restart to Update to ${updates.ready}`, action: "restart-to-update" } : { label: "Check for Updates…", action: "check-for-updates" },
        { type: "divider" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "showAll" },
        { type: "divider" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "Open Project…", action: "open", accelerator: "CommandOrControl+O" },
        { label: "Open Recent", submenu: recent.length > 0 ? recent : [{ label: "No recent projects", enabled: false }] },
        { type: "divider" },
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [{ role: "undo" }, { role: "redo" }, { type: "divider" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }],
    },
    { label: "View", submenu: [{ role: "toggleFullScreen" }] },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "divider" }, { role: "bringAllToFront" }] },
  ] as ApplicationMenuItemConfig[]);
}

Electrobun.events.on("application-menu-clicked", (event: { data: { action: string; data?: unknown } }) => {
  const { action, data } = event.data;
  if (action === "open") void chooseProject();
  if (action === "open-recent" && typeof data === "string") void open(data);
  if (action === "check-for-updates") void updates.check(true);
  if (action === "restart-to-update") void updates.offerRestart();
});

setMenu();
const last = settings.recent[0];
if (last && statSync(last, { throwIfNoEntry: false })) await open(last);
