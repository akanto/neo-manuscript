import { Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { ASSIST_ACTIONS, rewriteFrom, rewriteInFilePrompt, type AssistAction, type RewriteRequest } from "../core/assist.ts";
import { hunksBetween, wordDiff } from "../core/diff.ts";
import { scan } from "./scan.ts";
import { selectedWord } from "./synonyms.ts";

/**
 * Writing actions on a selected passage: a popup over a selection of several words, with Grammar, Rephrase, Shorten,
 * Scientific and Clearer, and a field for the user's own instruction. The agent's rewrite comes back as a word diff
 * to accept or discard; a host that can't rewrite on the side asks the agent to change the file instead.
 */

export interface AssistOptions {
  language: "latex" | "markdown";
  /** Rewrites a passage on the side and answers with the agent's answer (raw; read it with rewriteFrom); null when the host can't. */
  rewrite: ((request: RewriteRequest, signal: AbortSignal) => Promise<string>) | null;
  /** Sends the agent a message, for a host without rewrite: the agent then changes the file itself. */
  ask: ((message: string) => Promise<void>) | null;
  /** Says what went wrong, as a banner. */
  report: (message: string) => void;
}

export interface SelectedPassage {
  from: number;
  to: number;
  text: string;
}

const MAX_LENGTH = 6000;
const MIN_WORDS = 4;
const CONTEXT_LENGTH = 1000;

/** The selection when it is a passage of prose to rewrite; else null. */
export function selectedPassage(state: EditorState, language: "latex" | "markdown"): SelectedPassage | null {
  if (state.selection.ranges.length !== 1) return null;
  const { from, to } = state.selection.main;
  if (from === to || to - from > MAX_LENGTH) return null;
  if (selectedWord(state)) return null;
  const text = state.sliceDoc(from, to);
  const words = text.replace(/\\[A-Za-z@]+/g, " ").match(/\p{L}[\p{L}'’-]*/gu);
  if (!words || words.length < MIN_WORDS) return null;
  if (language === "latex") {
    for (const token of scan(state.doc.toString())) {
      if (token.from > from) break;
      if (token.to < to) continue;
      if (token.kind === "math" || token.kind === "verbatim" || token.kind === "comment") return null;
    }
  }
  return { from, to, text };
}

/** The text around a passage for context: its paragraph before `from` and after `to`, each at most 1000 characters. */
export function contextAround(state: EditorState, from: number, to: number): { before: string; after: string } {
  let before = state.sliceDoc(Math.max(0, from - CONTEXT_LENGTH), from);
  let after = state.sliceDoc(to, Math.min(state.doc.length, to + CONTEXT_LENGTH));
  let last: RegExpExecArray | null = null;
  for (const match of before.matchAll(/\n[ \t]*\n/g)) last = match;
  if (last) before = before.slice(last.index + last[0].length);
  const first = /\n[ \t]*\n/.exec(after);
  if (first) after = after.slice(0, first.index);
  return { before, after };
}

const dismiss = StateEffect.define<null>();
const mouseDown = StateEffect.define<boolean>();

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(className: string, text: string, run: () => void, title = ""): HTMLButtonElement {
  const node = element("button", className, text);
  node.type = "button";
  if (title) node.title = title;
  // Mousedown, not click: the editor keeps its selection while the popup works.
  node.addEventListener("mousedown", (event) => {
    event.preventDefault();
    run();
  });
  return node;
}

/** Where the passage is, for an agent that changes the file itself. */
function placeOf(state: EditorState, target: SelectedPassage): string {
  const first = state.doc.lineAt(target.from).number;
  const last = state.doc.lineAt(target.to).number;
  return first === last ? `line ${first} of the open file` : `lines ${first}–${last} of the open file`;
}

/** Puts the rewrite in place of the passage, touching only the changed words, unless the text changed since. */
function accept(view: EditorView, target: SelectedPassage, rewrite: string, options: AssistOptions) {
  if (view.state.sliceDoc(target.from, target.to) !== target.text) {
    options.report("The text changed under the suggestion; try again.");
    return;
  }
  const changes = hunksBetween(target.text, rewrite).map((hunk) => ({ from: target.from + hunk.from, to: target.from + hunk.to, insert: hunk.insert }));
  view.dispatch({ changes, selection: { anchor: target.from + rewrite.length }, effects: dismiss.of(null), userEvent: "input.assist" });
  view.focus();
}

function panel(view: EditorView, target: SelectedPassage, options: AssistOptions, closing: { abort: () => void }): HTMLElement {
  const dom = element("div", "assist-panel-body");
  let controller: AbortController | null = null;
  closing.abort = () => controller?.abort();
  const close = () => view.dispatch({ effects: dismiss.of(null) });

  const request = (action: AssistAction, instruction?: string): RewriteRequest => ({
    action,
    instruction,
    text: target.text,
    ...contextAround(view.state, target.from, target.to),
    language: options.language,
  });

  const showActions = () => {
    controller = null;
    const row = element("div", "assist-actions");
    for (const info of ASSIST_ACTIONS) {
      if (info.id === "custom") continue;
      const node = button("assist-action", info.label, () => run(request(info.id)), info.title);
      node.dataset.action = info.id;
      row.append(node);
    }
    const input = element("input", "assist-instruction");
    input.type = "text";
    input.placeholder = "Or say how to rewrite it…";
    input.spellcheck = false;
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const instruction = input.value.trim();
        if (instruction) run(request("custom", instruction));
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        view.focus();
      }
    });
    dom.replaceChildren(row, input);
  };

  const showNote = (text: string) => dom.replaceChildren(element("div", "assist-note", text));

  const run = (rewriteRequest: RewriteRequest) => {
    if (options.rewrite) void rewriteOnSide(rewriteRequest);
    else void askAgent(rewriteRequest);
  };

  const askAgent = async (rewriteRequest: RewriteRequest) => {
    showNote("Asked; the agent changes the text and says so in the chat");
    try {
      await options.ask!(rewriteInFilePrompt(rewriteRequest, placeOf(view.state, target)));
    } catch (error) {
      options.report(`The question didn't go: ${(error as Error).message}`);
      showActions();
      return;
    }
    setTimeout(close, 1800);
  };

  const rewriteOnSide = async (rewriteRequest: RewriteRequest) => {
    const mine = new AbortController();
    controller = mine;
    const working = ASSIST_ACTIONS.find((info) => info.id === rewriteRequest.action)?.working ?? "Rewriting…";
    dom.replaceChildren(element("div", "assist-note", working), element("div", "assist-buttons"));
    dom.lastElementChild!.append(button("assist-cancel", "Cancel", () => (mine.abort(), showActions())));
    let rewrite: string;
    try {
      rewrite = rewriteFrom(await options.rewrite!(rewriteRequest, mine.signal), target.text);
    } catch (error) {
      if (mine.signal.aborted) return;
      options.report((error as Error).message);
      showActions();
      return;
    }
    if (mine.signal.aborted) return;
    controller = null;
    showResult(rewriteRequest, rewrite);
  };

  const showResult = (rewriteRequest: RewriteRequest, rewrite: string) => {
    const buttons = element("div", "assist-buttons");
    if (rewrite === target.text) {
      buttons.append(button("assist-discard", "Discard", close), button("assist-back", "Back", showActions));
      dom.replaceChildren(element("div", "assist-note", "No changes needed."), buttons);
      return;
    }
    const diff = element("div", "assist-diff");
    for (const part of wordDiff(target.text, rewrite)) {
      if (part.kind === "same") diff.append(document.createTextNode(part.text));
      else diff.append(element("span", part.kind === "removed" ? "assist-removed" : "assist-added", part.text));
    }
    buttons.append(
      button("assist-accept", "Accept", () => accept(view, target, rewrite, options)),
      button("assist-retry", "Try again", () => run(rewriteRequest)),
      button("assist-discard", "Discard", close),
    );
    dom.replaceChildren(diff, buttons);
  };

  showActions();
  return dom;
}

interface Popup {
  tooltip: Tooltip | null;
  /** Dismissed for the current selection. */
  off: boolean;
}

export function assist(options: AssistOptions): Extension {
  if (!options.rewrite && !options.ask) return [];

  const down = StateField.define<boolean>({
    create: () => false,
    update: (value, transaction) => {
      for (const effect of transaction.effects) if (effect.is(mouseDown)) value = effect.value;
      return value;
    },
  });

  const field = StateField.define<Popup>({
    create: () => ({ tooltip: null, off: false }),
    update(value, transaction) {
      const effects = transaction.effects;
      if (effects.some((effect) => effect.is(dismiss))) return { tooltip: null, off: true };
      const changed = transaction.docChanged || !!transaction.selection;
      if (!changed && !effects.some((effect) => effect.is(mouseDown))) return value;
      const off = changed ? false : value.off;
      if (off) return value;
      const target = transaction.state.field(down) ? null : selectedPassage(transaction.state, options.language);
      if (!target) return { tooltip: null, off };
      const old = value.tooltip;
      if (old && old.pos === target.from && old.end === target.to && !transaction.docChanged) return value;
      const closing = { abort: () => {} };
      return {
        off,
        tooltip: {
          pos: target.from,
          end: target.to,
          above: true,
          create: (view) => build(view, target, closing),
        },
      };
    },
    provide: (field) => showTooltip.from(field, (value) => value.tooltip),
  });

  function build(view: EditorView, target: SelectedPassage, closing: { abort: () => void }) {
    const dom = element("div", "assist-panel");
    dom.append(panel(view, target, options, closing));
    return { dom, destroy: () => closing.abort() };
  }

  // The mouse button is down while the user drags a selection; the popup waits for it to go up.
  const mouse = ViewPlugin.fromClass(
    class {
      listener = () => {
        if (this.view.state.field(down)) this.view.dispatch({ effects: mouseDown.of(false) });
      };
      constructor(readonly view: EditorView) {
        window.addEventListener("mouseup", this.listener);
      }
      destroy() {
        window.removeEventListener("mouseup", this.listener);
      }
    },
    {
      eventHandlers: {
        mousedown() {
          this.view.dispatch({ effects: mouseDown.of(true) });
          return false;
        },
      },
    },
  );

  return [
    down,
    field,
    mouse,
    Prec.high(keymap.of([{ key: "Escape", run: (view) => (view.state.field(field).tooltip ? (view.dispatch({ effects: dismiss.of(null) }), true) : false) }])),
  ];
}
