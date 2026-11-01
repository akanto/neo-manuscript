/**
 * The SyncTeX file the engine writes next to the PDF (-synctex=1): where on which page each piece of the source went.
 * It takes the view from a source line to its place in the PDF, and from a place in the PDF back to its line.
 */

/** A point on a page, in PDF points from the page's top left corner. */
export interface PagePlace {
  page: number;
  x: number;
  y: number;
}

interface SyncRecord {
  page: number;
  tag: number;
  line: number;
  /** Where it is: a box's left edge and baseline, or the point a character, glue, kern or math node sits at. */
  x: number;
  y: number;
  /** How far a box reaches above its baseline; 0 for a point. */
  height: number;
  box: boolean;
}

export interface Synctex {
  /** Each input file's tag, by the path SyncTeX gives it. */
  inputs: Map<number, string>;
  records: SyncRecord[];
}

/** Scaled points (TeX's sp) in a PDF point: 65536 sp to a TeX point, 72.27 TeX points to 72 PDF points. */
const SP_PER_BP = 65536 * (72.27 / 72);

/** Reads the text of a .synctex file (gunzipped). */
export function parseSynctex(text: string): Synctex {
  const inputs = new Map<number, string>();
  const records: SyncRecord[] = [];
  let unit = 1;
  let magnification = 1000;
  let xOffset = 0;
  let yOffset = 0;
  let page = 0;
  // For each box that is open, whether what is in it is out of sight: a box of no size at all, as a page's header and
  // the output routine's own boxes are, holds glue and kerns that carry the line TeX was on when it shipped the page.
  const hidden: boolean[] = [];
  const toBp = (value: number, offset: number) => (value * unit * (magnification / 1000) + offset) / SP_PER_BP;
  for (const line of text.split("\n")) {
    const kind = line[0];
    if (kind === "[" || kind === "(" || kind === "h" || kind === "v" || kind === "x" || kind === "k" || kind === "g" || kind === "$") {
      if (page === 0) continue;
      // [tag,line:h,v:W,H,D for boxes, x tag,line:h,v (and more after it) for the rest.
      const match = /^.(\d+),(\d+)(?:,\d+)?:(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+),(-?\d+))?/.exec(line);
      if (!match) {
        if (kind === "[" || kind === "(") hidden.push(hidden.at(-1) ?? false);
        continue;
      }
      const box = kind === "[" || kind === "(" || kind === "h" || kind === "v";
      const empty = box && match[5] === "0" && match[6] === "0" && match[7] === "0";
      const outOfSight = (hidden.at(-1) ?? false) || empty;
      if (kind === "[" || kind === "(") hidden.push(outOfSight);
      if (outOfSight) continue;
      records.push({
        page,
        tag: Number(match[1]),
        line: Number(match[2]),
        x: toBp(Number(match[3]), xOffset),
        y: toBp(Number(match[4]), yOffset),
        height: box && match[6] ? Math.max(0, Number(match[6])) * unit * (magnification / 1000) / SP_PER_BP : 0,
        box,
      });
    } else if (kind === "]" || kind === ")") hidden.pop();
    else if (kind === "{") page = Number(line.slice(1)) || page;
    else if (kind === "}") {
      page = 0;
      hidden.length = 0;
    }
    else if (line.startsWith("Input:")) {
      const match = /^Input:(\d+):(.*)$/.exec(line);
      if (match) inputs.set(Number(match[1]), match[2]!);
    } else if (line.startsWith("Unit:")) unit = Number(line.slice(5)) || 1;
    else if (line.startsWith("Magnification:")) magnification = Number(line.slice(14)) || 1000;
    else if (line.startsWith("X Offset:")) xOffset = Number(line.slice(9)) || 0;
    else if (line.startsWith("Y Offset:")) yOffset = Number(line.slice(9)) || 0;
  }
  return { inputs, records };
}

/** The tag of the input that is the document's own file, `source` being its path relative to the document's folder. */
export function tagOf(synctex: Synctex, source: string): number | null {
  const wanted = source.replace(/^\.\//, "").split("/");
  for (const [tag, path] of synctex.inputs) {
    const parts = path.replace(/\\/g, "/").split("/").filter((part) => part !== ".");
    if (wanted.every((part, index) => parts[parts.length - wanted.length + index] === part)) return tag;
  }
  return null;
}

/**
 * Where a source line went in the PDF: the top of the first thing it typeset. A line that typeset nothing (a blank line,
 * a \label) goes to the next line that did, so a place between two paragraphs shows the second.
 */
export function placeForLine(synctex: Synctex, tag: number, line: number): PagePlace | null {
  const ours = synctex.records.filter((record) => record.tag === tag);
  if (ours.length === 0) return null;
  const after = ours.filter((record) => record.line >= line);
  const nearest = after.length > 0 ? Math.min(...after.map((record) => record.line)) : Math.max(...ours.map((record) => record.line));
  const onLine = ours.filter((record) => record.line === nearest);
  // Characters, glue and kerns sit where the line's text is; a box can be a whole page that only ended on this line.
  const points = onLine.filter((record) => !record.box);
  const candidates = points.length > 0 ? points : onLine;
  let best: SyncRecord | null = null;
  for (const record of candidates) {
    if (!best || record.page < best.page || (record.page === best.page && record.y - record.height < best.y - best.height)) best = record;
  }
  if (!best) return null;
  // A point is on the text's baseline; its line of text starts about a line's height above it.
  return { page: best.page, x: best.x, y: best.box ? best.y - best.height : best.y - 10 };
}

/**
 * The source line of what is typeset nearest a place on a page; null when nothing of the document's file is on it.
 * `prints` says which lines print anything: TeX breaks a paragraph into lines when it reaches its end, so the glue on
 * each of its lines carries the line that ended it, often a blank one.
 */
export function lineForPlace(synctex: Synctex, tag: number, place: PagePlace, prints: (line: number) => boolean = () => true): number | null {
  return sourceForPlace(synctex, place, (recordTag, line) => recordTag === tag && prints(line))?.line ?? null;
}

/** The input and line of what is typeset nearest a place on a page, of the lines `counts` lets in (see lineForPlace). */
export function sourceForPlace(synctex: Synctex, place: PagePlace, counts: (tag: number, line: number) => boolean): { tag: number; line: number } | null {
  let best: { tag: number; line: number; score: number } | null = null;
  for (const record of synctex.records) {
    if (record.page !== place.page || record.box || !counts(record.tag, record.line)) continue;
    // A line of text reaches from about 8pt above its baseline to 3pt below it; being on the line counts most.
    const top = record.y - 8;
    const bottom = record.y + 3;
    const off = place.y < top ? top - place.y : place.y > bottom ? place.y - bottom : 0;
    const score = off * 1000 + Math.abs(place.x - record.x);
    if (!best || score < best.score) best = { tag: record.tag, line: record.line, score };
  }
  return best && { tag: best.tag, line: best.line };
}

/** Which of the project's files (paths relative to its folder) an input is, if it is one. */
export function fileOfTag(synctex: Synctex, tag: number, files: readonly string[]): string | null {
  // The deepest first: "intro.tex" at the top would also match the input chapters/intro.tex.
  const deepestFirst = [...files].sort((a, b) => b.split("/").length - a.split("/").length);
  return deepestFirst.find((file) => tagOf(synctex, file) === tag) ?? null;
}

/** Reads a .synctex.gz as the view gets it. */
export async function readSynctex(blob: Blob): Promise<Synctex> {
  const text = await new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text();
  return parseSynctex(text);
}
