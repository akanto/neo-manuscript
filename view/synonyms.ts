import { Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { keymap, showTooltip, type EditorView, type Tooltip } from "@codemirror/view";
import { scan } from "./scan.ts";
import { matchCase, type Pos, type Sense, type Thesaurus } from "./thesaurus.ts";

/**
 * Synonyms for the selected word: a popup over a selection of one to three words of the text (not of a command, a
 * formula or a key such as a \cite's), with WordNet's synonyms of each sense. Clicking one puts it in place of the
 * selection, and a button asks the agent for words that fit the sentence. Source and Visual mode are the same editor.
 */

export interface SynonymOptions {
  /** The thesaurus, unpacked on the first selection. */
  thesaurus: () => Promise<Thesaurus>;
  /** Sends the agent a message, when the host lets the view. */
  ask: ((message: string) => Promise<void>) | null;
  /** Says what went wrong, as a banner. */
  report: (message: string) => void;
}

export interface SelectedWord {
  from: number;
  to: number;
  text: string;
}

/** Commands whose argument is a name rather than prose: a key, a label, a file, a package, code. */
const KEY_COMMANDS = /^(cite\w*|\w*ref|label|begin|end|include\w*|input|usepackage|documentclass|bibliography\w*|url|href|texttt|verb|hyphenation|newcommand|renewcommand|def|setlength|newcolumntype)$/;

const WORDS = /^\p{L}[\p{L}'’-]*(?:[ \t]+\p{L}[\p{L}'’-]*){0,2}$/u;

/** The selection when it is one to three words of prose, whole, outside commands, formulas and keys; else null. */
export function selectedWord(state: EditorState): SelectedWord | null {
  if (state.selection.ranges.length !== 1) return null;
  const { from, to } = state.selection.main;
  if (from === to || to - from > 60) return null;
  const text = state.sliceDoc(from, to);
  if (!WORDS.test(text)) return null;
  const before = state.sliceDoc(Math.max(0, from - 1), from);
  const after = state.sliceDoc(to, to + 1);
  if (/[\p{L}\\@]/u.test(before) || /\p{L}/u.test(after)) return null;
  for (const token of scan(state.doc.toString())) {
    if (token.from >= to) break;
    if (token.to <= from) continue;
    if (token.kind === "math" || token.kind === "verbatim" || token.kind === "comment") return null;
    if (token.kind === "command" && KEY_COMMANDS.test(token.name)) return null;
  }
  return { from, to, text };
}

/** The sentence of the line around `from..to`, to quote to the agent. */
export function sentenceAround(line: string, from: number, to: number): string {
  let start = 0;
  for (const match of line.slice(0, from).matchAll(/[.!?](?=\s+\S)/g)) start = match.index + 1;
  const end = /[.!?](\s|$)/.exec(line.slice(to));
  const sentence = line.slice(start, end ? to + end.index + 1 : line.length).trim();
  return sentence.length > 800 ? `${sentence.slice(0, 797)}…` : sentence;
}

const POS_NAMES: Record<Pos, string> = { n: "noun", v: "verb", a: "adjective", r: "adverb" };

const dismiss = StateEffect.define<null>();

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** Puts a suggestion in place of the selection, unless the text changed under the popup since. */
function replace(view: EditorView, target: SelectedWord, word: string) {
  if (view.state.sliceDoc(target.from, target.to) !== target.text) return;
  const insert = matchCase(target.text, word);
  view.dispatch({ changes: { from: target.from, to: target.to, insert }, selection: { anchor: target.from + insert.length }, userEvent: "input.synonym" });
  view.focus();
}

function chip(view: EditorView, target: SelectedWord, word: string, className: string): HTMLButtonElement {
  const button = element("button", className, matchCase(target.text, word));
  button.type = "button";
  button.title = `Replace “${target.text}” with “${button.textContent}”`;
  // Mousedown, not click: the editor keeps its selection and the popup stays put until the replacement.
  button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    replace(view, target, word);
  });
  return button;
}

function senseRow(view: EditorView, target: SelectedWord, sense: Sense): HTMLElement {
  const row = element("div", "syn-sense");
  const gloss = element("div", "syn-gloss");
  gloss.append(element("span", "syn-pos", POS_NAMES[sense.pos]), document.createTextNode(` ${sense.definition}`));
  row.append(gloss);
  if (sense.synonyms.length > 0) {
    const words = element("div", "syn-words");
    words.append(...sense.synonyms.map((word) => chip(view, target, word, "syn-word")));
    row.append(words);
  }
  if (sense.related.length > 0) {
    const related = element("div", "syn-words syn-related");
    related.append(element("span", "syn-label", sense.pos === "a" ? "similar" : "broader"), ...sense.related.map((word) => chip(view, target, word, "syn-word")));
    row.append(related);
  }
  return row;
}

function askMessage(state: EditorState, target: SelectedWord): string {
  const line = state.doc.lineAt(target.from);
  const sentence = sentenceAround(line.text, target.from - line.from, target.to - line.from);
  return [
    `Suggest alternatives for “${target.text}” on line ${line.number} that keep its meaning and fit the sentence and the document's register.`,
    "List a few, each with a short note on how it differs, and change the text only when I pick one.",
    "",
    `(At line ${line.number}:)`,
    "```latex",
    sentence,
    "```",
  ].join("\n");
}

function panel(view: EditorView, target: SelectedWord, options: SynonymOptions): HTMLElement {
  const dom = element("div", "syn-panel");
  const list = element("div", "syn-senses");
  list.append(element("div", "syn-note", "Looking up…"));
  dom.append(list);
  if (options.ask) {
    const ask = element("button", "syn-ask", "Ask the agent for words that fit the sentence");
    ask.type = "button";
    ask.addEventListener("mousedown", (event) => {
      event.preventDefault();
      ask.disabled = true;
      ask.textContent = "Asked; the answer comes in the chat";
      options.ask!(askMessage(view.state, target)).catch((error: Error) => {
        ask.disabled = false;
        ask.textContent = "Ask the agent for words that fit the sentence";
        options.report(`The question didn't go: ${error.message}`);
      });
    });
    dom.append(ask);
  }
  options.thesaurus().then(
    (thesaurus) => {
      const senses = thesaurus.lookup(target.text);
      list.replaceChildren(...(senses.length > 0 ? senses.map((sense) => senseRow(view, target, sense)) : [element("div", "syn-note", `No synonyms in WordNet for “${target.text}”.`)]));
    },
    (error: Error) => list.replaceChildren(element("div", "syn-note", `The thesaurus didn't load: ${error.message}`)),
  );
  return dom;
}

export function synonyms(options: SynonymOptions): Extension {
  const field = StateField.define<Tooltip | null>({
    create: () => null,
    update(value, transaction) {
      if (transaction.effects.some((effect) => effect.is(dismiss))) return null;
      if (!transaction.docChanged && !transaction.selection) return value;
      const target = selectedWord(transaction.state);
      if (!target) return null;
      if (value && value.pos === target.from && value.end === target.to && !transaction.docChanged) return value;
      return { pos: target.from, end: target.to, above: true, create: (view) => ({ dom: panel(view, target, options) }) };
    },
    provide: (field) => showTooltip.from(field),
  });
  return [
    field,
    Prec.high(keymap.of([{ key: "Escape", run: (view) => (view.state.field(field) ? (view.dispatch({ effects: dismiss.of(null) }), true) : false) }])),
  ];
}
