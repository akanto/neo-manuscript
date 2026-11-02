import type { ProjectBridge, ProjectState } from "../core/host-api.ts";
import { kindOf, type ProjectEntry } from "../core/project.ts";

/** What the file tree asks of the rest of the view. */
export interface FileTreeOptions {
  project: ProjectBridge;
  /** Opens a file: a text file in the editor, anything else in the preview of it. */
  onOpen(path: string): void;
  report(message: string | null): void;
  /** The view's settings, for which folders are open. */
  storage: Storage | null;
}

interface Folder {
  path: string;
  folders: Map<string, Folder>;
  files: string[];
}

const ICONS: Record<ReturnType<typeof kindOf>, string> = { tex: "𝑇", markdown: "M↓", text: "≡", image: "▣", pdf: "▤", other: "·" };
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

function treeOf(entries: ProjectEntry[]): Folder {
  const root: Folder = { path: "", folders: new Map(), files: [] };
  const folderAt = (path: string): Folder => {
    if (path === "") return root;
    const parent = folderAt(parentOf(path));
    let folder = parent.folders.get(nameOf(path));
    if (!folder) parent.folders.set(nameOf(path), (folder = { path, folders: new Map(), files: [] }));
    return folder;
  };
  for (const entry of entries) {
    if (entry.kind === "folder") folderAt(entry.path);
    else folderAt(parentOf(entry.path)).files.push(entry.path);
  }
  return root;
}

/**
 * The project's files at the side of the view, as on Overleaf: folders that open and close, the open file marked, the
 * main file tagged. A right click offers what can be done to a file; files dropped from outside go into the project,
 * and a file dragged onto a folder moves into it.
 */
export class FileTree {
  readonly element = document.createElement("aside");
  private list = document.createElement("div");
  private state: ProjectState | null = null;
  private expanded: Set<string>;
  /** The file shown that isn't a text file (an image, a PDF), which the editor doesn't have open. */
  private previewed: string | null = null;
  private menu: HTMLElement | null = null;

  constructor(private options: FileTreeOptions) {
    this.expanded = new Set(JSON.parse(options.storage?.getItem("expanded") ?? "[]") as string[]);
    this.element.className = "files";
    const header = document.createElement("header");
    const title = document.createElement("span");
    title.className = "files-title";
    const project = options.project;
    header.append(title);
    if (project.createFile) header.append(this.headerButton("+", "New file", () => this.ask("", "file")));
    if (project.createFolder) header.append(this.headerButton("⊞", "New folder", () => this.ask("", "folder")));
    if (project.refresh) header.append(this.headerButton("↻", "List the files again", () => project.refresh!()));
    this.list.className = "files-list";
    this.element.append(header, this.list);
    this.list.addEventListener("contextmenu", (event) => {
      if (event.target === this.list) this.showMenu(event, null);
    });
    this.acceptDrops(this.list, "");
    document.addEventListener("pointerdown", (event) => {
      if (this.menu && !this.menu.contains(event.target as Node)) this.closeMenu();
    });
    options.project.onProject((state) => {
      this.state = state;
      title.textContent = state.name;
      title.title = state.name;
      if (state.open) this.previewed = null;
      this.render();
    });
  }

  /** Marks a file shown in the preview, in place of the editor's. */
  showPreviewed(path: string | null) {
    this.previewed = path;
    this.render();
  }

  private headerButton(label: string, title: string, onClick: () => void) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", onClick);
    return button;
  }

  private render() {
    if (!this.state) return;
    const scroll = this.list.scrollTop;
    this.list.replaceChildren(...this.rows(treeOf(this.state.entries), 0));
    if (this.state.entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "files-empty";
      empty.textContent = "No files yet. Make one with + above, or drop files here.";
      this.list.append(empty);
    }
    this.list.scrollTop = scroll;
  }

  private rows(folder: Folder, depth: number): HTMLElement[] {
    const rows: HTMLElement[] = [];
    for (const [name, child] of [...folder.folders].sort(([a], [b]) => a.localeCompare(b))) {
      const open = this.expanded.has(child.path);
      const row = this.row(child.path, `${open ? "▾" : "▸"} ${name}`, depth, "folder");
      row.addEventListener("click", () => this.toggle(child.path));
      this.acceptDrops(row, child.path);
      rows.push(row);
      if (open) rows.push(...this.rows(child, depth + 1));
    }
    for (const path of folder.files.sort((a, b) => nameOf(a).localeCompare(nameOf(b)))) {
      const row = this.row(path, `${ICONS[kindOf(path)]} ${nameOf(path)}`, depth, "file");
      row.classList.toggle("open", path === (this.previewed ?? this.state?.open));
      if (path === this.state?.main) {
        const badge = document.createElement("span");
        badge.className = "main-badge";
        badge.textContent = "main";
        badge.title = "The file the build compiles";
        row.append(badge);
      }
      row.addEventListener("click", () => this.options.onOpen(path));
      row.draggable = Boolean(this.options.project.rename);
      row.addEventListener("dragstart", (event) => event.dataTransfer?.setData("application/x-project-path", path));
      rows.push(row);
    }
    return rows;
  }

  private row(path: string, label: string, depth: number, kind: "file" | "folder"): HTMLElement {
    const row = document.createElement("div");
    row.className = `file-row ${kind}`;
    row.dataset.path = path;
    row.style.paddingLeft = `${8 + depth * 14}px`;
    const text = document.createElement("span");
    text.className = "file-name";
    text.textContent = label;
    row.title = path;
    row.append(text);
    row.addEventListener("contextmenu", (event) => this.showMenu(event, { path, kind }));
    return row;
  }

  private toggle(path: string) {
    if (this.expanded.has(path)) this.expanded.delete(path);
    else this.expanded.add(path);
    this.options.storage?.setItem("expanded", JSON.stringify([...this.expanded]));
    this.render();
  }

  // --- Changing the project ---------------------------------------------------------------------------------------

  private async attempt(work: Promise<void>) {
    try {
      await work;
      this.options.report(null);
    } catch (error) {
      this.options.report((error as Error).message);
    }
  }

  /** An input in the tree for the name of a new file or folder in `folder`, or for a new name of `renaming`. */
  private ask(folder: string, kind: "file" | "folder", renaming: string | null = null) {
    if (folder) this.expanded.add(folder);
    this.render();
    const input = document.createElement("input");
    input.className = "file-input";
    input.value = renaming ? nameOf(renaming) : "";
    input.placeholder = kind === "file" ? "name.tex" : "folder name";
    const depth = folder ? folder.split("/").length : 0;
    input.style.marginLeft = `${8 + depth * 14}px`;
    const existing = renaming ? this.list.querySelector<HTMLElement>(`[data-path="${CSS.escape(renaming)}"]`) : null;
    const anchor = existing ?? (folder ? this.list.querySelector<HTMLElement>(`[data-path="${CSS.escape(folder)}"]`) : null);
    if (existing) existing.replaceWith(input);
    else if (anchor) anchor.after(input);
    else this.list.prepend(input);
    input.focus();
    const dot = input.value.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (!commit || !name || (renaming && name === nameOf(renaming))) return this.render();
      if (name.includes("/")) {
        this.options.report("A name can't have a / in it.");
        return this.render();
      }
      const path = join(folder, name);
      const project = this.options.project;
      const work = renaming ? project.rename?.(renaming, path) : kind === "file" ? project.createFile?.(path) : project.createFolder?.(path);
      if (work) void this.attempt(work).then(() => this.render());
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  private showMenu(event: MouseEvent, target: { path: string; kind: "file" | "folder" } | null) {
    event.preventDefault();
    this.closeMenu();
    const project = this.options.project;
    const folder = target ? (target.kind === "folder" ? target.path : parentOf(target.path)) : "";
    const items: [string, () => void][] = [];
    if (target?.kind === "file") items.push(["Open", () => this.options.onOpen(target.path)]);
    const setMain = project.setMain;
    if (setMain && target?.kind === "file" && kindOf(target.path) === "tex" && !target.path.includes("/") && target.path !== this.state?.main) {
      items.push(["Set as main file", () => void this.attempt(setMain(target.path))]);
    }
    if (project.createFile) items.push(["New file", () => this.ask(folder, "file")]);
    if (project.createFolder) items.push(["New folder", () => this.ask(folder, "folder")]);
    if (target && project.rename) items.push(["Rename", () => this.ask(parentOf(target.path), target.kind, target.path)]);
    if (target && project.remove) items.push(["Delete", () => this.confirmRemove(target.path, target.kind)]);
    if (items.length === 0) return;
    const menu = document.createElement("div");
    menu.className = "context-menu";
    for (const [label, run] of items) {
      const item = document.createElement("button");
      item.type = "button";
      item.textContent = label;
      item.addEventListener("click", () => {
        this.closeMenu();
        run();
      });
      menu.append(item);
    }
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    document.body.append(menu);
    // Kept inside the window.
    const rect = menu.getBoundingClientRect();
    if (rect.bottom > innerHeight) menu.style.top = `${Math.max(0, innerHeight - rect.height - 4)}px`;
    this.menu = menu;
  }

  private closeMenu() {
    this.menu?.remove();
    this.menu = null;
  }

  /** Asks in the page before deleting: the app's web view may not show the browser's own confirm(). */
  private confirmRemove(path: string, kind: "file" | "folder") {
    const box = document.createElement("div");
    box.className = "confirm";
    const message = document.createElement("p");
    message.textContent = `Move ${kind === "folder" ? "the folder" : ""} “${nameOf(path)}”${kind === "folder" ? " and everything in it" : ""} to the Trash?`;
    const cancel = this.headerButton("Cancel", "Keep it", () => box.remove());
    const remove = this.headerButton("Move to Trash", "", () => {
      box.remove();
      const removing = this.options.project.remove?.(path);
      if (removing) void this.attempt(removing);
    });
    remove.className = "danger";
    box.append(message, cancel, remove);
    this.element.append(box);
    remove.focus();
  }

  /** Files dropped from outside go into `folder`; a file of the project dragged here moves into it. */
  private acceptDrops(target: HTMLElement, folder: string) {
    const { rename, upload } = this.options.project;
    if (!rename && !upload) return;
    target.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.stopPropagation();
      target.classList.add("drop");
    });
    target.addEventListener("dragleave", () => target.classList.remove("drop"));
    target.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      target.classList.remove("drop");
      const moved = event.dataTransfer?.getData("application/x-project-path");
      if (moved) {
        if (rename && parentOf(moved) !== folder && moved !== folder) void this.attempt(rename(moved, join(folder, nameOf(moved))));
        return;
      }
      const files = [...(event.dataTransfer?.files ?? [])];
      if (upload && files.length > 0) {
        if (folder) this.expanded.add(folder);
        void this.attempt(upload(folder, files));
      }
    });
  }
}

