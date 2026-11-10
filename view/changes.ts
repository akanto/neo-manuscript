import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { changedRanges } from "../core/diff.ts";
import type { GitRefs, ProjectBridge } from "../core/host-api.ts";

/**
 * The change highlight: a toggle that marks the words of the open file added or changed since a baseline. The baseline
 * is the last commit or a tag, for a host that reads git (the desktop app in a repository), else the text as it was
 * when the view first opened the file. Removed words leave no mark, and whitespace doesn't count.
 */

type Range = { from: number; to: number };

/** Sets the ranges to mark; none takes the marks away. */
export const setChanges = StateEffect.define<Range[]>();

const changesField = StateField.define<Range[]>({
  create: () => [],
  update(ranges, transaction) {
    for (const effect of transaction.effects) if (effect.is(setChanges)) return effect.value;
    if (!transaction.docChanged || ranges.length === 0) return ranges;
    return ranges
      .map(({ from, to }) => ({ from: transaction.changes.mapPos(from, 1), to: transaction.changes.mapPos(to, -1) }))
      .filter(({ from, to }) => to > from);
  },
});

const changeMark = Decoration.mark({ class: "cm-changed" });

/**
 * The marks, drawn over what is in sight. In Visual mode a mark that reaches into a drawn widget (math, a citation)
 * covers the whole widget, as a mark inside it wouldn't show.
 */
const changesPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate) {
      const field = update.state.field(changesField);
      // A new mode, or Visual mode drawn anew, may hide other ranges.
      const redrawn = update.transactions.some((transaction) => transaction.reconfigured || transaction.effects.length > 0);
      if (update.docChanged || update.viewportChanged || update.selectionSet || redrawn || field !== update.startState.field(changesField)) this.decorations = this.build(update.view);
    }
    build(view: EditorView): DecorationSet {
      const ranges = view.state.field(changesField);
      if (ranges.length === 0) return Decoration.none;
      const { from: top, to: bottom } = view.viewport;
      const atomic = view.state.facet(EditorView.atomicRanges).map((source) => source(view));
      const marks = [];
      let last: Range | null = null;
      for (const range of ranges) {
        if (range.to < top || range.from > bottom) continue;
        let { from, to } = range;
        for (const set of atomic) {
          set.between(from, to, (start, end) => {
            if (end > from && start < to) {
              from = Math.min(from, start);
              to = Math.max(to, end);
            }
          });
        }
        if (last && from <= last.to) last.to = Math.max(last.to, to);
        else marks.push((last = { from, to }));
      }
      return Decoration.set(marks.map(({ from, to }) => changeMark.range(from, to)));
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** Whether the change highlight marks any of `from..to`. */
export function changedWithin(state: EditorState, from: number, to: number): boolean {
  return (state.field(changesField, false) ?? []).some((range) => range.to > from && range.from < to);
}

/**
 * A block widget of Visual mode (display math, a figure, the title) with a change in what it draws: marked as a whole,
 * as CodeMirror draws no marks around block widgets.
 */
export class ChangedBlock extends WidgetType {
  constructor(readonly inner: WidgetType) {
    super();
  }
  toDOM(view: EditorView): HTMLElement {
    const dom = this.inner.toDOM(view);
    dom.classList.add("cm-changed-block");
    return dom;
  }
  eq(other: WidgetType): boolean {
    return other instanceof ChangedBlock && this.inner.eq(other.inner);
  }
  get estimatedHeight() {
    return this.inner.estimatedHeight;
  }
  ignoreEvent(event: Event): boolean {
    return this.inner.ignoreEvent(event);
  }
  destroy(dom: HTMLElement) {
    this.inner.destroy(dom);
  }
}

/** A block widget as Visual mode draws it: marked when the change highlight finds a change in what it replaces. */
export function blockWidget(state: EditorState, from: number, to: number, widget: WidgetType): WidgetType {
  return changedWithin(state, from, to) ? new ChangedBlock(widget) : widget;
}

/** What an editor needs to show the change highlight's marks. */
export function changeMarks(): Extension {
  return [changesField, changesPlugin];
}

// --- The toggle -------------------------------------------------------------------------------------------------------

export interface ChangeHighlightOptions {
  /** The project, whose git methods give the baseline when it has them; null for a host of one document. */
  project: ProjectBridge | null;
  report(message: string | null): void;
  /** The files that differ from the baseline, for the file tree; null when the toggle is off. */
  onFiles(paths: Set<string> | null): void;
}

/** The baseline "since opened", in the ref menu. */
const OPENED = "";
const HEAD = "HEAD";
const DEBOUNCE_MS = 300;

export class ChangeHighlight {
  readonly element = document.createElement("span");
  private toggle = document.createElement("button");
  private menu = document.createElement("select");
  private note = document.createElement("span");
  private on = false;
  private view: EditorView | null = null;
  private file: string | null = null;
  /** Each file's text as it was when the view first opened it. */
  private opened = new Map<string | null, string>();
  /** Each file's text as the view last had it, for the file tree's marks "since opened". */
  private seen = new Map<string | null, string>();
  /** The refs the host offers; null when it reads no git, or the project isn't in a repository. */
  private refs: GitRefs | null = null;
  /** Files at the chosen ref, by path; null when the file isn't there. Cleared when the ref or HEAD moves. */
  private baselines = new Map<string, Promise<string | null>>();
  /** The files the host says differ from the ref on disk. */
  private changedOnDisk = new Set<string>();
  /** Whether the open file differs from the baseline, as the editor last compared it; null before it has. */
  private openChanged: boolean | null = null;
  /** Counts the listings of changed files, so that one overtaken by a later one doesn't show. */
  private listing = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private filesTimer: ReturnType<typeof setTimeout> | null = null;
  /** Counts the comparisons, so that one overtaken by a later one doesn't show. */
  private run = 0;
  private stopListening: (() => void)[] = [];

  constructor(private options: ChangeHighlightOptions) {
    this.element.className = "changes";
    this.toggle.type = "button";
    this.toggle.className = "changes-toggle";
    this.toggle.textContent = "Changes";
    this.toggle.title = "Mark the words that changed since the last commit, a tag, or since the file was opened";
    this.toggle.addEventListener("click", () => void this.setOn(!this.on));
    this.menu.className = "changes-menu";
    this.menu.title = "What the changes are compared with";
    this.menu.hidden = true;
    this.menu.addEventListener("change", () => {
      this.baselines.clear();
      void this.refreshFiles();
      this.compareNow();
    });
    this.note.className = "changes-note";
    this.element.append(this.toggle, this.menu, this.note);
  }

  /** The editor shows a file (null for a host that names none) with this text. */
  attach(view: EditorView, file: string | null, text: string) {
    if (this.view) this.seen.set(this.file, this.view.state.doc.toString());
    this.view = view;
    this.file = file;
    this.openChanged = null;
    if (!this.opened.has(file)) this.opened.set(file, text);
    this.compareNow();
  }

  /** The text in the editor changed. */
  changed() {
    if (!this.on) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.compareNow(), DEBOUNCE_MS);
  }

  private get ref(): string {
    return this.menu.value;
  }

  /** The commit the chosen ref names, as git is asked about it: a tag's name may hold what git takes but the app won't. */
  private get commit(): string {
    if (this.ref === HEAD) return this.refs?.head ?? HEAD;
    return this.refs?.tags.find((tag) => tag.name === this.ref)?.commit ?? this.ref;
  }

  private async setOn(on: boolean) {
    this.on = on;
    this.toggle.classList.toggle("on", on);
    this.menu.hidden = !on;
    if (!on) {
      for (const stop of this.stopListening) stop();
      this.stopListening = [];
      this.baselines.clear();
      this.changedOnDisk.clear();
      this.openChanged = null;
      this.listing++;
      this.note.textContent = "";
      this.view?.dispatch({ effects: setChanges.of([]) });
      this.options.onFiles(null);
      return;
    }
    const project = this.options.project;
    if (project?.onGitChange) this.stopListening.push(project.onGitChange(() => void this.gitMoved()));
    if (project) this.stopListening.push(project.onProject(() => this.wantFiles()));
    await this.readRefs();
    if (!this.on) return;
    await this.refreshFiles();
    this.compareNow();
  }

  /** Reads the host's refs and fills the menu, keeping the chosen one while it is still there. */
  private async readRefs() {
    const project = this.options.project;
    let refs: GitRefs | null = null;
    try {
      refs = project?.gitRefs ? await project.gitRefs() : null;
    } catch (error) {
      this.options.report(`Git can't be read: ${(error as Error).message}`);
    }
    // A repository with no commits has nothing to compare with yet.
    this.refs = refs && refs.head !== null ? refs : null;
    const chosen = this.menu.value;
    const options: [string, string][] = this.refs
      ? [[HEAD, "Last commit"], ...this.refs.tags.map((tag): [string, string] => [tag.name, tag.name])]
      : [[OPENED, "Since opened"]];
    this.menu.replaceChildren(
      ...options.map(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        return option;
      }),
    );
    this.menu.value = options.some(([value]) => value === chosen) ? chosen : options[0]![0];
  }

  /** HEAD or the tags moved: the menu, the baselines and the file tree's marks are read again. */
  private async gitMoved() {
    if (!this.on) return;
    const before = this.refs;
    const ref = this.ref;
    await this.readRefs();
    if (!this.on) return;
    const commitOf = (refs: GitRefs | null, name: string) => (name === HEAD ? refs?.head : refs?.tags.find((tag) => tag.name === name)?.commit) ?? null;
    if (ref !== this.ref || commitOf(before, ref) !== commitOf(this.refs, this.ref)) this.baselines.clear();
    await this.refreshFiles();
    this.compareNow();
  }

  /** The text to compare the open file with; null when the file isn't there at the ref. */
  private baseline(): Promise<string | null> {
    const project = this.options.project;
    if (this.ref === OPENED || !project?.fileAt || this.file === null) return Promise.resolve(this.opened.get(this.file) ?? null);
    let known = this.baselines.get(this.file);
    if (!known) {
      known = project.fileAt(this.commit, this.file);
      this.baselines.set(this.file, known);
      // A failed read is tried again next time.
      known.catch(() => this.baselines.delete(this.file!));
    }
    return known;
  }

  private compareNow() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.on || !this.view) return;
    const view = this.view;
    const file = this.file;
    const run = ++this.run;
    this.baseline().then(
      (before) => {
        if (run !== this.run || view !== this.view) return;
        const label = this.menu.selectedOptions[0]?.textContent ?? this.ref;
        if (before === null) {
          this.note.textContent = this.ref === OPENED ? "" : `New since ${label === "Last commit" ? "the last commit" : label}`;
          view.dispatch({ effects: setChanges.of([]) });
          this.showFiles(file, true);
          return;
        }
        const ranges = changedRanges(before, view.state.doc.toString());
        this.note.textContent = ranges.length === 0 ? "No changes" : "";
        view.dispatch({ effects: setChanges.of(ranges) });
        this.showFiles(file, ranges.length > 0);
      },
      (error: Error) => {
        if (run !== this.run) return;
        this.options.report(`The file can't be read at ${this.ref}: ${error.message}`);
      },
    );
  }

  // --- The file tree's marks ----------------------------------------------------------------------------------------

  private wantFiles() {
    if (this.filesTimer) clearTimeout(this.filesTimer);
    this.filesTimer = setTimeout(() => void this.refreshFiles(), 500);
  }

  /** Asks the host which files differ from the ref on disk; "since opened" knows only the files the view has had open. */
  private async refreshFiles() {
    const project = this.options.project;
    if (!this.on) return;
    const listing = ++this.listing;
    let changed: Set<string>;
    if (this.ref !== OPENED && project?.changedSince) {
      try {
        changed = new Set(await project.changedSince(this.commit));
      } catch {
        changed = new Set();
      }
    } else {
      // The open file is left to the editor's comparison: what the view saw of it before is old.
      changed = new Set([...this.seen].filter(([path, text]) => path !== null && path !== this.file && this.opened.get(path) !== text).map(([path]) => path!));
    }
    if (!this.on || listing !== this.listing) return;
    this.changedOnDisk = changed;
    this.options.onFiles(this.filesSet());
  }

  private showFiles(file: string | null, changed: boolean) {
    if (file === this.file) this.openChanged = changed;
    this.options.onFiles(this.filesSet());
  }

  /** The open file's own comparison wins over the disk's, as the editor may be ahead of it. */
  private filesSet(): Set<string> {
    const files = new Set(this.changedOnDisk);
    if (this.file !== null && this.openChanged !== null) {
      if (this.openChanged) files.add(this.file);
      else files.delete(this.file);
    }
    return files;
  }
}
