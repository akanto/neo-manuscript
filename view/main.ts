import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Author, DocumentState, HostBridge, TaskState } from "../core/host-api.ts";
import { BUILD_FOLDER, reportNamedIn, type BuildReport, type Problem } from "../core/build.ts";
import type { TexDocument } from "../core/document.ts";
import { bold, code, createEditor, flashRanges, insertList, insertMath, italic, setHeading, setProblems, type Editor, type Language, type Mode } from "./editor.ts";
import { MarkdownPreview, mdBold, mdCode, mdHeading, mdItalic, mdList, mdMath } from "./markdown.ts";
import { ChatPanel } from "./chat.ts";
import { FileTree } from "./files.ts";
import { drawFirstPage, PdfViewer, type PdfPoint, type PdfSelection } from "./pdf.ts";
import { lineForPdfText } from "./pdf-sync.ts";
import css from "./styles.css" with { type: "text" };
import { DocumentSync, fromHost } from "./sync.ts";
import { commentStart } from "../core/latex.ts";
import { fileOfTag, lineForPlace, placeForLine, readSynctex, sourceForPlace, tagOf, type Synctex } from "./synctex.ts";
import { isTextFile, kindOf, looksLikeMarkdown, type ProjectState } from "../core/project.ts";
import { unpackThesaurus, type Thesaurus } from "./thesaurus.ts";
import { forgetFigures, redraw, setCitations } from "./visual.ts";
import packedThesaurus from "thesaurus:packed";
import katexCss from "katex/dist/katex.min.css";

const AUTO_COMPILE_MS = 1200;
/** How long the text stays still before the Markdown preview draws it again. */
const PREVIEW_MS = 150;
const AUTHOR: Record<Author["kind"], string> = { agent: "Agent", you: "You", outside: "Outside the editor" };

function element<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(node, rest);
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...children);
  return node;
}

function button(label: string, title: string, onClick: () => void, className = ""): HTMLButtonElement {
  const node = element("button", { type: "button", title, className, innerHTML: label });
  node.addEventListener("mousedown", (event) => event.preventDefault());
  node.addEventListener("click", onClick);
  return node;
}

/** Builds the editor and the PDF preview into the page, and keeps them with the host's document. */
export function startView(host: HostBridge<TexDocument>) {
  const storage: Storage | null = host.storage ?? null;
  const remember = (key: string, value: string) => {
    try {
      storage?.setItem(key, value);
    } catch {
      // The app's storage is full; the setting just isn't kept.
    }
  };
  const recall = (key: string) => storage?.getItem(key) ?? null;

  // --- Page ---------------------------------------------------------------------------------------------------------

  for (const text of [katexCss, css]) {
    const style = document.createElement("style");
    style.textContent = text;
    document.head.append(style);
  }

  const app = element("div", { className: "app" });
  const toolbar = element("header", { className: "toolbar" });
  const panes = element("div", { className: "panes" });
  const editorPane = element("section", { className: "editor-pane" });
  const divider = element("div", { className: "divider", title: "Drag to resize" });
  const previewPane = element("section", { className: "preview-pane" });
  const banner = element("div", { className: "banner", hidden: true });
  const workspace = element("div", { className: "workspace" });
  panes.append(editorPane, divider, previewPane);
  workspace.append(panes);
  app.append(toolbar, banner, workspace);
  document.body.append(app);
  editorPane.append(element("div", { className: "loading" }, "Opening the document…"));

  // --- Editor toolbar -----------------------------------------------------------------------------------------------

  let editor: Editor | null = null;
  let sync: DocumentSync | null = null;
  /** The last build's SyncTeX, and the tag it gives the file in the editor; null when the build wrote none. */
  let synctex: { data: Synctex; tag: number } | null = null;
  /** The source file of the last build, as its report names it. */
  let builtSource: string | null = null;
  /**
   * The folder the last build ran in, as a prefix ("" for the project's top, else "paper/"): its report names its files
   * from there, and LaTeX names its inputs and figures from there. Mirador's workspace may hold the project in a folder.
   */
  let buildFolder = "";
  const fromBuild = (path: string) => buildFolder + path;
  const inBuild = (path: string) => (path.startsWith(buildFolder) ? path.slice(buildFolder.length) : path);
  let mode: Mode = recall("mode") === "source" ? "source" : "visual";
  /** With a project: its files, and the file in the editor (null for a host of one document, which has no names). */
  let project: ProjectState | null = null;
  let shownFile: string | null = null;
  /** Where the editor was in each file it showed, to come back to it there. */
  const places = new Map<string, { anchor: number; head: number; scrollTop: number }>();
  /** A line to go to once the file it is in opens. */
  let pendingLine: { file: string; line: number } | null = null;
  /** The last build's problems, for marking those of each file the editor opens. */
  let lastProblems: Problem[] = [];
  /** The host's last state, to start the editor again in another language when the file turns out to be Markdown. */
  let lastState: DocumentState<TexDocument> | null = null;
  /** The language of the editor as it was made. */
  let editorLanguage: Language = "latex";
  let markdownTimer: ReturnType<typeof setTimeout> | null = null;

  /** The file in the editor: the one the host says, or, for a host that can't (Mirador), the one its project lists as open. */
  const editingFile = () => shownFile ?? project?.open ?? null;
  /**
   * A Markdown file is edited as Markdown; any other text file as LaTeX. A host that names no file (Mirador, until its
   * listing comes) leaves the text to tell.
   */
  const languageOf = (file: string | null): Language => {
    if (file !== null) return kindOf(file) === "markdown" ? "markdown" : "latex";
    return lastState && looksLikeMarkdown(lastState.document.text) ? "markdown" : "latex";
  };
  const isMarkdown = () => languageOf(editingFile()) === "markdown";

  /** Runs a formatting command on the editor: the LaTeX one, or the Markdown one in a Markdown file. */
  const run = (latex: (view: EditorView) => boolean, markdown: (view: EditorView) => boolean = latex) => () => {
    if (!editor) return;
    (editorLanguage === "markdown" ? markdown : latex)(editor.view);
    editor.view.focus();
  };

  const modeButtons = {
    source: button("Source", "Edit the LaTeX source", () => setMode("source")),
    visual: button("Visual", "Edit the document as it looks", () => setMode("visual")),
  };
  const modeSwitch = element("div", { className: "segmented" }, modeButtons.source, modeButtons.visual);
  const lastChange = element("span", { className: "last-change" });

  const codeButton = button("<code>T</code>", "Typewriter", run(code, mdCode));
  const headingButtons = (["section", "subsection", "subsubsection"] as const).map((level, index) =>
    button(`H${index + 1}`, "", run(setHeading(level), mdHeading((index + 1) as 1 | 2 | 3))),
  );
  const editTools = element(
    "span",
    { className: "edit-tools" },
    modeSwitch,
    element("span", { className: "sep" }),
    button("<b>B</b>", "Bold (⌘B)", run(bold, mdBold)),
    button("<i>I</i>", "Italic (⌘I)", run(italic, mdItalic)),
    codeButton,
    element("span", { className: "sep" }),
    ...headingButtons,
    element("span", { className: "sep" }),
    button("•≡", "Bulleted list", run(insertList("itemize"), mdList(false))),
    button("1.≡", "Numbered list", run(insertList("enumerate"), mdList(true))),
    element("span", { className: "sep" }),
    button("<i>x</i>²", "Inline math (⌘M)", run(insertMath(false), mdMath(false))),
    button("∑", "Display math (⇧⌘M)", run(insertMath(true), mdMath(true))),
  );

  /** The buttons' names in the language of the file in the editor. */
  function nameTools(language: Language) {
    const markdown = language === "markdown";
    codeButton.title = markdown ? "Code" : "Typewriter";
    const names = markdown ? ["Heading 1", "Heading 2", "Heading 3"] : ["Section", "Subsection", "Subsubsection"];
    headingButtons.forEach((heading, index) => (heading.title = names[index]!));
    layoutButtons.pdf.textContent = markdown ? "Preview" : "PDF";
    layoutButtons.pdf.title = markdown ? "Only the preview" : "Only the PDF";
    layoutButtons.split.title = `The editor and the ${markdown ? "preview" : "PDF"} side by side (⌥⌘P)`;
    app.dataset.language = language;
  }

  // --- Layout: the editor, the PDF, or both side by side ------------------------------------------------------------

  type Layout = "editor" | "split" | "pdf";
  const LAYOUTS: Layout[] = ["editor", "split", "pdf"];
  let layout: Layout = LAYOUTS.find((known) => known === recall("layout")) ?? "split";
  const layoutButtons: Record<Layout, HTMLButtonElement> = {
    editor: button("Editor", "Only the editor (⌥⌘P shows the PDF beside it)", () => setLayout("editor")),
    split: button("Split", "The editor and the PDF side by side (⌥⌘P)", () => setLayout("split")),
    pdf: button("PDF", "Only the PDF", () => setLayout("pdf")),
  };
  /** While the PDF is hidden, how the last build went, so a failing build doesn't go unseen. */
  const buildBadge = element("button", { type: "button", className: "build-badge", hidden: true, title: "Show the PDF and the build's problems" });
  buildBadge.addEventListener("click", () => setLayout("split"));

  function setLayout(next: Layout) {
    const keep = keepPlace(layout, next);
    layout = next;
    remember("layout", next);
    app.dataset.layout = next;
    for (const known of LAYOUTS) layoutButtons[known].classList.toggle("on", known === next);
    if (next !== "pdf") editor?.view.requestMeasure();
    if (next !== "editor") drawMarkdown();
    keep?.();
  }

  /**
   * When the editor or the PDF comes into sight in place of the other, it opens where the other one was, as Source and
   * Visual do: the PDF at what the top of the editor typeset, the editor at the line of what is at the top of the PDF.
   */
  function keepPlace(from: Layout, to: Layout): (() => void) | null {
    if (editor && editorLanguage === "markdown") {
      const line = topLine(editor.view);
      return from === "editor" && to !== "editor" ? () => markdownPreview.scrollToLine(line) : null;
    }
    if (!editor || !synctex) return null;
    const { data, tag } = synctex;
    if (from === "editor" && to !== "editor") {
      const place = placeForLine(data, tag, topLine(editor.view));
      return place && (() => viewer.scrollToPlace(place));
    }
    if (from === "pdf" && to !== "pdf") {
      const place = viewer.placeAtTop();
      const line = place && lineForPlace(data, tag, place, printsIn(editor.view));
      const view = editor.view;
      return line === null ? null : () => view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(Math.min(line, view.state.doc.lines)).from, { y: "start", yMargin: 16 }) });
    }
    return null;
  }

  /** Whether a line of the source prints anything: not blank, nor only a comment. */
  const printsIn = (view: EditorView) => (line: number) => {
    const doc = view.state.doc;
    if (line < 1 || line > doc.lines) return false;
    const text = doc.line(line).text;
    return text.slice(0, commentStart(text)).trim() !== "";
  };

  /** The line at the top of the editor. */
  function topLine(view: EditorView): number {
    const top = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
    return view.state.doc.lineAt(view.lineBlockAtHeight(Math.max(0, top)).from).number;
  }

  /** ⌥⌘P: the PDF beside the editor, or away again. */
  function togglePreview() {
    setLayout(layout === "editor" ? "split" : "editor");
  }

  toolbar.append(
    editTools,
    element("span", { className: "grow" }),
    lastChange,
    buildBadge,
    element("div", { className: "segmented layout-switch" }, layoutButtons.editor, layoutButtons.split, layoutButtons.pdf),
  );
  setLayout(layout);

  // --- The chat with the agent, for a host that has one; Ask goes to it ---------------------------------------------

  const chatPanel = host.chat ? new ChatPanel({ chat: host.chat, openLink: (url) => host.chat!.openLink(url) }) : null;
  function showChat(shown: boolean) {
    app.dataset.chat = shown ? "shown" : "hidden";
    remember("chat", app.dataset.chat);
    editor?.view.requestMeasure();
    if (shown) {
      chatPanel?.shown();
      chatPanel?.focus();
    }
  }
  if (chatPanel) {
    // The chat's width, dragged at its left edge.
    const chatDivider = element("div", { className: "chat-divider", title: "Drag to resize the chat" });
    const setChatWidth = (width: number) => {
      const clamped = Math.round(Math.min(Math.max(280, width), Math.max(320, innerWidth * 0.6)));
      app.style.setProperty("--chat-width", `${clamped}px`);
      return clamped;
    };
    setChatWidth(Number(recall("chatWidth")) || 380);
    chatDivider.addEventListener("pointerdown", (event) => {
      chatDivider.setPointerCapture(event.pointerId);
      const right = workspace.getBoundingClientRect().right;
      const move = (moved: PointerEvent) => remember("chatWidth", String(setChatWidth(right - moved.clientX)));
      const up = () => {
        chatDivider.removeEventListener("pointermove", move);
        chatDivider.removeEventListener("pointerup", up);
        editor?.view.requestMeasure();
      };
      chatDivider.addEventListener("pointermove", move);
      chatDivider.addEventListener("pointerup", up);
    });
    workspace.append(chatDivider, chatPanel.element);
    app.dataset.chat = recall("chat") === "shown" ? "shown" : "hidden";
    if (app.dataset.chat === "shown") chatPanel.shown();
    toolbar.append(button("✦ Chat", "Show or hide the chat with the agent (⌘J)", () => showChat(app.dataset.chat !== "shown"), "chat-toggle"));
    document.addEventListener("keydown", (event) => {
      if (event.key === "j" && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        showChat(app.dataset.chat !== "shown");
      }
    });
  }
  /** Sends the agent a message: into the chat, which shows, when the host has one; else the host's own way. */
  const prompt: ((text: string) => Promise<void>) | null = chatPanel
    ? (text) => {
        showChat(true);
        return chatPanel.send(text);
      }
    : host.prompt
      ? (text) => host.prompt!(text)
      : null;

  if (prompt) {
    const ask = element("form", { className: "ask", hidden: true });
    const input = element("input", { type: "text", placeholder: "Ask the agent about the selection…" });
    ask.append(input, element("button", { type: "submit", textContent: "Send" }));
    // What Ask is about: the text selected in the PDF when there is some as Ask opens, else the editor's selection.
    let inPdf: PdfSelection | null = null;
    toolbar.append(button("Ask", "Ask the agent about the selected text, in the editor or in the PDF", () => {
      ask.hidden = !ask.hidden;
      if (ask.hidden) return;
      // Before the input takes the focus, and with it the page's selection.
      inPdf = viewer.selection();
      input.placeholder = inPdf ? "Ask the agent about the text selected in the PDF…" : "Ask the agent about the selection…";
      input.focus();
    }, "ask-toggle"));
    toolbar.append(ask);
    ask.addEventListener("submit", (event) => {
      event.preventDefault();
      const words = input.value.trim();
      if (!words || !editor) return;
      const message = inPdf ? askAboutPdf(editor.view, words, inPdf) : askAboutEditor(editor.view, words);
      void prompt(message).then(() => {
        input.value = "";
        ask.hidden = true;
      }, (error: Error) => showBanner(`The message didn't go: ${error.message}`));
    });
  }

  /** A question about the editor's selection, or about the cursor's line when nothing is selected. */
  function askAboutEditor(view: EditorView, words: string): string {
    const state = view.state;
    const { from, to } = state.selection.main;
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(to).number;
    const where = `${first === last ? `line ${first}` : `lines ${first}–${last}`}${shownFile ? ` of ${shownFile}` : ""}`;
    const quoted = from === to ? state.doc.line(first).text : state.sliceDoc(from, to);
    return `${words}\n\n(At ${where}:)\n\`\`\`${editorLanguage}\n${quoted}\n\`\`\``;
  }

  /** A question about text selected in the PDF: the text as typeset, and the source lines it came from. */
  function askAboutPdf(view: EditorView, words: string, selected: PdfSelection): string {
    const doc = view.state.doc;
    const { from, to, text } = selected;
    const pages = from.page === to.page ? `page ${from.page}` : `pages ${from.page}–${to.page}`;
    const about = `${words}\n\n(About this text on ${pages} of the PDF:)\n> ${text}`;
    const ends = synctex
      ? [lineForPlace(synctex.data, synctex.tag, from, printsIn(view)), lineForPlace(synctex.data, synctex.tag, to, printsIn(view))]
      : [lineForPdfText(doc.toString(), text)];
    const found = ends.filter((line): line is number => line !== null).map((line) => Math.min(line, doc.lines));
    if (found.length === 0) return about;
    const first = Math.min(...found);
    const last = Math.max(...found);
    const where = first === last ? `line ${first}` : `lines ${first}–${last}`;
    const source = view.state.sliceDoc(doc.line(first).from, doc.line(last).to);
    return `${about}\n\n(It comes from ${where} of ${shownFile ?? "the source"}:)\n\`\`\`latex\n${source}\n\`\`\``;
  }

  /** Only a .tex or a Markdown file has a Visual mode; any other text file (a .bib, a .sty) shows as it is. */
  const hasVisual = () => {
    const file = editingFile();
    return file === null || kindOf(file) === "tex" || kindOf(file) === "markdown";
  };
  const modeOfFile = () => (hasVisual() ? mode : "source");

  function setMode(next: Mode) {
    if (hasVisual()) {
      mode = next;
      remember("mode", next);
    }
    const shown = modeOfFile();
    modeButtons.source.classList.toggle("on", shown === "source");
    modeButtons.visual.classList.toggle("on", shown === "visual");
    modeButtons.source.title = editorLanguage === "markdown" ? "Edit the Markdown source" : "Edit the LaTeX source";
    modeButtons.visual.disabled = !hasVisual();
    editor?.setMode(shown);
    editor?.view.focus();
  }
  setMode(mode);

  let thesaurus: Promise<Thesaurus> | null = null;

  /** WordNet, unpacked when the first word is selected: some 140 ms and 10 MB of text that a session may never need. */
  function loadThesaurus(): Promise<Thesaurus> {
    thesaurus ??= unpackThesaurus(packedThesaurus);
    return thesaurus;
  }

  function showBanner(text: string | null) {
    banner.hidden = !text;
    banner.textContent = text ?? "";
  }

  // --- Split --------------------------------------------------------------------------------------------------------

  function setSplit(ratio: number) {
    const clamped = Math.min(0.8, Math.max(0.2, ratio));
    panes.style.setProperty("--split", `${clamped * 100}%`);
    return clamped;
  }
  setSplit(Number(recall("split") ?? 0.5) || 0.5);
  divider.addEventListener("pointerdown", (event) => {
    divider.setPointerCapture(event.pointerId);
    const rect = panes.getBoundingClientRect();
    const vertical = getComputedStyle(panes).flexDirection === "column";
    const move = (moved: PointerEvent) => {
      const ratio = vertical ? (moved.clientY - rect.top) / rect.height : (moved.clientX - rect.left) / rect.width;
      remember("split", String(setSplit(ratio)));
    };
    const up = () => {
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", up);
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", up);
  });

  // --- Preview ------------------------------------------------------------------------------------------------------

  const viewer = new PdfViewer();
  /** In place of the PDF for a Markdown file: the Markdown as it reads. Its images are read beside the file. */
  const markdownPreview = new MarkdownPreview(host.readFile ? (path) => host.readFile!(besideEditingFile(path)) : null);
  let auto = recall("auto") !== "off";
  const compileButton = button("▶ Compile", "Compile the PDF (⌘S or ⌘↵)", () => compileNow(), "primary");
  const autoBox = element("input", { type: "checkbox", checked: auto });
  autoBox.addEventListener("change", () => {
    auto = autoBox.checked;
    remember("auto", auto ? "on" : "off");
    if (auto) wantCompile();
  });
  const buildStatus = element("span", { className: "build-status" });
  const zoomLabel = element("span", { className: "zoom-label" });
  viewer.onZoom = (label) => (zoomLabel.textContent = label);
  const problemsToggle = element("button", { type: "button", className: "problems-toggle", hidden: true });
  const problemsList = element("ul", { className: "problems", hidden: true });
  problemsToggle.addEventListener("click", () => (problemsList.hidden = !problemsList.hidden));
  const placeholder = element("div", { className: "pdf-empty" }, "The PDF shows here once the document compiles.");

  previewPane.append(
    element(
      "div",
      { className: "preview-bar" },
      compileButton,
      element("label", { className: "auto", title: "Compile when the text stops changing" }, autoBox, " Auto"),
      buildStatus,
      problemsToggle,
      element("span", { className: "grow" }),
      button("−", "Zoom out", () => viewer.setZoom("out")),
      zoomLabel,
      button("+", "Zoom in", () => viewer.setZoom("in")),
      button("↔", "Fit width", () => viewer.setZoom({ fit: "width" })),
      button("▭", "Fit page", () => viewer.setZoom({ fit: "page" })),
    ),
    problemsList,
    placeholder,
    viewer.element,
    markdownPreview.element,
  );

  /** Draws the Markdown in the editor in the preview, when it is in sight. */
  function drawMarkdown() {
    if (markdownTimer) clearTimeout(markdownTimer);
    markdownTimer = null;
    if (!editor || editorLanguage !== "markdown" || layout === "editor") return;
    try {
      markdownPreview.show(editor.view.state.doc.toString());
    } catch (error) {
      // Said in the pane, which would otherwise stay empty.
      markdownPreview.element.replaceChildren(element("p", { className: "md-preview-error" }, `The preview can't be drawn: ${(error as Error).message}`));
      console.error(error);
    }
  }

  /** The text changed: the preview draws it again once it has stopped changing for a moment. */
  function wantMarkdown() {
    if (editorLanguage !== "markdown" || layout === "editor") return;
    if (markdownTimer) clearTimeout(markdownTimer);
    markdownTimer = setTimeout(drawMarkdown, PREVIEW_MS);
  }

  viewer.onPoint = (point: PdfPoint) => {
    if (!editor) return;
    if (layout === "pdf") setLayout("split");
    // In a project, what was clicked may have come from another of its files: that file opens at its line.
    if (project && synctex) {
      const view = editor.view;
      const { data, tag } = synctex;
      const found = sourceForPlace(data, point, (other, line) => (other === tag ? printsIn(view)(line) : true));
      const named = found && found.tag !== tag ? fileOfTag(data, found.tag, textFiles().filter((path) => path.startsWith(buildFolder)).map(inBuild)) : null;
      const file = named && fromBuild(named);
      if (found && file) return openFile(file, found.line);
    }
    const line = (synctex && lineForPlace(synctex.data, synctex.tag, point, printsIn(editor.view))) ?? lineForPdfText(editor.view.state.doc.toString(), point.text);
    if (line === null) return;
    const target = editor.view.state.doc.line(Math.min(line, editor.view.state.doc.lines));
    editor.view.dispatch({ selection: EditorSelection.cursor(target.from), scrollIntoView: true });
    flashRanges(editor.view, [{ from: target.from, to: target.to }]);
    editor.view.focus();
  };

  /** The project's text files. */
  const textFiles = () => (project?.entries ?? []).filter((entry) => entry.kind === "file" && isTextFile(entry.path)).map((entry) => entry.path);

  /** The file a problem is in: the one the log names, else the build's own. */
  const fileOfProblem = (problem: Problem) => problem.file ?? builtSource;
  /** A path as a Markdown file in the editor writes it (relative to its own folder), as a path in the project. */
  function besideEditingFile(path: string): string {
    const file = editingFile();
    const parts = (file?.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) + path : path).split("/");
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === "..") {
        if (resolved.pop() === undefined) throw new Error(`${path} is outside the project`);
      } else if (part !== "." && part !== "") resolved.push(part);
    }
    return resolved.join("/");
  }
  /** The main file's folder, as a prefix; the last build's when the project names no main file. */
  const mainFolder = () => (project?.main ? project.main.slice(0, project.main.lastIndexOf("/") + 1) : buildFolder);
  const problemsOfShownFile = () => {
    if (editorLanguage === "markdown") return [];
    const file = editingFile();
    return file === null ? lastProblems : lastProblems.filter((problem) => fileOfProblem(problem) === file);
  };

  /**
   * Shows a file of the project: a text file in the editor (at a line, if given), anything else in a preview. A host that
   * can't open another file in the editor (Mirador) shows a text file in the preview too, to read, at that line.
   */
  function openFile(path: string, line: number | null = null) {
    if (!host.project) return;
    if (path === editingFile()) {
      hidePreview();
      fileTree?.showPreviewed(null);
      if (line !== null) goToLine(line);
      return;
    }
    if (!isTextFile(path) || !host.project.open) return void showPreview(path, line);
    hidePreview();
    if (line !== null) pendingLine = { file: path, line };
    // What was typed in the file going away goes to it before the editor changes over.
    sync?.flush();
    host.project.open(path).catch((error: Error) => showBanner(error.message));
  }

  function goToLine(line: number) {
    if (!editor) return;
    if (layout === "pdf") setLayout("split");
    const doc = editor.view.state.doc;
    const target = doc.line(Math.min(Math.max(1, line), doc.lines));
    editor.view.dispatch({ selection: EditorSelection.cursor(target.from), scrollIntoView: true });
    editor.view.focus();
  }

  function showProblems(problems: Problem[], failure: string | null) {
    const errors = problems.filter((problem) => problem.severity === "error").length;
    const warnings = problems.length - errors;
    problemsList.replaceChildren();
    if (failure && problems.length === 0) problemsList.append(element("li", { className: "error" }, failure));
    for (const problem of problems) {
      const item = element("li", { className: problem.severity });
      if (problem.line !== null) {
        const line = problem.line;
        const file = fileOfProblem(problem);
        // In a project, a problem in another file than the one open names its file, and opens it.
        const elsewhere = project !== null && file !== null && file !== editingFile();
        const label = elsewhere || (problem.file && !problem.file.endsWith(".tex")) ? `${problem.file ?? file}:${line}` : `line ${line}`;
        item.append(element("a", { href: "#", textContent: label, onclick: (event: Event) => (event.preventDefault(), elsewhere ? openFile(file!, line) : goToLine(line)) }), " ");
      }
      item.append(problem.message);
      problemsList.append(item);
    }
    const said = [errors && `${errors} error${errors === 1 ? "" : "s"}`, warnings && `${warnings} warning${warnings === 1 ? "" : "s"}`].filter(Boolean).join(", ");
    problemsToggle.hidden = !said && !failure;
    problemsToggle.textContent = said || "Build failed";
    problemsToggle.className = `problems-toggle ${errors || failure ? "has-errors" : "has-warnings"}`;
    buildBadge.hidden = !errors && !failure;
    buildBadge.textContent = errors ? `${errors} error${errors === 1 ? "" : "s"}` : "Build failed";
    if (errors || failure) problemsList.hidden = false;
    lastProblems = problems;
    editor?.view.dispatch({ effects: setProblems.of(problemsOfShownFile()) });
  }

  let shownReport = 0;

  async function loadReport(path: string, failure: string | null) {
    if (!host.readFile) return;
    const named = JSON.parse(await (await host.readFile(path)).text()) as BuildReport;
    remember("report", path);
    buildFolder = path.slice(0, Math.max(0, path.lastIndexOf(`${BUILD_FOLDER}/`)));
    const report: BuildReport = {
      ...named,
      source: fromBuild(named.source),
      pdf: named.pdf && fromBuild(named.pdf),
      problems: named.problems.map((problem) => ({ ...problem, file: problem.file && fromBuild(problem.file) })),
    };
    builtSource = report.source;
    showProblems(report.problems, failure);
    if (setCitations(report.citations)) editor?.view.dispatch({ effects: redraw.of(null) });
    if (report.pdf && report.at > shownReport) {
      shownReport = report.at;
      const bytes = await (await host.readFile(report.pdf)).arrayBuffer();
      await viewer.show(bytes);
      synctexData = await loadSynctex(report);
      retag();
      placeholder.hidden = true;
      forgetFigures();
      editor?.view.dispatch({ effects: redraw.of(null) });
    }
  }

  /** The SyncTeX the build wrote beside its PDF; without one, the PDF and the source are matched by their words. */
  async function loadSynctex(report: BuildReport): Promise<Synctex | null> {
    if (!host.readFile || !report.pdf) return null;
    try {
      return await readSynctex(await host.readFile(report.pdf.replace(/\.pdf$/, ".synctex.gz")));
    } catch {
      return null;
    }
  }

  let synctexData: Synctex | null = null;

  /** The SyncTeX of the file in the editor: none when the build didn't read that file. */
  function retag() {
    const source = editingFile() ?? builtSource;
    const tag = synctexData && source ? tagOf(synctexData, inBuild(source)) : null;
    synctex = synctexData && tag !== null ? { data: synctexData, tag } : null;
  }

  // --- Compiling ----------------------------------------------------------------------------------------------------

  let compileTimer: ReturnType<typeof setTimeout> | null = null;
  let compileWanted = false;
  let taskRunning = false;
  let lastTask: { runId: number; state: TaskState["state"] } | null = null;

  /**
   * Whether there is a PDF to build: not for a Markdown file, which isn't part of a build, nor in a project of no LaTeX
   * at all (a folder of Markdown).
   */
  const builds = () => !isMarkdown() && (project === null || project.entries.some((entry) => entry.kind === "file" && kindOf(entry.path) === "tex"));

  /** The text changed: compile once it has stopped changing for a moment, if Auto is on. */
  function wantCompile() {
    if (!auto || !builds()) return;
    compileWanted = true;
    if (compileTimer) clearTimeout(compileTimer);
    compileTimer = setTimeout(() => {
      compileTimer = null;
      tryCompile();
    }, AUTO_COMPILE_MS);
  }

  function compileNow() {
    if (!builds()) return;
    compileWanted = true;
    if (compileTimer) clearTimeout(compileTimer);
    compileTimer = null;
    sync?.flush();
    tryCompile();
  }

  /** Compiles when it is wanted, the host has the text the editor has, and no build is running. */
  function tryCompile() {
    if (!compileWanted || compileTimer || !sync || !host.run) return;
    // The file may have turned out to be Markdown since the build was wanted (Mirador names it late).
    if (!builds()) return void (compileWanted = false);
    if (!sync.settled || taskRunning) return;
    compileWanted = false;
    taskRunning = true;
    buildStatus.textContent = "Compiling…";
    host.run("compile");
  }

  function taskChanged(task: TaskState | null) {
    if (!task || task.name !== "compile") return;
    const known = lastTask && lastTask.runId === task.runId && lastTask.state === task.state;
    lastTask = { runId: task.runId, state: task.state };
    taskRunning = task.state === "running";
    compileButton.disabled = taskRunning;
    if (taskRunning) {
      buildStatus.textContent = task.text ?? "Compiling…";
      return;
    }
    // A Markdown file has no build: what a build of before says isn't about it.
    if (known || editorLanguage === "markdown") return;
    if (task.state === "done") buildStatus.textContent = (task.summary ?? "").split("\n")[0]!.replace(/^Compiled \S+ with (\S+) to \S+: /, "$1 · ").replace(/\.$/, "");
    else buildStatus.textContent = task.state === "stopped" ? "Stopped" : "Build failed";
    buildStatus.title = task.summary ?? task.problem ?? "";
    const report = reportNamedIn(task.summary ?? task.problem);
    if (report) void loadReport(report, task.state === "failed" ? task.problem : null).catch((error: Error) => showProblems([], `Couldn't read the build: ${error.message}`));
    else if (task.state === "failed") showProblems([], task.problem ?? "The build failed.");
    tryCompile();
  }

  // --- The project's files ------------------------------------------------------------------------------------------

  /** A file shown in place of the editor, that the editor doesn't open: an image, a PDF. */
  let previewing: string | null = null;
  const preview = element("div", { className: "file-preview", hidden: true });
  editorPane.after(preview);
  let previewUrl: string | null = null;

  async function showPreview(path: string, line: number | null = null) {
    if (!host.readFile) return;
    previewing = path;
    fileTree?.showPreviewed(path);
    preview.replaceChildren(element("div", { className: "file-preview-name" }, path));
    preview.hidden = false;
    editorPane.hidden = true;
    if (layout === "pdf") setLayout("split");
    const kind = kindOf(path);
    try {
      const blob = await host.readFile(path);
      if (previewing !== path) return;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = null;
      if (kind === "tex" || kind === "markdown" || kind === "text") {
        // To read: the host can't open it in the editor. Edit asks the agent to open it there.
        if (prompt) {
          preview.firstElementChild?.append(
            " ",
            button("Edit", `Ask the agent to open ${path} in the editor`, () => {
              void prompt(`Please open ${path} in NeoManuscript (app_open), so I can edit it there.`).catch((error: Error) => showBanner(error.message));
            }, "edit-file"),
          );
        }
        const lines = (await blob.text()).split("\n").map((text, index) => element("div", { className: index + 1 === line ? "file-line marked" : "file-line" }, text || " "));
        preview.append(element("div", { className: "file-text" }, ...lines));
        if (line !== null) lines[line - 1]?.scrollIntoView({ block: "center" });
      } else if (kind === "image") {
        previewUrl = URL.createObjectURL(blob);
        preview.append(element("img", { src: previewUrl, alt: path }));
      } else if (kind === "pdf") {
        preview.append(await drawFirstPage(blob, Math.min(900, preview.clientWidth - 40)));
      } else {
        preview.append(element("p", {}, `${path} isn't a text file, an image or a PDF, so it can't be shown here (${(blob.size / 1024).toFixed(0)} KB).`));
      }
    } catch (error) {
      preview.append(element("p", {}, `${path} can't be read: ${(error as Error).message}`));
    }
  }

  function hidePreview() {
    previewing = null;
    preview.hidden = true;
    editorPane.hidden = false;
  }

  const fileTree = host.project
    ? new FileTree({ project: host.project, onOpen: (path) => openFile(path), report: showBanner, storage })
    : null;
  if (fileTree && host.project) {
    workspace.prepend(fileTree.element);
    const showFiles = recall("files") !== "hidden";
    app.dataset.files = showFiles ? "shown" : "hidden";
    toolbar.prepend(
      button("☰", "Show or hide the project's files", () => {
        app.dataset.files = app.dataset.files === "hidden" ? "shown" : "hidden";
        remember("files", app.dataset.files);
        editor?.view.requestMeasure();
      }, "files-toggle"),
      element("span", { className: "sep" }),
    );
    host.project.onProject((state) => {
      project = state;
      // For a host that names the file in the editor only here (Mirador), the editor follows its language.
      if (editor && lastState && languageOf(editingFile()) !== editorLanguage) start(lastState);
      // For a host that names the file in the editor only here, problems and SyncTeX follow it.
      retag();
      editor?.view.dispatch({ effects: setProblems.of(problemsOfShownFile()) });
      // No file open: the open one went, and the project has no main file to fall back to.
      if (state.open === null && editor) {
        editor.view.destroy();
        editor = null;
        sync = null;
        shownFile = null;
      }
      if (state.open === null && !previewing) {
        editorPane.replaceChildren(element("div", { className: "loading" }, state.entries.length > 0 ? "Pick a file on the left." : "This folder is empty: make a .tex or .md file with + on the left."));
      }
    });
  }

  // --- The host's document ------------------------------------------------------------------------------------------

  function start(state: DocumentState<TexDocument>) {
    if (editor && shownFile !== null) {
      const { anchor, head } = editor.view.state.selection.main;
      places.set(shownFile, { anchor, head, scrollTop: editor.view.scrollDOM.scrollTop });
    }
    editor?.view.destroy();
    const first = editor === null;
    shownFile = state.file ?? null;
    editorLanguage = languageOf(editingFile());
    nameTools(editorLanguage);
    hidePreview();
    editorPane.replaceChildren();
    const markdown = editorLanguage === "markdown";
    editor = createEditor({
      parent: editorPane,
      text: state.document.text,
      mode: modeOfFile(),
      language: editorLanguage,
      // A figure's path is named from the main file's folder, as LaTeX names it; a Markdown image's from the file's own.
      readFile: host.readFile ? (path) => host.readFile!(markdown ? besideEditingFile(path) : mainFolder() + path) : null,
      drawPdf: drawFirstPage,
      onChange: (fromUser) => {
        if (fromUser) sync?.typed();
        wantCompile();
        wantMarkdown();
      },
      onCompile: compileNow,
      onTogglePreview: togglePreview,
      synonyms: { thesaurus: loadThesaurus, ask: prompt, report: showBanner },
      isRemote: (transaction) => transaction.annotation(fromHost) === true,
    });
    const file = shownFile;
    const project = host.project;
    const applyTo = project?.applyTo;
    sync = new DocumentSync(editor.view, file !== null && applyTo ? (operation) => applyTo(file, operation) : (operation) => host.apply(operation), state.document.text);
    sync.onRemote = (ranges, author) => {
      if (editor && author?.kind !== "you") flashRanges(editor.view, ranges);
    };
    sync.onSettled = tryCompile;
    setMode(mode);
    retag();
    editor.view.dispatch({ effects: setProblems.of(problemsOfShownFile()) });
    fileTree?.showPreviewed(null);
    const place = shownFile === null ? undefined : places.get(shownFile);
    const length = state.document.text.length;
    if (pendingLine && pendingLine.file === shownFile) {
      goToLine(pendingLine.line);
      pendingLine = null;
    } else if (place) {
      editor.view.dispatch({ selection: { anchor: Math.min(place.anchor, length), head: Math.min(place.head, length) } });
      const view = editor.view;
      requestAnimationFrame(() => (view.scrollDOM.scrollTop = place.scrollTop));
    } else if (!markdown) {
      // Start in the body, so that Visual mode opens with the preamble folded away.
      const body = /\\begin\{document\}[^\n]*\n?/.exec(state.document.text);
      if (body) editor.view.dispatch({ selection: { anchor: body.index + body[0].length } });
    }
    drawMarkdown();
    if (!first) return;

    // The last build's PDF shows at once (taskChanged reads it when the host still has its task), and a new build follows.
    if (markdown) return;
    const report = recall("report");
    if (!state.task && report) void loadReport(report, null).catch(() => {});
    wantCompile();
    if (!host.run) buildStatus.textContent = "Builds can't run from here.";
  }

  host.onState((state) => {
    lastState = state;
    showBanner(state.problem ? `The file doesn't read as it is now: ${state.problem}` : null);
    if (!editor || (state.file ?? null) !== shownFile) start(state);
    else sync?.received(state);
    const change = state.lastChange;
    lastChange.textContent = change ? `${AUTHOR[change.author.kind]}: ${change.summary}` : "";
    lastChange.title = lastChange.textContent;
    taskChanged(state.task ?? null);
  });
}
