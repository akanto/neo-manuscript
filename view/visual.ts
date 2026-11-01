import { EditorState, RangeSet, StateEffect, StateField, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import katex from "katex";
import { SECTION_LEVELS } from "../core/latex.ts";
import { macrosOf, scan, type Span, type Token } from "./scan.ts";

/**
 * Visual mode: the same text as Source mode, drawn as the document would look. Markup is hidden or replaced by what it
 * means (a heading, bold text, a rendered formula, a bullet), and shows again wherever the cursor or the selection is,
 * so that every key edits the real source.
 */

/** How the view reads a file next to the document, for \includegraphics. */
export type FileReader = (path: string) => Promise<Blob>;
/** Draws the first page of a PDF figure, for \includegraphics of a .pdf. */
export type PdfDrawer = (blob: Blob, width: number) => Promise<HTMLCanvasElement>;

interface Services {
  readFile: FileReader | null;
  drawPdf: PdfDrawer | null;
}

let services: Services = { readFile: null, drawPdf: null };

/** What the last build typeset each citation as, for keys of a .bib file, which the text has no \bibitem for. */
let builtCitations = new Map<string, string>();

/** Takes the citations of a build; says whether they changed, so the caller knows to redraw. */
export function setCitations(citations: Record<string, string> | undefined): boolean {
  const next = new Map(Object.entries(citations ?? {}));
  if (next.size === builtCitations.size && [...next].every(([key, label]) => builtCitations.get(key) === label)) return false;
  builtCitations = next;
  return true;
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
  constructor(readonly text: string, readonly className: string, enter = 0, readonly title = "") {
    super(enter);
  }
  override eq(other: TextWidget) {
    return other.text === this.text && other.className === this.className && other.enter === this.enter && other.title === this.title;
  }
  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.className = this.className;
    span.textContent = this.text;
    if (this.title) span.title = this.title;
    return this.clickable(view, span);
  }
}

class MathWidget extends SourceWidget {
  constructor(readonly source: string, readonly display: boolean, readonly macros: Record<string, string>, readonly block: boolean, enter: number) {
    super(enter);
  }
  override eq(other: MathWidget) {
    return other.source === this.source && other.display === this.display && other.block === this.block && other.enter === this.enter && sameMacros(other.macros, this.macros);
  }
  toDOM(view: EditorView) {
    const element = document.createElement(this.block ? "div" : "span");
    element.className = this.display ? "cm-v-math cm-v-math-display" : "cm-v-math";
    renderMath(element, this.source, this.display, this.macros);
    return this.clickable(view, element);
  }
}

/** A formula as KaTeX draws it, under the source while it is being edited. */
class MathPreviewWidget extends WidgetType {
  constructor(readonly source: string, readonly macros: Record<string, string>) {
    super();
  }
  override eq(other: MathPreviewWidget) {
    return other.source === this.source && sameMacros(other.macros, this.macros);
  }
  toDOM() {
    const element = document.createElement("div");
    element.className = "cm-v-math cm-v-math-display cm-v-math-preview";
    renderMath(element, this.source, true, this.macros);
    return element;
  }
}

class ImageWidget extends SourceWidget {
  constructor(readonly path: string, readonly block: boolean, enter: number) {
    super(enter);
  }
  override eq(other: ImageWidget) {
    return other.path === this.path && other.block === this.block && other.enter === this.enter;
  }
  toDOM(view: EditorView) {
    const element = document.createElement(this.block ? "div" : "span");
    element.className = "cm-v-figure";
    const note = (text: string) => {
      element.textContent = text;
      element.classList.add("cm-v-figure-missing");
    };
    note(`🖼 ${this.path}`);
    loadFigure(this.path).then(
      (figure) => {
        element.textContent = "";
        element.classList.remove("cm-v-figure-missing");
        element.append(figure);
      },
      () => note(`🖼 ${this.path} (not found)`),
    );
    return this.clickable(view, element);
  }
}

class TitleWidget extends SourceWidget {
  constructor(readonly title: string, readonly author: string, readonly date: string) {
    super(0);
  }
  override eq(other: TitleWidget) {
    return other.title === this.title && other.author === this.author && other.date === this.date;
  }
  toDOM(view: EditorView) {
    const element = document.createElement("div");
    element.className = "cm-v-titleblock";
    for (const [text, className] of [[this.title, "cm-v-title"], [this.author, "cm-v-author"], [this.date, "cm-v-date"]] as const) {
      if (!text) continue;
      const line = document.createElement("div");
      line.className = className;
      line.textContent = text;
      element.append(line);
    }
    if (!element.childElementCount) element.textContent = "\\maketitle";
    return this.clickable(view, element);
  }
}

class PreambleWidget extends SourceWidget {
  constructor(readonly lines: number, readonly documentClass: string) {
    super(0);
  }
  override eq(other: PreambleWidget) {
    return other.lines === this.lines && other.documentClass === this.documentClass;
  }
  toDOM(view: EditorView) {
    const element = document.createElement("div");
    element.className = "cm-v-preamble";
    element.textContent = `Preamble · ${this.documentClass ? `${this.documentClass} · ` : ""}${this.lines} lines — click to edit`;
    return this.clickable(view, element);
  }
}

const sameMacros = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

/** KaTeX supports these environments as they are; the others are drawn from their content. */
const KATEX_ENVS = new Set(["equation", "equation*", "align", "align*", "gather", "gather*", "alignat", "alignat*"]);

function renderMath(element: HTMLElement, source: string, display: boolean, macros: Record<string, string>) {
  const cleaned = source.replace(/\\label\s*\{[^}]*\}/g, "").replace(/\\(nonumber|notag)\b/g, "");
  try {
    katex.render(cleaned, element, { displayMode: display, throwOnError: false, strict: "ignore", macros: { ...macros }, trust: false });
  } catch {
    element.textContent = source;
    element.classList.add("cm-v-math-error");
  }
}

const figureCache = new Map<string, Promise<HTMLElement>>();

function loadFigure(path: string): Promise<HTMLElement> {
  const known = figureCache.get(path);
  if (known) return known.then((element) => element.cloneNode(true) as HTMLElement).then((copy) => copyCanvas(known, copy));
  const { readFile, drawPdf } = services;
  if (!readFile) return Promise.reject(new Error("Files can't be read from here."));
  const candidates = /\.[A-Za-z]{2,4}$/.test(path) ? [path] : [".pdf", ".png", ".jpg", ".jpeg", ".svg"].map((extension) => path + extension);
  const loading = (async () => {
    for (const candidate of candidates) {
      const blob = await readFile(candidate).catch(() => null);
      if (!blob) continue;
      if (/\.pdf$/i.test(candidate)) {
        if (!drawPdf) continue;
        return drawPdf(blob, 640);
      }
      const image = document.createElement("img");
      const type = /\.svg$/i.test(candidate) ? "image/svg+xml" : blob.type;
      image.src = URL.createObjectURL(type === blob.type ? blob : new Blob([blob], { type }));
      return image;
    }
    throw new Error(`${path} not found`);
  })();
  figureCache.set(path, loading);
  loading.catch(() => figureCache.delete(path));
  return loading;
}

/** A cloned canvas comes out blank, so it gets the drawing of the cached one. */
async function copyCanvas(original: Promise<HTMLElement>, copy: HTMLElement): Promise<HTMLElement> {
  const source = await original;
  if (source instanceof HTMLCanvasElement && copy instanceof HTMLCanvasElement) copy.getContext("2d")?.drawImage(source, 0, 0);
  return copy;
}

/** Forgets the figures read, so the next drawing reads them again (after a build, or when the user asks). */
export function forgetFigures() {
  figureCache.clear();
}

// --- Reading the document -----------------------------------------------------------------------------------------

/** LaTeX as plain words, for the title block: commands dropped, braces gone. */
function plainText(latex: string): string {
  return latex
    .replace(/(^|[^\\])%.*$/gm, "$1")
    .replace(/\\thanks\s*\{[^}]*\}/g, "")
    .replace(/\\today\b/g, new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }))
    .replace(/\\\\(\[[^\]]*\])?/g, " · ")
    .replace(/\\and\b/g, " · ")
    .replace(/\\(LaTeX|TeX)\b\s*(\{\})?/g, "$1")
    .replace(/~/g, " ")
    .replace(/\\[A-Za-z@]+\*?/g, "")
    .replace(/\\(.)/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SECTION_CLASS: Record<string, string> = {
  part: "cm-v-h0",
  chapter: "cm-v-h0",
  section: "cm-v-h1",
  subsection: "cm-v-h2",
  subsubsection: "cm-v-h3",
  paragraph: "cm-v-h4",
  subparagraph: "cm-v-h4",
};

const MARK_CLASS: Record<string, string> = {
  textbf: "cm-v-bold",
  textit: "cm-v-italic",
  emph: "cm-v-italic",
  textsl: "cm-v-italic",
  underline: "cm-v-underline",
  texttt: "cm-v-mono",
  textsc: "cm-v-smallcaps",
  textsf: "cm-v-sans",
  textrm: "",
  textup: "",
  textmd: "",
  mbox: "",
  url: "cm-v-link",
};

const SYMBOLS: Record<string, string> = {
  ldots: "…",
  dots: "…",
  textbackslash: "\\",
  "%": "%",
  "&": "&",
  $: "$",
  "#": "#",
  _: "_",
  "{": "{",
  "}": "}",
  ",": " ",
  "\\": "↵",
  S: "§",
  P: "¶",
  copyright: "©",
  textregistered: "®",
  texttrademark: "™",
  textendash: "–",
  textemdash: "—",
  quad: " ",
  qquad: "  ",
};
const LOGOS = new Set(["LaTeX", "TeX", "LaTeXe", "BibTeX"]);
const DIM_COMMANDS = new Set(["noindent", "centering", "newpage", "clearpage", "cleardoublepage", "medskip", "bigskip", "smallskip", "hfill", "vfill", "tableofcontents", "listoffigures", "listoftables", "raggedright", "raggedleft", "par", "linebreak", "pagebreak", "appendix", "printbibliography", "vspace", "hspace", "usepackage", "newcommand", "renewcommand", "providecommand", "DeclareMathOperator", "bibliography", "bibliographystyle", "input", "include"]);
const LISTS = new Set(["itemize", "enumerate", "description"]);
const FLOAT_LABEL: Record<string, string> = { figure: "Figure", "figure*": "Figure", table: "Table", "table*": "Table" };
/** Environments that print a heading of their own. */
const HEADED: Record<string, string> = { abstract: "Abstract", thebibliography: "References" };
const BLOCK_CLASS: Record<string, string> = { center: "cm-v-center", quote: "cm-v-quote", quotation: "cm-v-quote", verse: "cm-v-quote", abstract: "cm-v-abstract", flushright: "cm-v-right" };

interface Built {
  decorations: DecorationSet;
  atomic: RangeSet<Decoration>;
}

interface Scanned {
  tokens: Token[];
  macros: Record<string, string>;
}

function scanned(state: EditorState): Scanned {
  const text = state.doc.toString();
  const tokens = scan(text);
  return { tokens, macros: macrosOf(text, tokens) };
}

/** Whether the selection is on `from..to`: anywhere inside, or also at its ends when `ends`. */
function selected(state: EditorState, from: number, to: number, ends: boolean): boolean {
  return state.selection.ranges.some((range) => (ends ? range.from <= to && range.to >= from : range.from < to && range.to > from) || (range.empty && (ends ? range.head >= from && range.head <= to : range.head > from && range.head < to)));
}

/** Whether `from..to` is all that is on its lines but spaces, so it can be drawn as a block of its own. */
function aloneOnLines(doc: Text, from: number, to: number): { from: number; to: number } | null {
  const first = doc.lineAt(from);
  const last = doc.lineAt(to);
  if (doc.sliceString(first.from, from).trim() !== "" || doc.sliceString(to, last.to).trim() !== "") return null;
  return { from: first.from, to: last.to };
}

function build(state: EditorState, { tokens, macros }: Scanned): Built {
  const doc = state.doc;
  const text = (span: Span) => doc.sliceString(span.from, span.to);
  const decorations: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const hide = (from: number, to: number, widget?: WidgetType, block = false) => {
    if (from >= to && !widget) return;
    const decoration = Decoration.replace(widget ? { widget, block } : {});
    decorations.push(decoration.range(from, to));
    atomic.push(decoration.range(from, to));
  };
  const mark = (from: number, to: number, className: string) => {
    if (from < to && className) decorations.push(Decoration.mark({ class: className }).range(from, to));
  };
  const lineClass = (position: number, className: string) => decorations.push(Decoration.line({ class: className }).range(doc.lineAt(position).from));

  // The title block's parts, which the preamble holds.
  const metadata: Record<"title" | "author" | "date", string> = { title: "", author: "", date: "" };
  for (const token of tokens) {
    if (token.kind === "command" && (token.name === "title" || token.name === "author" || token.name === "date") && token.args[0]) metadata[token.name] = plainText(text(token.args[0]));
  }

  // Numbers for sections, equations, figures, tables and bibliography items, so references can show them.
  const labels = new Map<string, string>();
  const bibitems = new Map<string, number>();
  {
    const counters = [0, 0, 0, 0];
    let equation = 0;
    let lastNumbered = "";
    let bib = 0;
    // Figures and tables count apart (figure* with figure), and a label inside one names its number.
    const floats: Record<string, number> = { Figure: 0, Table: 0 };
    const openFloats: string[] = [];
    const hasChapters = tokens.some((token) => token.kind === "command" && token.name === "chapter");
    for (const token of tokens) {
      if (token.kind === "command" && SECTION_LEVELS.includes(token.name as never) && !token.star && token.args[0]) {
        const depth = (hasChapters ? ["chapter", "section", "subsection", "subsubsection"] : ["section", "subsection", "subsubsection"]).indexOf(token.name);
        if (depth !== -1) {
          counters[depth]!++;
          counters.fill(0, depth + 1);
          lastNumbered = counters.slice(0, depth + 1).join(".");
          if (hasChapters && depth === 0) floats.Figure = floats.Table = 0;
        }
      } else if (token.kind === "begin" && FLOAT_LABEL[token.name]) {
        const kind = FLOAT_LABEL[token.name]!;
        floats[kind]!++;
        openFloats.push(hasChapters ? `${counters[0]}.${floats[kind]}` : String(floats[kind]));
      } else if (token.kind === "end" && FLOAT_LABEL[token.name]) openFloats.pop();
      else if (token.kind === "math" && token.env && !token.env.endsWith("*") && token.env !== "displaymath" && token.env !== "math") {
        equation++;
        const label = /\\label\s*\{([^}]*)\}/.exec(text(token.inner));
        if (label) labels.set(label[1]!, String(equation));
      } else if (token.kind === "command" && token.name === "label" && token.args[0]) labels.set(text(token.args[0]), openFloats.at(-1) ?? lastNumbered);
      else if (token.kind === "command" && token.name === "bibitem" && token.args[0]) bibitems.set(text(token.args[0]).trim(), ++bib);
    }
  }

  const beginDocument = tokens.find((token) => token.kind === "begin" && token.name === "document");
  const preambleEnd = beginDocument ? doc.lineAt(beginDocument.to).to : -1;
  const preambleShown = !beginDocument || selected(state, 0, preambleEnd, true);
  if (beginDocument && !preambleShown) {
    const documentClass = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/.exec(doc.sliceString(0, beginDocument.from))?.[1] ?? "";
    hide(0, preambleEnd, new PreambleWidget(doc.lineAt(preambleEnd).number, documentClass), true);
  }

  const environments: { name: string; begin: Token; item: number }[] = [];
  const counters = [0, 0, 0, 0];
  let footnotes = 0;
  const hasChapters = tokens.some((token) => token.kind === "command" && token.name === "chapter");

  for (const token of tokens) {
    if (!preambleShown && token.from < preambleEnd) continue;
    const shown = selected(state, token.from, token.to, token.kind === "math");
    switch (token.kind) {
      case "comment":
        mark(token.from, token.to, "cm-v-comment");
        break;

      case "special":
        if (!shown) hide(token.from, token.to, new TextWidget(token.text, "cm-v-char", token.to - token.from));
        break;

      case "verbatim":
        for (let line = doc.lineAt(token.from).number; line <= doc.lineAt(token.to).number; line++) lineClass(doc.line(line).from, "cm-v-verbatim");
        break;

      case "math": {
        const source = token.env && KATEX_ENVS.has(token.env) ? doc.sliceString(token.from, token.to) : text(token.inner);
        const enter = token.inner.from - token.from;
        if (shown) {
          mark(token.from, token.to, "cm-v-math-source");
          if (token.display) decorations.push(Decoration.widget({ widget: new MathPreviewWidget(source, macros), block: true, side: 1 }).range(doc.lineAt(token.to).to));
          break;
        }
        const lines = token.display ? aloneOnLines(doc, token.from, token.to) : null;
        if (lines) hide(lines.from, lines.to, new MathWidget(source, true, macros, true, enter + (token.from - lines.from)), true);
        else hide(token.from, token.to, new MathWidget(source, token.display, macros, false, enter));
        break;
      }

      case "begin": {
        const list = LISTS.has(token.name);
        environments.push({ name: token.name, begin: token, item: 0 });
        if (token.name === "document") break;
        // The environment's own arguments, as in \begin{thebibliography}{9} or \begin{tabular}{ll}, go with it.
        const argsEnd = token.to + (/^(\s*(\[[^\]\n]*\]|\{[^{}\n]*\}))*/.exec(doc.sliceString(token.to, Math.min(doc.length, token.to + 200)))?.[0].length ?? 0);
        const lines = aloneOnLines(doc, token.from, argsEnd);
        if (shown || !lines) {
          mark(token.from, token.to, "cm-v-env");
          break;
        }
        const heading = HEADED[token.name];
        const label = heading ?? FLOAT_LABEL[token.name] ?? (list ? "" : token.name);
        hide(lines.from, lines.to, new TextWidget(label, heading ? "cm-v-env-heading" : "cm-v-envtag", token.from - lines.from + 1));
        lineClass(token.from, label ? "cm-v-envline" : "cm-v-collapsed");
        break;
      }

      case "end": {
        const open = environments.findLastIndex((env) => env.name === token.name);
        const env = open === -1 ? null : environments.splice(open)[0]!;
        if (env) {
          // The lines inside the environment: indented in lists, centred in center, and so on.
          const first = doc.lineAt(env.begin.to).number + 1;
          const last = doc.lineAt(token.from).number - 1;
          const depth = environments.filter((outer) => LISTS.has(outer.name)).length + 1;
          const className = LISTS.has(token.name) ? `cm-v-list cm-v-depth-${Math.min(depth, 4)}` : BLOCK_CLASS[token.name];
          if (className) for (let line = first; line <= last; line++) lineClass(doc.line(line).from, className);
        }
        if (token.name === "document") {
          lineClass(token.from, "cm-v-dim-line");
          break;
        }
        const lines = aloneOnLines(doc, token.from, token.to);
        if (shown || !lines) mark(token.from, token.to, "cm-v-env");
        else {
          hide(lines.from, lines.to, new TextWidget("", "cm-v-envtag", token.from - lines.from + 1));
          lineClass(token.from, "cm-v-collapsed");
        }
        break;
      }

      case "command": {
        const { name, args } = token;
        const arg = args[0];
        if (SECTION_CLASS[name] && arg) {
          lineClass(token.from, SECTION_CLASS[name]);
          if (shown) {
            mark(token.from, arg.from, "cm-v-markup");
            mark(arg.to, token.to, "cm-v-markup");
            break;
          }
          const depth = (hasChapters ? ["chapter", "section", "subsection", "subsubsection"] : ["section", "subsection", "subsubsection"]).indexOf(name);
          let number = "";
          if (depth !== -1 && !token.star) {
            counters[depth]!++;
            counters.fill(0, depth + 1);
            number = `${counters.slice(0, depth + 1).join(".")} `;
          }
          hide(token.from, arg.from, number ? new TextWidget(number, "cm-v-secnum", arg.from - token.from) : undefined);
          hide(arg.to, token.to);
          break;
        }
        if (name in MARK_CLASS && arg) {
          mark(arg.from, arg.to, MARK_CLASS[name]!);
          if (shown) {
            mark(token.from, arg.from, "cm-v-markup");
            mark(arg.to, token.to, "cm-v-markup");
          } else {
            hide(token.from, arg.from);
            hide(arg.to, token.to);
          }
          break;
        }
        if (name === "href" && args.length === 2) {
          mark(args[1]!.from, args[1]!.to, "cm-v-link");
          if (!shown) {
            hide(token.from, args[1]!.from);
            hide(args[1]!.to, token.to);
          }
          break;
        }
        if ((name === "footnote" || name === "caption" || name === "thanks") && arg) {
          const float = environments.findLast((env) => FLOAT_LABEL[env.name]);
          const prefix = name === "footnote" ? `${++footnotes}` : name === "caption" ? `${float ? FLOAT_LABEL[float.name] : "Caption"}: ` : "*";
          mark(arg.from, arg.to, name === "caption" ? "cm-v-caption" : "cm-v-footnote");
          if (shown) {
            mark(token.from, arg.from, "cm-v-markup");
            mark(arg.to, token.to, "cm-v-markup");
          } else {
            hide(token.from, arg.from, new TextWidget(prefix, name === "caption" ? "cm-v-caption-label" : "cm-v-footnote-mark", arg.from - token.from));
            hide(arg.to, token.to);
          }
          break;
        }
        if (shown) {
          mark(token.from, token.to, "cm-v-markup");
          break;
        }
        if (name === "label" && arg) hide(token.from, token.to, new TextWidget(text(arg), "cm-v-chip cm-v-label", 0, "\\label"));
        else if (/^(ref|eqref|autoref|pageref|nameref|cref|Cref)$/.test(name) && arg) {
          const key = text(arg).trim();
          const resolved = key.split(",").map((part) => labels.get(part.trim()) || part.trim()).join(", ");
          hide(token.from, token.to, new TextWidget(name === "eqref" ? `(${resolved})` : resolved, labels.has(key) ? "cm-v-chip cm-v-ref" : "cm-v-chip cm-v-ref cm-v-unresolved", 0, `\\${name}{${key}}`));
        } else if (/cite/.test(name) && arg) {
          const keys = text(arg).split(",").map((key) => key.trim());
          const shownKeys = keys.map((key) => bibitems.get(key) ?? builtCitations.get(key) ?? key).join(", ");
          const resolved = keys.every((key) => bibitems.has(key) || builtCitations.has(key));
          hide(token.from, token.to, new TextWidget(name === "citeauthor" ? shownKeys : `[${shownKeys}]`, resolved ? "cm-v-chip cm-v-cite" : "cm-v-chip cm-v-cite cm-v-unresolved", 0, keys.join(", ")));
        } else if (name === "includegraphics" && arg) {
          const lines = aloneOnLines(doc, token.from, token.to);
          if (lines) hide(lines.from, lines.to, new ImageWidget(text(arg).trim(), true, token.from - lines.from), true);
          else hide(token.from, token.to, new ImageWidget(text(arg).trim(), false, 0));
        } else if (name === "maketitle") {
          const lines = aloneOnLines(doc, token.from, token.to);
          if (lines) hide(lines.from, lines.to, new TitleWidget(metadata.title, metadata.author, metadata.date), true);
          else hide(token.from, token.to, new TitleWidget(metadata.title, metadata.author, metadata.date));
        } else if (name === "item") {
          const list = environments.findLast((env) => LISTS.has(env.name));
          const label = token.optional ? plainText(text(token.optional)) : list?.name === "enumerate" ? `${++list.item}.` : "•";
          const end = doc.sliceString(token.to, token.to + 1) === " " ? token.to + 1 : token.to;
          // The indentation before \item goes too: the list's lines are indented by their depth instead.
          const line = doc.lineAt(token.from);
          const start = doc.sliceString(line.from, token.from).trim() === "" ? line.from : token.from;
          hide(start, end, new TextWidget(label, list?.name === "description" ? "cm-v-bullet cm-v-bold" : "cm-v-bullet", end - start));
        } else if (name === "bibitem" && arg) {
          hide(token.from, token.to, new TextWidget(`[${bibitems.get(text(arg).trim()) ?? "?"}]`, "cm-v-bullet", token.to - token.from));
        } else if (LOGOS.has(name)) {
          const end = doc.sliceString(token.to, token.to + 2) === "{}" ? token.to + 2 : token.to;
          hide(token.from, end, new TextWidget(name === "LaTeXe" ? "LaTeX2ε" : name, `cm-v-logo cm-v-logo-${name}`, end - token.from));
        } else if (name in SYMBOLS) hide(token.from, token.to, new TextWidget(SYMBOLS[name]!, name === "\\" ? "cm-v-newline" : "cm-v-char", token.to - token.from));
        else if (name === "today") hide(token.from, token.to, new TextWidget(plainText("\\today"), "cm-v-char", token.to - token.from));
        else mark(token.from, token.to, DIM_COMMANDS.has(name) ? "cm-v-dim" : "cm-v-command");
        break;
      }
    }
  }
  return { decorations: Decoration.set(decorations, true), atomic: Decoration.set(atomic, true) };
}

/** Asks the decorations to be drawn again, as when the figures were read anew after a build. */
export const redraw = StateEffect.define<null>();

const visualField = StateField.define<{ scanned: Scanned; built: Built }>({
  create(state) {
    const read = scanned(state);
    return { scanned: read, built: build(state, read) };
  },
  update(value, transaction) {
    const read = transaction.docChanged ? scanned(transaction.state) : value.scanned;
    if (!transaction.docChanged && !transaction.selection && !transaction.effects.some((effect) => effect.is(redraw))) return value;
    return { scanned: read, built: build(transaction.state, read) };
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.built.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).built.atomic),
  ],
});

export function visualMode(readFile: FileReader | null, drawPdf: PdfDrawer | null): Extension {
  services = { readFile, drawPdf };
  return [visualField, EditorView.editorAttributes.of({ class: "cm-visual" })];
}
