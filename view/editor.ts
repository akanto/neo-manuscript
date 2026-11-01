import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type Command,
  type DecorationSet,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { Problem } from "../core/build.ts";
import { scan, type Token } from "./scan.ts";
import { synonyms, type SynonymOptions } from "./synonyms.ts";
import { visualMode, type FileReader, type PdfDrawer } from "./visual.ts";

export type Mode = "source" | "visual";

const highlight = HighlightStyle.define([
  { tag: tags.keyword, class: "tok-command" },
  { tag: tags.tagName, class: "tok-command" },
  { tag: tags.atom, class: "tok-atom" },
  { tag: tags.number, class: "tok-number" },
  { tag: tags.comment, class: "tok-comment" },
  { tag: tags.bracket, class: "tok-bracket" },
  { tag: tags.string, class: "tok-math" },
  { tag: tags.variableName, class: "tok-variable" },
  { tag: tags.meta, class: "tok-meta" },
]);

// --- Lines the last build complained about, and text that changed elsewhere ------------------------------------------

export const setProblems = StateEffect.define<Problem[]>();

const problemField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setProblems)) continue;
      const doc = transaction.state.doc;
      const lines = new Map<number, Problem["severity"]>();
      for (const problem of effect.value) {
        if (problem.line === null || problem.line < 1 || problem.line > doc.lines) continue;
        if (problem.file !== null && !problem.file.endsWith(".tex")) continue;
        if (lines.get(problem.line) !== "error") lines.set(problem.line, problem.severity);
      }
      value = Decoration.set([...lines].sort(([a], [b]) => a - b).map(([line, severity]) => Decoration.line({ class: `cm-problem-${severity}` }).range(doc.line(line).from)));
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const flash = StateEffect.define<{ from: number; to: number }[]>();
const unflash = StateEffect.define<null>();

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(unflash)) value = Decoration.none;
      if (effect.is(flash)) {
        const marks = effect.value.filter(({ from, to }) => to > from).map(({ from, to }) => Decoration.mark({ class: "cm-flash" }).range(from, to));
        value = value.update({ add: marks, sort: true });
      }
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Shows where the agent changed the text for a few seconds. */
export function flashRanges(view: EditorView, ranges: { from: number; to: number }[]) {
  view.dispatch({ effects: flash.of(ranges) });
  setTimeout(() => view.dispatch({ effects: unflash.of(null) }), 2500);
}

// --- Formatting commands, for the toolbar and the keys ----------------------------------------------------------------

/** The innermost command named `name` whose argument holds the selection. */
function enclosing(state: EditorState, names: string[]): Extract<Token, { kind: "command" }> | null {
  const { from, to } = state.selection.main;
  let found: Extract<Token, { kind: "command" }> | null = null;
  for (const token of scan(state.doc.toString())) {
    if (token.kind !== "command" || !names.includes(token.name) || !token.args[0]) continue;
    const arg = token.args[0];
    if ((arg.from <= from && to <= arg.to) || (token.from === from && token.to === to)) {
      if (!found || token.from >= found.from) found = token;
    }
  }
  return found;
}

/** Wraps the selection in \name{...}, or takes the command away when the selection is already inside one. */
export function toggleCommand(name: string, alike: string[] = [name]): Command {
  return (view) => {
    const state = view.state;
    const inside = enclosing(state, alike);
    if (inside && inside.args[0]) {
      const arg = inside.args[0];
      const content = state.sliceDoc(arg.from, arg.to);
      const { from, to } = state.selection.main;
      const offset = arg.from - inside.from;
      view.dispatch({
        changes: { from: inside.from, to: inside.to, insert: content },
        selection: EditorSelection.range(Math.max(inside.from, from - offset), Math.max(inside.from, Math.min(inside.from + content.length, to - offset))),
        userEvent: "input.format",
      });
      return true;
    }
    view.dispatch(
      state.changeByRange((range) => {
        const text = state.sliceDoc(range.from, range.to);
        const open = `\\${name}{`;
        return {
          changes: { from: range.from, to: range.to, insert: `${open}${text}}` },
          range: EditorSelection.range(range.from + open.length, range.from + open.length + text.length),
        };
      }),
      { userEvent: "input.format", scrollIntoView: true },
    );
    return true;
  };
}

const HEADING = /^(\s*)\\(part|chapter|section|subsection|subsubsection|paragraph)(\*?)\s*\{(.*)\}\s*$/;

/** Makes the cursor's line a heading of this level, or plain text again when it is one already (or `null`). */
export function setHeading(level: string | null): Command {
  return (view) => {
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    const match = HEADING.exec(line.text);
    let insert: string;
    if (match) insert = level === null || match[2] === level ? `${match[1]}${match[4]}` : `${match[1]}\\${level}${match[3]}{${match[4]}}`;
    else if (level === null) return false;
    else {
      const indent = /^\s*/.exec(line.text)![0];
      insert = `${indent}\\${level}{${line.text.trim()}}`;
    }
    const cursor = line.from + insert.length - (insert.endsWith("}") ? 1 : 0);
    view.dispatch({ changes: { from: line.from, to: line.to, insert }, selection: { anchor: cursor }, userEvent: "input.format" });
    return true;
  };
}

/** Makes the selected lines the items of a list, or starts a list with one empty item. */
export function insertList(environment: "itemize" | "enumerate"): Command {
  return (view) => {
    const state = view.state;
    const { from, to } = state.selection.main;
    const first = state.doc.lineAt(from);
    const last = state.doc.lineAt(to);
    const indent = /^\s*/.exec(first.text)![0];
    const lines = state.sliceDoc(first.from, last.to).split("\n").map((line) => line.trim()).filter(Boolean);
    const items = (lines.length > 0 ? lines : [""]).map((line) => `${indent}  \\item ${line.replace(/^\\item\s*/, "")}`);
    const insert = `${indent}\\begin{${environment}}\n${items.join("\n")}\n${indent}\\end{${environment}}`;
    const cursor = first.from + `${indent}\\begin{${environment}}\n`.length + items[0]!.length;
    view.dispatch({ changes: { from: first.from, to: last.to, insert }, selection: { anchor: cursor }, userEvent: "input.format", scrollIntoView: true });
    return true;
  };
}

/** Wraps the selection in $...$, or in \[ ... \] on lines of its own. */
export function insertMath(display: boolean): Command {
  return (view) => {
    const state = view.state;
    view.dispatch(
      state.changeByRange((range) => {
        const text = state.sliceDoc(range.from, range.to);
        if (!display) return { changes: { from: range.from, to: range.to, insert: `$${text}$` }, range: EditorSelection.range(range.from + 1, range.from + 1 + text.length) };
        const line = state.doc.lineAt(range.from);
        const before = range.from > line.from && state.sliceDoc(line.from, range.from).trim() !== "" ? "\n" : "";
        const open = `${before}\\[\n  `;
        return { changes: { from: range.from, to: range.to, insert: `${open}${text}\n\\]\n` }, range: EditorSelection.range(range.from + open.length, range.from + open.length + text.length) };
      }),
      { userEvent: "input.format", scrollIntoView: true },
    );
    return true;
  };
}

export const bold = toggleCommand("textbf");
export const italic = toggleCommand("emph", ["emph", "textit"]);
export const code = toggleCommand("texttt");

// --- The editor --------------------------------------------------------------------------------------------------------

export interface EditorOptions {
  parent: HTMLElement;
  text: string;
  mode: Mode;
  readFile: FileReader | null;
  drawPdf: PdfDrawer | null;
  onChange: (fromUser: boolean) => void;
  onCompile: () => void;
  onTogglePreview: () => void;
  /** The synonym popup over a selected word; none without it. */
  synonyms: SynonymOptions | null;
  isRemote: (transaction: import("@codemirror/state").Transaction) => boolean;
}

export interface Editor {
  view: EditorView;
  setMode(mode: Mode): void;
}

export function createEditor(options: EditorOptions): Editor {
  const modeCompartment = new Compartment();
  const modeExtension = (mode: Mode): Extension =>
    mode === "visual" ? visualMode(options.readFile, options.drawPdf) : [lineNumbers(), highlightActiveLineGutter(), EditorView.editorAttributes.of({ class: "cm-source" })];

  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: options.text,
      extensions: [
        modeCompartment.of(modeExtension(options.mode)),
        history(),
        drawSelection(),
        highlightActiveLine(),
        bracketMatching(),
        search({ top: true }),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        StreamLanguage.define(stex),
        syntaxHighlighting(highlight),
        problemField,
        flashField,
        options.synonyms ? synonyms(options.synonyms) : [],
        keymap.of([
          { key: "Mod-b", run: bold },
          { key: "Mod-i", run: italic },
          { key: "Mod-m", run: insertMath(false) },
          { key: "Mod-Shift-m", run: insertMath(true) },
          { key: "Mod-Enter", run: () => (options.onCompile(), true) },
          { key: "Mod-s", run: () => (options.onCompile(), true) },
          { key: "Mod-Alt-p", run: () => (options.onTogglePreview(), true) },
          ...searchKeymap,
          ...historyKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          options.onChange(update.transactions.some((transaction) => transaction.docChanged && !options.isRemote(transaction)));
        }),
      ],
    }),
  });

  return {
    view,
    setMode(mode) {
      view.dispatch({ effects: modeCompartment.reconfigure(modeExtension(mode)) });
    },
  };
}
