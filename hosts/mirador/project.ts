import type { DocumentState, ProjectBridge, ProjectState } from "../../core/host-api.ts";
import { entriesOf, mainFileFor, type ProjectEntry } from "../../core/project.ts";
import type { MiradorBridge } from "./api.ts";

/**
 * The view's bridge in Mirador, with the workspace as the project: paths are named from the workspace, as the desktop
 * app names them from its project's folder. Mirador's own `readFile` names them from the document's folder, so they go
 * up to the workspace from there first.
 */
export function miradorBridge<Document>(mirador: MiradorBridge<Document>): MiradorBridge<Document> & { project: ProjectBridge } {
  /** The document's file in the workspace, as its last state named it. */
  let file: string | null = null;
  const fromDocument = (path: string) => "../".repeat(file ? file.split("/").length - 1 : 0) + path;
  const readFile = (path: string) => mirador.readFile(fromDocument(path));

  const listeners = new Set<(state: ProjectState) => void>();
  let latest: ProjectState | null = null;
  let loading: Promise<void> | null = null;
  let again = false;

  /** Lists the workspace and finds the main file of the open one; once more after, if asked meanwhile. */
  const load = (): Promise<void> => {
    if (loading) {
      again = true;
      return loading;
    }
    loading = (async () => {
      do {
        again = false;
        const { files } = await mirador.listFiles();
        const entries = entriesOf(files);
        const open = file;
        const main = open ? await mainFileFor(open, readerOf(entries, readFile)) : null;
        latest = { name: "Workspace", entries, main, open };
        for (const listener of listeners) listener(latest);
      } while (again);
    })().finally(() => (loading = null));
    return loading;
  };

  /** Whether one of the app's tasks (a build) runs, which Mirador opens no other file during; and who waits for it. */
  let busy = false;
  let idle: (() => void)[] = [];
  const whenIdle = () => (busy ? new Promise<void>((resolve) => idle.push(resolve)) : Promise.resolve());

  mirador.onState((state: DocumentState<Document>) => {
    busy = state.task?.state === "running";
    if (!busy) {
      for (const resolve of idle) resolve();
      idle = [];
    }
    const named = state.file ?? null;
    if (named === file) return;
    file = named;
    void load().catch(() => {});
  });
  mirador.onFiles(() => void load().catch(() => {}));

  const project: ProjectBridge = {
    onProject(listener) {
      listeners.add(listener);
      if (latest) listener(latest);
      return () => listeners.delete(listener);
    },
    refresh: () => void load().catch(() => {}),
    // A click during a build opens the file once the build is done, rather than being refused.
    open: async (path) => {
      for (let tries = 1; ; tries++) {
        await whenIdle();
        try {
          return await mirador.open(path);
        } catch (error) {
          // A build may have started in between: wait for it, a few times at most.
          if (!busy || tries >= 3) throw error;
        }
      }
    },
  };
  // Mirador's bridge, as it is, under these: its methods stay on it, as they may need it. It is frozen, so these are
  // defined rather than assigned, which a frozen readFile underneath would refuse.
  return Object.create(mirador, { readFile: { value: readFile }, project: { value: project } }) as MiradorBridge<Document> & { project: ProjectBridge };
}

/** How mainFileFor reads the workspace: its listing for what is in a folder, the files themselves for their text. */
function readerOf(entries: ProjectEntry[], readFile: (path: string) => Promise<Blob>) {
  return {
    filesIn: async (folder: string) =>
      entries
        .filter((entry) => entry.kind === "file" && (folder ? entry.path.startsWith(`${folder}/`) && !entry.path.slice(folder.length + 1).includes("/") : !entry.path.includes("/")))
        .map((entry) => entry.path.slice(entry.path.lastIndexOf("/") + 1)),
    read: (path: string) => readFile(path).then((blob) => blob.text(), () => null),
  };
}
