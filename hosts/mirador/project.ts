import type { TexDocument } from "../../core/document.ts";
import type { HostBridge, ProjectBridge, ProjectState, TaskState } from "../../core/host-api.ts";
import { PROJECT_LISTING } from "../../core/project-files.ts";

/**
 * The project's files in Mirador. Mirador's plugin API lets a view read the files next to its document, but neither
 * list them nor open another one in the app, so the host's tasks write the listing (PROJECT_LISTING; every build does,
 * and the "files" task) and this reads it after each task. It offers no more: the view then shows other text files to
 * read, and asks the agent to open one to edit.
 */
export function miradorProject(mirador: HostBridge<TexDocument>): ProjectBridge | undefined {
  const { readFile, run } = mirador;
  if (!readFile || !run) return undefined;
  const listeners = new Set<(state: ProjectState) => void>();
  let latest: ProjectState | null = null;
  let asked = false;

  const load = async () => {
    try {
      latest = JSON.parse(await (await readFile(PROJECT_LISTING)).text()) as ProjectState;
      for (const listener of listeners) listener(latest);
    } catch {
      // Not listed yet: list it, once; a build would too.
      if (!asked) {
        asked = true;
        run("files");
      }
    }
  };

  let lastTask: Pick<TaskState, "runId" | "state"> | null = null;
  mirador.onState((state) => {
    const task = state.task;
    if (!task || task.state === "running" || (lastTask?.runId === task.runId && lastTask.state === task.state)) return;
    const first = lastTask === null;
    lastTask = { runId: task.runId, state: task.state };
    // The view's first state has the task of before; the listing is read below anyway.
    if (!first) void load();
  });
  void load();

  return {
    onProject(listener) {
      listeners.add(listener);
      if (latest) listener(latest);
      return () => listeners.delete(listener);
    },
    refresh: () => run("files"),
  };
}
