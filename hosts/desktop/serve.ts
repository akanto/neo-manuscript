/**
 * The desktop app's server without its window, to work on the view in a browser:
 * `bun hosts/desktop/serve.ts <project folder>` (after `bun scripts/build-desktop.ts`) prints the page's URL.
 * What is deleted goes to a folder in the system's temporary folder, in place of the trash.
 */
import { mkdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { ProjectHost } from "./project-host.ts";
import { startServer } from "./server.ts";
import { Settings } from "./settings.ts";

const folder = process.argv[2];
if (!folder) {
  console.error("Usage: bun hosts/desktop/serve.ts <project folder> [--port=N]");
  process.exit(1);
}
const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.slice(7) ?? 0);
const settings = new Settings(join(tmpdir(), "neo-manuscript-serve"));
const server = startServer({
  port,
  viewCode: () => Bun.file(join(import.meta.dir, "..", "..", "dist", "desktop", "view.js")).text(),
  storage: settings.view,
  agentsFolder: join(import.meta.dir, "..", "..", "dist", "desktop", "agents"),
  chats: settings.chats,
});
const trash = join(tmpdir(), "neo-manuscript-trash");
server.show(
  await ProjectHost.open(resolve(folder), {
    trash: async (path) => {
      await mkdir(trash, { recursive: true });
      await rename(path, join(trash, `${Date.now()}-${basename(path)}`));
    },
  }),
);
console.log(server.url);
