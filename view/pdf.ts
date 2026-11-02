import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerCode from "pdfjs-dist/legacy/build/pdf.worker.min.mjs" with { type: "text" };
import type { PagePlace } from "./synctex.ts";

// The canvas frame loads nothing from the network, so pdf.js's worker comes from the bundle, as a blob.
pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }));

/** Opens a PDF; destroying its loading task frees it, and its worker. */
const open = (bytes: ArrayBuffer) => pdfjs.getDocument({ data: new Uint8Array(bytes) });

/** The first page of a PDF, drawn `width` pixels wide: for figures in Visual mode. */
export async function drawFirstPage(blob: Blob, width: number): Promise<HTMLCanvasElement> {
  const task = open(await blob.arrayBuffer());
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const scale = width / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale: scale * devicePixelRatio });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.style.width = `${Math.ceil(viewport.width / devicePixelRatio)}px`;
    await page.render({ canvas, viewport }).promise;
    return canvas;
  } finally {
    void task.destroy();
  }
}

export type Zoom = { fit: "width" } | { fit: "page" } | { scale: number };

/** How far below the top of the preview a place scrolled to shows, in pixels. */
const PLACE_MARGIN = 16;
/** How long a place asked for waits for the pages to be laid out, as when the preview has just come into sight. */
const PLACE_WAITS_MS = 1000;

/** Where a click on the PDF landed: the page, and the words around it, to find the place in the source. */
export interface PdfPoint extends PagePlace {
  /** The words of the text line under the click, as the PDF has them. */
  text: string;
}

/** Text selected in the PDF, as the page shows it, and where it starts and ends. */
export interface PdfSelection {
  text: string;
  from: PagePlace;
  to: PagePlace;
}

/**
 * The compiled PDF, every page drawn as it scrolls into sight. A new build replaces the pages where they are, so the
 * scroll position stays, and its pages are drawn before the old ones go, so the preview doesn't flash.
 */
export class PdfViewer {
  readonly element: HTMLDivElement;
  private pages: HTMLDivElement;
  private pdf: PDFDocumentProxy | null = null;
  private loading: ReturnType<typeof open> | null = null;
  private zoom: Zoom = { fit: "width" };
  private scaleUsed = 1;
  private observer: IntersectionObserver;
  private drawn = new Map<number, number>();
  private generation = 0;
  private wantedPlace: { place: PagePlace; until: number } | null = null;
  onZoom: (label: string) => void = () => {};
  onPoint: (point: PdfPoint) => void = () => {};

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "pdf-scroll";
    this.pages = document.createElement("div");
    this.pages.className = "pdf-pages";
    this.element.append(this.pages);
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) void this.drawPage(Number((entry.target as HTMLElement).dataset.page));
    }, { root: this.element, rootMargin: "600px 0px" });
    // Fitting the pages changes what is inside the scroller, and with scrollbars that take room (a Mac with a mouse) a
    // scrollbar coming or going resizes it again within the same frame: a ResizeObserver loop, which WebKit reports as
    // an error without a message. So the pages are fitted in the next frame, and only when the size really changed.
    let fitted = "";
    let pending = 0;
    new ResizeObserver(() => {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        const size = `${this.element.clientWidth}x${this.element.clientHeight}`;
        if (size === fitted) return;
        fitted = size;
        if (this.pdf && !("scale" in this.zoom)) void this.layout();
      });
    }).observe(this.element);
    this.element.addEventListener("dblclick", (event) => void this.pointAt(event));
    // Scrolling the preview oneself is where one wants to be, which a place asked for a moment ago mustn't undo.
    for (const input of ["wheel", "pointerdown", "keydown", "touchstart"]) this.element.addEventListener(input, () => (this.wantedPlace = null), { passive: true });
  }

  get pageCount() {
    return this.pdf?.numPages ?? 0;
  }

  /** Whether the pages are laid out where they can be seen, so that places on them can be measured. */
  private get laidOut() {
    return this.pdf !== null && this.element.clientWidth > 0 && this.pages.children.length === this.pdf.numPages;
  }

  /** The place at the top of the preview, a little below its edge; null while there is nothing in sight. */
  placeAtTop(): PagePlace | null {
    if (!this.laidOut) return null;
    const top = this.element.getBoundingClientRect().top + PLACE_MARGIN;
    const boxes = [...this.pages.children] as HTMLDivElement[];
    // The first page that reaches below the top; in the gap between two pages, the top of the next.
    for (const [index, box] of boxes.entries()) {
      const rect = box.getBoundingClientRect();
      if (rect.bottom > top) return { page: index + 1, x: 0, y: Math.max(0, top - rect.top) / this.scaleUsed };
    }
    return null;
  }

  /** Scrolls a place to the top of the preview, now or as soon as the pages are laid out. */
  scrollToPlace(place: PagePlace) {
    this.wantedPlace = { place, until: Date.now() + PLACE_WAITS_MS };
    if (this.laidOut) this.showWantedPlace();
  }

  /** The scroll offset that puts a place at the top, as scrollToPlace does; null before the pages are laid out. */
  offsetOf(place: PagePlace): number | null {
    const box = this.laidOut ? (this.pages.children[place.page - 1] as HTMLDivElement | undefined) : undefined;
    if (!box) return null;
    return box.getBoundingClientRect().top - this.element.getBoundingClientRect().top + this.element.scrollTop + place.y * this.scaleUsed - PLACE_MARGIN;
  }

  /** How far the pages scroll, at most. */
  get scrollRange(): number {
    return this.element.scrollHeight - this.element.clientHeight;
  }

  /** Scrolls to an offset at once, as when following the editor. */
  scrollToOffset(top: number) {
    this.wantedPlace = null;
    this.element.scrollTop = Math.max(0, top);
  }

  /** Scrolls to the place asked for; it stays wanted for a moment, as the preview coming into sight lays it out anew. */
  private showWantedPlace() {
    const wanted = this.wantedPlace;
    if (!wanted || Date.now() > wanted.until) {
      this.wantedPlace = null;
      return;
    }
    const box = this.pages.children[wanted.place.page - 1] as HTMLDivElement | undefined;
    if (!box) return;
    const offset = box.getBoundingClientRect().top - this.element.getBoundingClientRect().top + this.element.scrollTop;
    this.element.scrollTop = Math.max(0, offset + wanted.place.y * this.scaleUsed - PLACE_MARGIN);
  }

  async show(bytes: ArrayBuffer) {
    const loading = open(bytes);
    const pdf = await loading.promise;
    const previous = this.loading;
    this.loading = loading;
    this.pdf = pdf;
    await this.layout(true);
    if (previous) void previous.destroy();
  }

  setZoom(zoom: Zoom | "in" | "out") {
    if (zoom === "in" || zoom === "out") {
      const steps = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
      const now = this.scaleUsed;
      const next = zoom === "in" ? steps.find((step) => step > now + 0.01) ?? 4 : steps.findLast((step) => step < now - 0.01) ?? 0.5;
      this.zoom = { scale: next };
    } else this.zoom = zoom;
    void this.layout();
  }

  private async scaleFor(page: PDFPageProxy): Promise<number> {
    const base = page.getViewport({ scale: 1 });
    const width = this.element.clientWidth - 24;
    const height = this.element.clientHeight - 24;
    if ("scale" in this.zoom) return this.zoom.scale;
    if (this.zoom.fit === "page") return Math.max(0.1, Math.min(width / base.width, height / base.height));
    return Math.max(0.1, width / base.width);
  }

  /** Sizes a box for every page, keeping the place scrolled to, and draws the ones in sight. */
  private async layout(newDocument = false) {
    const pdf = this.pdf;
    // While the preview is hidden there is nothing to fit; showing it again resizes it, which lays it out.
    if (!pdf || this.element.clientWidth === 0) return;
    const generation = ++this.generation;
    const first = await pdf.getPage(1);
    const scale = await this.scaleFor(first);
    if (generation !== this.generation) return;
    const scroller = this.element;
    const ratio = scroller.scrollHeight > 0 ? scroller.scrollTop / scroller.scrollHeight : 0;
    const left = scroller.scrollWidth > 0 ? scroller.scrollLeft / scroller.scrollWidth : 0;
    this.scaleUsed = scale;
    this.onZoom(`${Math.round(scale * 100)}%`);

    const sizes = await Promise.all(Array.from({ length: pdf.numPages }, (_, index) => pdf.getPage(index + 1).then((page) => page.getViewport({ scale }))));
    if (generation !== this.generation) return;
    const existing = [...this.pages.children] as HTMLDivElement[];
    existing.slice(pdf.numPages).forEach((box) => {
      this.observer.unobserve(box);
      box.remove();
    });
    this.drawn.clear();
    sizes.forEach((viewport, index) => {
      let box = existing[index];
      if (!box) {
        box = document.createElement("div");
        box.className = "pdf-page";
        box.dataset.page = String(index + 1);
        this.pages.append(box);
      }
      box.style.width = `${Math.floor(viewport.width)}px`;
      box.style.height = `${Math.floor(viewport.height)}px`;
      // The text layer sizes itself and its text by this, so the text stays over the page while it is redrawn.
      box.style.setProperty("--total-scale-factor", String(scale));
      if (newDocument) box.dataset.stale = "true";
      this.observer.unobserve(box);
      this.observer.observe(box);
    });
    scroller.scrollTop = ratio * scroller.scrollHeight;
    scroller.scrollLeft = left * scroller.scrollWidth;
    this.showWantedPlace();
  }

  private async drawPage(number: number) {
    const pdf = this.pdf;
    if (!pdf || this.drawn.get(number) === this.generation) return;
    const generation = this.generation;
    this.drawn.set(number, generation);
    const box = this.pages.children[number - 1] as HTMLDivElement | undefined;
    if (!box) return;
    const page = await pdf.getPage(number);
    const viewport = page.getViewport({ scale: this.scaleUsed * devicePixelRatio });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    try {
      await page.render({ canvas, viewport }).promise;
    } catch {
      this.drawn.delete(number);
      return;
    }
    if (generation !== this.generation || pdf !== this.pdf) return;
    const text = await this.textLayer(page);
    if (generation !== this.generation || pdf !== this.pdf) return;
    box.replaceChildren(canvas, ...(text ? [text] : []));
    delete box.dataset.stale;
  }

  /** The page's text, laid over its picture where it is drawn, see-through, for selecting and copying. */
  private async textLayer(page: PDFPageProxy): Promise<HTMLDivElement | null> {
    const container = document.createElement("div");
    container.className = "textLayer";
    try {
      await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container, viewport: page.getViewport({ scale: this.scaleUsed }) }).render();
    } catch {
      return null;
    }
    // Past the last line of text, a drag would select up to the top of the page; this takes it to the end instead.
    container.append(Object.assign(document.createElement("div"), { className: "endOfContent" }));
    container.addEventListener("pointerdown", () => {
      container.classList.add("selecting");
      addEventListener("pointerup", () => container.classList.remove("selecting"), { once: true });
    });
    return container;
  }

  /** The text selected in the PDF; null when nothing in it is selected. */
  selection(): PdfSelection | null {
    const selection = getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!this.pages.contains(range.commonAncestorContainer)) return null;
    const text = selection.toString().replace(/\s+/g, " ").trim();
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    const from = rects[0] && this.placeAt(rects[0].left, rects[0].top + rects[0].height / 2);
    const last = rects.at(-1);
    const to = last && this.placeAt(last.right, last.top + last.height / 2);
    return text && from && to ? { text, from, to } : null;
  }

  /** The place on a page under a point of the screen. */
  private placeAt(clientX: number, clientY: number): PagePlace | null {
    for (const [index, box] of ([...this.pages.children] as HTMLDivElement[]).entries()) {
      const rect = box.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) return { page: index + 1, x: (clientX - rect.left) / this.scaleUsed, y: (clientY - rect.top) / this.scaleUsed };
    }
    return null;
  }

  /** On a double click: the page and the line of text under the pointer, for the editor to find in the source. */
  private async pointAt(event: MouseEvent) {
    const box = (event.target as HTMLElement).closest<HTMLDivElement>(".pdf-page");
    if (!box || !this.pdf) return;
    const number = Number(box.dataset.page);
    const page = await this.pdf.getPage(number);
    const viewport = page.getViewport({ scale: this.scaleUsed });
    const rect = box.getBoundingClientRect();
    const [, y] = viewport.convertToPdfPoint(event.clientX - rect.left, event.clientY - rect.top);
    const [x] = viewport.convertToPdfPoint(event.clientX - rect.left, event.clientY - rect.top);
    const content = await page.getTextContent();
    let best: { distance: number; y: number } | null = null;
    const items = content.items.filter((item): item is (typeof content.items)[number] & { str: string; transform: number[] } => "str" in item && item.str.trim() !== "");
    for (const item of items) {
      const distance = Math.abs(item.transform[5]! - y) + Math.max(0, item.transform[4]! - x) * 0.01;
      if (!best || distance < best.distance) best = { distance, y: item.transform[5]! };
    }
    if (!best) return;
    const line = items
      .filter((item) => Math.abs(item.transform[5]! - best!.y) < 2)
      .sort((a, b) => a.transform[4]! - b.transform[4]!)
      .map((item) => item.str)
      .join(" ");
    this.onPoint({ page: number, x, y: viewport.viewBox[3]! - y, text: line });
  }
}
