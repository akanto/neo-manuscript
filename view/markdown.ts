import { markdown, markdownLanguage as gfm } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, RangeSet, StateField, type Extension, type Range, type Text as DocText } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type Command, type DecorationSet } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { tags } from "@lezer/highlight";
import DOMPurify from "dompurify";
import katex from "katex";
import { marked, type Token, type TokensList } from "marked";
import type { FileReader } from "./visual.ts";
import { blockWidget, setChanges } from "./changes.ts";

/**
 * Markdown: the language for Source and Visual mode, the editing commands, Visual mode (the same text drawn as the
 * document would look, with markup shown again where the cursor is) and the HTML preview that stands in for the PDF.
 */

// --- Language -----------------------------------------------------------------------------------------------------

const highlight = HighlightStyle.define([
  { tag: [tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], class: "tok-md-heading" },
  { tag: tags.strong, class: "tok-md-strong" },
  { tag: tags.emphasis, class: "tok-md-em" },
  { tag: tags.strikethrough, class: "tok-md-strike" },
  { tag: tags.monospace, class: "tok-md-code" },
  { tag: [tags.link, tags.url], class: "tok-md-link" },
  { tag: tags.quote, class: "tok-md-quote" },
  { tag: [tags.processingInstruction, tags.contentSeparator], class: "tok-md-mark" },
  { tag: tags.comment, class: "tok-comment" },
]);

/** Markdown's language and highlighting, for Source and Visual mode alike (GFM: tables, strikethrough, task lists). */
export function markdownLanguage(): Extension {
  return [markdown({ base: gfm }), syntaxHighlighting(highlight)];
}

// --- Math in the text ---------------------------------------------------------------------------------------------

export interface MathRange {
  from: number;
  to: number;
  /** The formula, without its dollar signs. */
  source: string;
  display: boolean;
}

/** Finds `$...$` and `$$...$$` in text, leaving out the `excluded` ranges (code and the like), which must be sorted. */
export function mathRanges(text: string, excluded: readonly (readonly [number, number])[] = []): MathRange[] {
  const found: MathRange[] = [];
  const hitAt = (at: number) => excluded.find(([from, to]) => at >= from && at < to);
  const crosses = (from: number, to: number) => excluded.some(([a, b]) => a < to && b > from);
  let i = 0;
  while (i < text.length) {
    const hit = hitAt(i);
    if (hit) {
      i = hit[1];
      continue;
    }
    const char = text[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char !== "$") {
      i++;
      continue;
    }
    if (text[i + 1] === "$") {
      const close = text.indexOf("$$", i + 2);
      const source = close === -1 ? "" : text.slice(i + 2, close);
      if (close !== -1 && source.trim() !== "" && !crosses(i, close + 2)) {
        found.push({ from: i, to: close + 2, source: source.trim(), display: true });
        i = close + 2;
      } else i += 2;
      continue;
    }
    // Inline: no space after the opening sign or before the closing one, and not a digit after it ("$5 and $6").
    if (i + 1 >= text.length || /\s/.test(text[i + 1]!)) {
      i++;
      continue;
    }
    let close = -1;
    for (let j = i + 1; j < text.length && text[j] !== "\n"; j++) {
      if (text[j] === "\\") {
        j++;
        continue;
      }
      if (text[j] === "$") {
        if (!/\s/.test(text[j - 1]!) && !/\d/.test(text[j + 1] ?? "") && text[j + 1] !== "$") close = j;
        break;
      }
    }
    if (close === -1 || crosses(i, close + 1)) {
      i++;
      continue;
    }
    found.push({ from: i, to: close + 1, source: text.slice(i + 1, close), display: false });
    i = close + 1;
  }
  return found;
}

/** The ranges of fenced code and inline code in text, sorted, for when there is no syntax tree to ask. */
export function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*$/gm;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text))) {
    const marker = match[1]!;
    const closing = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`, "m");
    const rest = text.slice(fence.lastIndex + 1);
    const end = closing.exec(rest);
    const to = end ? fence.lastIndex + 1 + end.index + end[0].length : text.length;
    ranges.push([match.index, to]);
    fence.lastIndex = to;
  }
  const inline = /(`+)(?:[^`]|(?!\1)`+)*?\1(?!`)/g;
  while ((match = inline.exec(text))) {
    const at = match.index;
    if (!ranges.some(([from, to]) => at >= from && at < to)) ranges.push([at, at + match[0].length]);
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

// --- Commands -----------------------------------------------------------------------------------------------------

function treeOf(state: EditorState) {
  return ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
}

/** The syntax node called `name` that holds from..to, if there is one. */
function enclosing(state: EditorState, from: number, to: number, name: string): SyntaxNode | null {
  const tree = treeOf(state);
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(from, side); node; node = node.parent) {
      if (node.name === name && node.from <= from && node.to >= to) return node;
    }
  }
  return null;
}

/** Wraps the selection in `marker`, or takes the markers away when the selection is inside such an element. */
function toggleMarker(name: string, markName: string, markers: string[]): Command {
  return (view) => {
    const state = view.state;
    const marker = markers[0]!;
    view.dispatch(
      state.changeByRange((range) => {
        const inside = enclosing(state, range.from, range.to, name);
        let marks: { from: number; to: number }[] | null = null;
        if (inside) {
          marks = [];
          for (let child = inside.firstChild; child; child = child.nextSibling) if (child.name === markName) marks.push({ from: child.from, to: child.to });
        } else {
          // Without a syntax tree, markers right around the selection still count.
          for (const candidate of markers) {
            const before = state.sliceDoc(range.from - candidate.length, range.from);
            const after = state.sliceDoc(range.to, range.to + candidate.length);
            const stray = (at: number, side: 1 | -1) => candidate.length === 1 && state.sliceDoc(side === 1 ? at : at - 1, side === 1 ? at + 1 : at) === candidate;
            if (before === candidate && after === candidate && !stray(range.from - candidate.length, -1) && !stray(range.to + candidate.length, 1)) {
              marks = [{ from: range.from - candidate.length, to: range.from }, { from: range.to, to: range.to + candidate.length }];
              break;
            }
          }
        }
        if (marks && marks.length > 0) {
          const changes = state.changes(marks.map((mark) => ({ from: mark.from, to: mark.to })));
          const anchor = changes.mapPos(range.anchor, range.anchor <= range.head ? 1 : -1);
          const head = range.empty ? anchor : changes.mapPos(range.head, range.head >= range.anchor ? -1 : 1);
          return { changes, range: EditorSelection.range(anchor, head) };
        }
        // The markers go inside the spaces around the selection, where Markdown wants them.
        const text = state.sliceDoc(range.from, range.to);
        const lead = text.length - text.trimStart().length;
        const trail = text.length - text.trimEnd().length;
        const [from, to] = text.trim() === "" ? [range.from, range.to] : [range.from + lead, range.to - trail];
        const inner = state.sliceDoc(from, to);
        return {
          changes: { from, to, insert: `${marker}${inner}${marker}` },
          range: EditorSelection.range(from + marker.length, from + marker.length + inner.length),
        };
      }),
      { userEvent: "input.format", scrollIntoView: true },
    );
    return true;
  };
}

export const mdBold: Command = toggleMarker("StrongEmphasis", "EmphasisMark", ["**", "__"]);
export const mdItalic: Command = toggleMarker("Emphasis", "EmphasisMark", ["*", "_"]);
export const mdCode: Command = toggleMarker("InlineCode", "CodeMark", ["`"]);

const HEADING = /^( {0,3})(#{1,6})[ \t]+(.*)$/;

/** Makes the cursor's line a heading of this level, plain text when it is one of this level already. */
export function mdHeading(level: 1 | 2 | 3): Command {
  return (view) => {
    const state = view.state;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const match = HEADING.exec(line.text);
    const indent = match ? match[1]! : /^\s*/.exec(line.text)![0];
    const content = match ? match[3]! : line.text.trim();
    const prefix = match && match[2]!.length === level ? indent : `${indent}${"#".repeat(level)} `;
    const before = Math.max(0, Math.min(content.length, head - line.from - (line.text.length - line.text.trimStart().length) - (match ? match[2]!.length + 1 : 0)));
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: prefix + content },
      selection: { anchor: line.from + prefix.length + before },
      userEvent: "input.format",
    });
    return true;
  };
}

const BULLET = /^(\s*)[-*+][ \t]+/;
const NUMBERED = /^(\s*)\d+[.)][ \t]+/;

/** Makes the selected lines the items of a list, takes them out of it when they all are, or starts an empty item. */
export function mdList(ordered: boolean): Command {
  return (view) => {
    const state = view.state;
    const { from, to } = state.selection.main;
    const first = state.doc.lineAt(from);
    let last = state.doc.lineAt(to);
    if (last.number > first.number && to === last.from) last = state.doc.line(last.number - 1);
    const lines: string[] = [];
    for (let n = first.number; n <= last.number; n++) lines.push(state.doc.line(n).text);
    const own = ordered ? NUMBERED : BULLET;
    let targets = lines.filter((line) => line.trim() !== "");
    if (targets.length === 0 && lines.length === 1) targets = lines;
    const allItems = targets.length > 0 && targets.every((line) => own.test(line));
    let count = 0;
    const out = lines.map((line) => {
      if (line.trim() === "" && !targets.includes(line)) return line;
      if (line.trim() === "" && targets.length === 0) return line;
      const stripped = line.replace(BULLET, "$1").replace(NUMBERED, "$1");
      if (allItems) return stripped;
      const indent = /^\s*/.exec(stripped)![0];
      return `${indent}${ordered ? `${++count}. ` : "- "}${stripped.slice(indent.length)}`;
    });
    if (lines.length === 1 && lines[0]!.trim() === "" && !allItems) out[0] = `${lines[0]}${ordered ? "1. " : "- "}`;
    const insert = out.join("\n");
    const selection = state.selection.main.empty ? { anchor: first.from + insert.length } : { anchor: first.from, head: first.from + insert.length };
    view.dispatch({ changes: { from: first.from, to: last.to, insert }, selection, userEvent: "input.format", scrollIntoView: true });
    return true;
  };
}

/** Wraps the selection in $...$, or in $$ ... $$ on lines of its own. */
export function mdMath(display: boolean): Command {
  return (view) => {
    const state = view.state;
    view.dispatch(
      state.changeByRange((range) => {
        const text = state.sliceDoc(range.from, range.to);
        if (!display) return { changes: { from: range.from, to: range.to, insert: `$${text}$` }, range: EditorSelection.range(range.from + 1, range.from + 1 + text.length) };
        const line = state.doc.lineAt(range.from);
        const before = range.from > line.from && state.sliceDoc(line.from, range.from).trim() !== "" ? "\n" : "";
        const open = `${before}$$\n`;
        return { changes: { from: range.from, to: range.to, insert: `${open}${text}\n$$\n` }, range: EditorSelection.range(range.from + open.length, range.from + open.length + text.length) };
      }),
      { userEvent: "input.format", scrollIntoView: true },
    );
    return true;
  };
}

// --- Math and images, drawn ---------------------------------------------------------------------------------------

function renderMath(element: HTMLElement, source: string, display: boolean) {
  try {
    katex.render(source, element, { displayMode: display, throwOnError: false, strict: "ignore", trust: false });
  } catch {
    element.textContent = source;
    element.classList.add("cm-v-math-error");
  }
}

let readImage: FileReader | null = null;
const imageCache = new Map<string, Promise<string>>();

/** The address a project image can be shown from, read once. */
function imageUrl(path: string): Promise<string> {
  const known = imageCache.get(path);
  if (known) return known;
  if (!readImage) return Promise.reject(new Error("Files can't be read from here."));
  const loading = readImage(path).then((blob) => URL.createObjectURL(/\.svg$/i.test(path) ? new Blob([blob], { type: "image/svg+xml" }) : blob));
  imageCache.set(path, loading);
  loading.catch(() => imageCache.delete(path));
  return loading;
}

/** The path inside a Markdown link: no angle brackets, no escapes of spaces, no query or anchor. */
function localPath(url: string): string | null {
  const bare = url.trim().replace(/^<(.*)>$/, "$1");
  if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(bare)) return null;
  const path = bare.replace(/[?#].*$/, "");
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

// --- Widgets ------------------------------------------------------------------------------------------------------

/** A widget that moves the cursor `enter` characters into the source it stands for when clicked, which shows it. */
abstract class SourceWidget extends WidgetType {
  constructor(readonly enter: number) {
    super();
  }
  protected clickable(view: EditorView, dom: HTMLElement): HTMLElement {
    dom.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const at = view.posAtDOM(dom);
      view.dispatch({ selection: { anchor: Math.min(at + this.enter, view.state.doc.length) } });
      view.focus();
    });
    return dom;
  }
  override ignoreEvent() {
    return false;
  }
}

class TextWidget extends SourceWidget {
  constructor(readonly text: string, readonly className: string, enter = 0) {
    super(enter);
  }
  override eq(other: TextWidget) {
    return other.text === this.text && other.className === this.className && other.enter === this.enter;
  }
  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.className = this.className;
    span.textContent = this.text;
    return this.clickable(view, span);
  }
}

/** The box of a task item; clicking it ticks or unticks the `[ ]` in the source. */
class TaskWidget extends WidgetType {
  constructor(readonly done: boolean) {
    super();
  }
  override eq(other: TaskWidget) {
    return other.done === this.done;
  }
  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.className = this.done ? "cm-v-bullet cm-md-task cm-md-task-done" : "cm-v-bullet cm-md-task";
    span.textContent = this.done ? "☑" : "☐";
    span.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const at = view.posAtDOM(span);
      if (view.state.sliceDoc(at, at + 1) !== "[") return;
      view.dispatch({ changes: { from: at + 1, to: at + 2, insert: this.done ? " " : "x" }, userEvent: "input.format" });
    });
    return span;
  }
  override ignoreEvent() {
    return true;
  }
}

/** A table as the preview draws it; clicking it shows its source. */
class TableWidget extends SourceWidget {
  constructor(readonly source: string) {
    super(0);
  }
  override eq(other: TableWidget) {
    return other.source === this.source;
  }
  toDOM(view: EditorView) {
    const element = document.createElement("div");
    element.className = "cm-md-table";
    element.innerHTML = DOMPurify.sanitize(marked.parse(this.source, { async: false, gfm: true }) as string, { FORBID_TAGS: ["style", "form"], FORBID_ATTR: ["style"] });
    for (const cell of element.querySelectorAll("td, th")) renderMathIn(cell as HTMLElement);
    return this.clickable(view, element);
  }
}

/** Draws the $…$ in a table cell's text with KaTeX. */
function renderMathIn(cell: HTMLElement) {
  const text = cell.textContent ?? "";
  if (!text.includes("$") || cell.querySelector("code")) return;
  const ranges = mathRanges(text);
  if (ranges.length === 0) return;
  cell.textContent = "";
  let at = 0;
  for (const math of ranges) {
    cell.append(text.slice(at, math.from));
    const span = document.createElement("span");
    try {
      katex.render(math.source, span, { displayMode: false, throwOnError: false, strict: "ignore", trust: false });
    } catch {
      span.textContent = text.slice(math.from, math.to);
    }
    cell.append(span);
    at = math.to;
  }
  cell.append(text.slice(at));
}

class RuleWidget extends SourceWidget {
  constructor(readonly block: boolean) {
    super(0);
  }
  override eq(other: RuleWidget) {
    return other.block === this.block;
  }
  toDOM(view: EditorView) {
    const element = document.createElement(this.block ? "div" : "span");
    element.className = "cm-md-rule";
    return this.clickable(view, element);
  }
}

class MathWidget extends SourceWidget {
  constructor(readonly source: string, readonly display: boolean, readonly block: boolean, enter: number) {
    super(enter);
  }
  override eq(other: MathWidget) {
    return other.source === this.source && other.display === this.display && other.block === this.block && other.enter === this.enter;
  }
  toDOM(view: EditorView) {
    const element = document.createElement(this.block ? "div" : "span");
    element.className = this.display ? "cm-v-math cm-v-math-display" : "cm-v-math";
    renderMath(element, this.source, this.display);
    return this.clickable(view, element);
  }
}

/** A formula as KaTeX draws it, under the source while it is being edited. */
class MathPreviewWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  override eq(other: MathPreviewWidget) {
    return other.source === this.source;
  }
  toDOM() {
    const element = document.createElement("div");
    element.className = "cm-v-math cm-v-math-display cm-v-math-preview";
    renderMath(element, this.source, true);
    return element;
  }
}

class ImageWidget extends SourceWidget {
  constructor(readonly path: string | null, readonly alt: string, readonly block: boolean, enter: number) {
    super(enter);
  }
  override eq(other: ImageWidget) {
    return other.path === this.path && other.alt === this.alt && other.block === this.block && other.enter === this.enter;
  }
  toDOM(view: EditorView) {
    const element = document.createElement(this.block ? "div" : "span");
    element.className = "cm-v-figure";
    const note = (text: string) => {
      element.textContent = text;
      element.classList.add("cm-v-figure-missing");
    };
    if (this.path === null) {
      note(this.alt || "image");
      element.title = "Online images aren't loaded";
      return this.clickable(view, element);
    }
    note(`🖼 ${this.alt || this.path}`);
    imageUrl(this.path).then(
      (url) => {
        const image = document.createElement("img");
        image.alt = this.alt;
        image.src = url;
        element.textContent = "";
        element.classList.remove("cm-v-figure-missing");
        element.append(image);
      },
      () => note(`🖼 ${this.path} (not found)`),
    );
    return this.clickable(view, element);
  }
}

// --- Visual mode --------------------------------------------------------------------------------------------------

interface Built {
  decorations: DecorationSet;
  atomic: RangeSet<Decoration>;
}

/** Whether the selection touches `from..to`, its ends included. */
function selected(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

/** Whether `from..to` is all that is on its lines but spaces, so it can be drawn as a block of its own. */
function aloneOnLines(doc: DocText, from: number, to: number): { from: number; to: number } | null {
  const first = doc.lineAt(from);
  const last = doc.lineAt(to);
  if (doc.sliceString(first.from, from).trim() !== "" || doc.sliceString(to, last.to).trim() !== "") return null;
  return { from: first.from, to: last.to };
}

/** Nodes whose text is not prose, so a dollar sign in them is not math. */
const NOT_MATH = new Set(["InlineCode", "FencedCode", "CodeBlock", "Comment", "CommentBlock", "HTMLBlock", "HTMLTag", "URL", "LinkTitle"]);

function children(node: SyntaxNode, name: string): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) if (child.name === name) found.push(child);
  return found;
}

function build(state: EditorState): Built {
  const doc = state.doc;
  const decorations: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const hide = (from: number, to: number, widget?: WidgetType, block = false) => {
    if (from >= to && !widget) return;
    if (widget && block) widget = blockWidget(state, from, to, widget);
    const decoration = Decoration.replace(widget ? { widget, block } : {});
    decorations.push(decoration.range(from, to));
    atomic.push(decoration.range(from, to));
  };
  const mark = (from: number, to: number, className: string) => {
    if (from < to && className) decorations.push(Decoration.mark({ class: className }).range(from, to));
  };
  const lineClass = (position: number, className: string) => decorations.push(Decoration.line({ class: className }).range(doc.lineAt(position).from));
  const lineClasses = (from: number, to: number, className: string) => {
    for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) lineClass(doc.line(n).from, className);
  };
  /** Hides markup, or shows it dimmed when `shown`. */
  const markup = (from: number, to: number, shown: boolean) => (shown ? mark(from, to, "cm-v-markup") : hide(from, to));
  const skipSpace = (at: number, limit: number) => {
    while (at < limit && /[ \t]/.test(doc.sliceString(at, at + 1))) at++;
    return at;
  };

  const excluded: [number, number][] = [];
  /** Paragraphs the cursor isn't in, and what is drawn as a block (whose line breaks a paragraph mustn't take). */
  const paragraphs: [number, number][] = [];
  const blocks: [number, number][] = [];
  const tree = treeOf(state);
  tree.iterate({
    enter(ref) {
      const { name, from, to } = ref;
      if (NOT_MATH.has(name)) excluded.push([from, to]);
      const node = ref.node;
      const heading = /^ATXHeading([1-6])$/.exec(name);
      if (heading) {
        lineClass(from, `cm-md-h${heading[1]}`);
        const shown = selected(state, from, to);
        for (const m of children(node, "HeaderMark")) {
          if (shown) mark(m.from, m.to, "cm-v-markup");
          else if (m.from === from) hide(m.from, skipSpace(m.to, to));
          else {
            let start = m.from;
            while (start > from && /[ \t]/.test(doc.sliceString(start - 1, start))) start--;
            hide(start, m.to);
          }
        }
        return;
      }
      const setext = /^SetextHeading([12])$/.exec(name);
      if (setext) {
        const shown = selected(state, from, to);
        const underline = children(node, "HeaderMark")[0];
        const last = underline ? doc.lineAt(underline.from).number - 1 : doc.lineAt(to).number;
        for (let n = doc.lineAt(from).number; n <= last; n++) lineClass(doc.line(n).from, `cm-md-h${setext[1]}`);
        if (underline) {
          const line = doc.lineAt(underline.from);
          if (shown) mark(underline.from, underline.to, "cm-v-markup");
          else {
            hide(line.from, line.to);
            lineClass(line.from, "cm-v-collapsed");
          }
        }
        return;
      }
      switch (name) {
        case "Emphasis":
        case "StrongEmphasis":
        case "Strikethrough":
        case "InlineCode": {
          const shown = selected(state, from, to);
          mark(from, to, name === "Emphasis" ? "cm-v-italic" : name === "StrongEmphasis" ? "cm-v-bold" : name === "Strikethrough" ? "cm-md-strike" : "cm-v-mono");
          for (const child of node.getChildren(name === "InlineCode" ? "CodeMark" : name === "Strikethrough" ? "StrikethroughMark" : "EmphasisMark")) markup(child.from, child.to, shown);
          return;
        }
        case "Link": {
          const marks = children(node, "LinkMark");
          const shown = selected(state, from, to);
          if (marks.length >= 4 && children(node, "URL").length > 0) {
            mark(marks[0]!.to, marks[1]!.from, "cm-v-link");
            markup(marks[0]!.from, marks[0]!.to, shown);
            markup(marks[1]!.from, to, shown);
          } else mark(from, to, "cm-v-link");
          return;
        }
        case "Image": {
          const marks = children(node, "LinkMark");
          const url = children(node, "URL")[0];
          if (marks.length < 2 || !url) return;
          if (selected(state, from, to)) {
            mark(from, to, "cm-v-markup");
            return;
          }
          const alt = doc.sliceString(marks[0]!.to, marks[1]!.from);
          const path = localPath(doc.sliceString(url.from, url.to));
          const lines = aloneOnLines(doc, from, to);
          if (lines) {
            hide(lines.from, lines.to, new ImageWidget(path, alt, true, from - lines.from), true);
            blocks.push([lines.from, lines.to]);
          } else hide(from, to, new ImageWidget(path, alt, false, 0));
          return;
        }
        case "Autolink": {
          const shown = selected(state, from, to);
          for (const m of children(node, "LinkMark")) markup(m.from, m.to, shown);
          mark(from, to, "cm-v-link");
          return;
        }
        case "URL":
          if (node.parent && !["Link", "Image", "Autolink"].includes(node.parent.name)) mark(from, to, "cm-v-link");
          return;
        case "Comment":
        case "CommentBlock":
          mark(from, to, "cm-v-comment");
          return;
        case "Blockquote":
          lineClasses(from, to, "cm-v-quote");
          return;
        case "QuoteMark": {
          const line = doc.lineAt(from);
          const end = doc.sliceString(to, to + 1) === " " ? to + 1 : to;
          markup(from, end, selected(state, line.from, line.to));
          return;
        }
        case "ListItem": {
          const listMark = children(node, "ListMark")[0];
          if (!listMark) return;
          let depth = 0;
          for (let up = node.parent; up; up = up.parent) if (up.name === "BulletList" || up.name === "OrderedList") depth++;
          const line = doc.lineAt(listMark.from);
          lineClass(line.from, `cm-v-list cm-v-depth-${Math.min(depth, 4)}`);
          const end = doc.sliceString(listMark.to, listMark.to + 1) === " " ? listMark.to + 1 : listMark.to;
          const start = doc.sliceString(line.from, listMark.from).trim() === "" ? line.from : listMark.from;
          if (selected(state, start, end)) mark(listMark.from, listMark.to, "cm-v-markup");
          else if (listMark.nextSibling?.name === "Task") hide(start, end);
          else {
            const ordered = node.parent?.name === "OrderedList";
            hide(start, end, new TextWidget(ordered ? doc.sliceString(listMark.from, listMark.to) : "•", ordered ? "cm-v-bullet" : "cm-v-bullet cm-md-dot", end - start));
          }
          return;
        }
        case "TaskMarker":
          if (selected(state, from, to)) mark(from, to, "cm-v-markup");
          else hide(from, to, new TaskWidget(/\[[xX]\]/.test(doc.sliceString(from, to))));
          return;
        case "HorizontalRule": {
          if (selected(state, from, to)) {
            mark(from, to, "cm-v-markup");
            return;
          }
          const lines = aloneOnLines(doc, from, to);
          if (lines) hide(lines.from, lines.to, new RuleWidget(true), true);
          else hide(from, to, new RuleWidget(false));
          return;
        }
        case "FencedCode": {
          // A box, as in the preview: its fences show only while the cursor is in the block.
          lineClasses(from, to, "cm-v-verbatim cm-md-code");
          const first = doc.lineAt(from);
          const last = doc.lineAt(to);
          const closed = children(node, "CodeMark").length > 1 && last.number > first.number;
          if (selected(state, from, to) || last.number - first.number < (closed ? 2 : 1)) {
            lineClass(first.from, "cm-v-dim-line cm-md-code-first");
            lineClass(last.from, closed ? "cm-v-dim-line cm-md-code-last" : "cm-md-code-last");
            return;
          }
          lineClass(first.from, "cm-md-code-first");
          hide(first.from, first.to + 1);
          blocks.push([first.from, first.to + 1]);
          if (closed) {
            const before = doc.line(last.number - 1);
            // The box's last line on screen starts where its last line of code does, or at the fence with one line.
            lineClass(before.number === first.number + 1 ? first.from : before.from, "cm-md-code-last");
            hide(before.to, last.to);
            blocks.push([before.to, last.to]);
          } else lineClass(last.from, "cm-md-code-last");
          return;
        }
        case "CodeBlock":
          lineClasses(from, to, "cm-v-verbatim cm-md-code");
          lineClass(from, "cm-md-code-first");
          lineClass(to, "cm-md-code-last");
          return;
        case "Paragraph":
          // Its lines flow together as in the preview, but while the cursor is in it (see below).
          if (!selected(state, from, to)) paragraphs.push([from, to]);
          return;
        case "Table": {
          const lines = aloneOnLines(doc, from, to);
          if (selected(state, from, to) || !lines) {
            lineClasses(from, to, "cm-v-verbatim");
            return;
          }
          hide(lines.from, lines.to, new TableWidget(doc.sliceString(lines.from, lines.to)), true);
          blocks.push([lines.from, lines.to]);
          // Its math is drawn in the table.
          excluded.push([lines.from, lines.to]);
          return false;
        }
        case "TableDelimiter":
          mark(from, to, "cm-md-pipe");
          return;
      }
    },
  });

  excluded.sort((a, b) => a[0] - b[0]);

  // A blank line between blocks is as tall as the preview's space between them, not a whole line; not so in code.
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (line.text.trim() === "" && !excluded.some(([a, b]) => a < line.from && b > line.to)) lineClass(line.from, "cm-md-blank");
  }
  for (const math of mathRanges(doc.toString(), excluded)) {
    const open = math.display ? 2 : 1;
    if (selected(state, math.from, math.to)) {
      mark(math.from, math.to, "cm-v-math-source");
      if (math.display) decorations.push(Decoration.widget({ widget: new MathPreviewWidget(math.source), block: true, side: 1 }).range(doc.lineAt(math.to).to));
      continue;
    }
    const lines = math.display ? aloneOnLines(doc, math.from, math.to) : null;
    if (lines) hide(lines.from, lines.to, new MathWidget(math.source, true, true, open + (math.from - lines.from)), true);
    else hide(math.from, math.to, new MathWidget(math.source, math.display, false, open));
    blocks.push([math.from, math.to]);
  }

  // A paragraph's line breaks become spaces, but for a hard break (two spaces or a backslash at the line's end), and
  // those next to what is drawn in place of its source (math, an image on a line of its own).
  for (const [from, to] of paragraphs) {
    for (let line = doc.lineAt(from); line.to < to; line = doc.line(line.number + 1)) {
      const next = doc.line(line.number + 1);
      if (/( {2}|\\)$/.test(line.text)) continue;
      const end = next.from + /^[ \t]*/.exec(next.text)![0].length;
      if (blocks.some(([a, b]) => a <= end && b >= line.to)) continue;
      hide(line.to, end, new TextWidget(" ", "", 0));
    }
  }

  return { decorations: Decoration.set(decorations, true), atomic: Decoration.set(atomic, true) };
}

const visualField = StateField.define<Built>({
  create: build,
  update(value, transaction) {
    if (!transaction.docChanged && !transaction.selection && !transaction.effects.some((effect) => effect.is(setChanges))) return value;
    return build(transaction.state);
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).atomic),
  ],
});

/** Visual mode for Markdown. */
export function markdownVisual(readFile: FileReader | null): Extension {
  readImage = readFile;
  return [visualField, EditorView.editorAttributes.of({ class: "cm-visual cm-md" })];
}

// --- Preview ------------------------------------------------------------------------------------------------------

const PLACEHOLDER = /NMMATH(\d+)X/g;

/** The text with its formulas swapped for words marked can't change, and the formulas. */
function protectMath(text: string): { text: string; maths: MathRange[]; original: (offset: number) => number } {
  const maths = mathRanges(text, codeRanges(text));
  let out = "";
  let at = 0;
  const spans: { start: number; length: number; from: number; to: number }[] = [];
  maths.forEach((math, index) => {
    out += text.slice(at, math.from);
    const word = `NMMATH${index}X`;
    spans.push({ start: out.length, length: word.length, from: math.from, to: math.to });
    out += word;
    at = math.to;
  });
  out += text.slice(at);
  const original = (offset: number) => {
    let delta = 0;
    for (const span of spans) {
      if (offset < span.start) break;
      if (offset < span.start + span.length) return span.from;
      delta += span.to - span.from - span.length;
    }
    return offset + delta;
  };
  return { text: out, maths, original };
}

/** The top-level blocks of Markdown, each with the 1-based line of the source it starts on. */
function splitBlocks(source: string): { tokens: TokensList; blocks: { token: Token; line: number }[]; maths: MathRange[] } {
  const protectedText = protectMath(source);
  const tokens = marked.lexer(protectedText.text, { gfm: true, breaks: false });
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (offset: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const blocks: { token: Token; line: number }[] = [];
  let offset = 0;
  for (const token of tokens) {
    if (token.type !== "space") {
      // Leading blank lines belong to the token's raw text in some cases; the block starts at its first non-blank line.
      const lead = /^\s*/.exec(token.raw)![0].length;
      blocks.push({ token, line: lineOf(protectedText.original(offset + lead)) });
    }
    offset += token.raw.length;
  }
  return { tokens, blocks, maths: protectedText.maths };
}

/** The 1-based source line each top-level block of the Markdown starts on. */
export function blockLines(source: string): number[] {
  return splitBlocks(source).blocks.map((block) => block.line);
}

/** The rendered preview shown in place of the PDF for a Markdown file. */
export class MarkdownPreview {
  readonly element = document.createElement("div");
  private urls = new Map<string, Promise<string | null>>();
  private resolved = new Map<string, string>();

  constructor(private readFile: FileReader | null) {
    this.element.className = "md-preview";
    // Nothing opens inside the frame: a link is only shown.
    this.element.addEventListener("click", (event) => {
      if ((event.target as Element | null)?.closest("a")) event.preventDefault();
    });
  }

  /** Renders text; the caller debounces. The scroll position stays. */
  show(text: string): void {
    const { tokens, blocks, maths } = splitBlocks(text);
    const html = blocks
      .map(({ token, line }) => {
        const part = Object.assign([token], { links: tokens.links }) as unknown as TokensList;
        return `<div class="md-block" data-line="${line}">${marked.parser(part, { gfm: true, breaks: false })}</div>`;
      })
      .join("\n");
    const clean = DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "form"], FORBID_ATTR: ["style"] });
    const template = document.createElement("template");
    template.innerHTML = clean;
    this.drawMath(template.content, maths);
    for (const input of template.content.querySelectorAll("input")) input.disabled = true;
    const used = new Set<string>();
    for (const image of template.content.querySelectorAll("img")) this.loadImage(image, used);
    const scroll = this.element.scrollTop;
    this.element.replaceChildren(template.content);
    this.element.scrollTop = scroll;
    for (const [path, url] of this.resolved) {
      if (used.has(path)) continue;
      URL.revokeObjectURL(url);
      this.resolved.delete(path);
      this.urls.delete(path);
    }
  }

  /**
   * The scroll offset that shows a place in the source at the top: a 1-based line, with a fraction for how far into it.
   * Between the source lines blocks start on, it goes as far between the blocks.
   */
  offsetOfLine(position: number): number | null {
    const blocks = [...this.element.querySelectorAll<HTMLElement>(":scope > .md-block")];
    if (blocks.length === 0) return null;
    const base = this.element.getBoundingClientRect().top - this.element.scrollTop;
    const topOf = (block: HTMLElement) => block.getBoundingClientRect().top - base;
    let index = blocks.findLastIndex((block) => Number(block.dataset.line) <= position);
    if (index === -1) return 0;
    const block = blocks[index]!;
    const next = blocks[index + 1];
    const from = Number(block.dataset.line);
    const to = next ? Number(next.dataset.line) : null;
    const end = next ? topOf(next) : this.element.scrollHeight;
    const share = to !== null && to > from ? Math.min(1, (position - from) / (to - from)) : 0;
    return topOf(block) + share * (end - topOf(block)) - 8;
  }

  /** How far the preview scrolls, at most. */
  get scrollRange(): number {
    return this.element.scrollHeight - this.element.clientHeight;
  }

  /** Scrolls the preview to show the block that comes from this 1-based source line, roughly. */
  scrollToLine(line: number): void {
    let target: HTMLElement | null = null;
    for (const block of this.element.querySelectorAll<HTMLElement>(":scope > .md-block")) {
      if (Number(block.dataset.line) > line) break;
      target = block;
    }
    if (!target) return;
    const top = target.getBoundingClientRect().top - this.element.getBoundingClientRect().top + this.element.scrollTop;
    this.element.scrollTop = Math.max(0, top - 8);
  }

  /** Puts KaTeX's drawing of each formula where its placeholder word is. */
  private drawMath(root: DocumentFragment, maths: MathRange[]) {
    if (maths.length === 0) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (PLACEHOLDER.test((node as Text).data)) nodes.push(node as Text);
    PLACEHOLDER.lastIndex = 0;
    for (const node of nodes) {
      const parts = node.data.split(/NMMATH\d+X/);
      const numbers = [...node.data.matchAll(PLACEHOLDER)].map((match) => Number(match[1]));
      const fragment = document.createDocumentFragment();
      parts.forEach((part, index) => {
        if (part) fragment.append(part);
        const math = maths[numbers[index] ?? -1];
        if (!math) return;
        const span = document.createElement(math.display ? "div" : "span");
        span.className = math.display ? "md-math md-math-display" : "md-math";
        renderMath(span, math.source, math.display);
        fragment.append(span);
      });
      node.replaceWith(fragment);
    }
  }

  /** Points a project image at a blob URL; images from the web can't load here and keep their alt text. */
  private loadImage(image: HTMLImageElement, used: Set<string>) {
    const path = localPath(image.getAttribute("src") ?? "");
    if (path === null || path === "") {
      image.removeAttribute("src");
      image.classList.add("md-image-missing");
      return;
    }
    used.add(path);
    const known = this.resolved.get(path);
    if (known) {
      image.src = known;
      return;
    }
    image.removeAttribute("src");
    let loading = this.urls.get(path);
    if (!loading) {
      loading = this.readFile
        ? this.readFile(path).then((blob) => URL.createObjectURL(/\.svg$/i.test(path) ? new Blob([blob], { type: "image/svg+xml" }) : blob), () => null)
        : Promise.resolve(null);
      this.urls.set(path, loading);
    }
    loading.then((url) => {
      if (url) {
        if (!this.resolved.has(path)) this.resolved.set(path, url);
        else if (this.resolved.get(path) !== url) URL.revokeObjectURL(url);
        image.src = this.resolved.get(path)!;
      } else image.classList.add("md-image-missing");
    });
  }
}
