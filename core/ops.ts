import { hunksBetween, type Hunk } from "./diff.ts";
import { lineAt, lineStarts, type TexDocument } from "./document.ts";

/**
 * One replacement in an `edit`: `from..to` of the text it was made on held `expect`, and `insert` replaces it. `prefix`
 * and `suffix` are the text just around it then. When the text moved under the edit (the agent changed something above
 * it while the user typed), the edit goes where prefix + expect + suffix is now, nearest to where it was.
 */
export interface TextChange {
  from: number;
  to: number;
  insert: string;
  expect: string;
  prefix?: string;
  suffix?: string;
}

export type Operation =
  | { op: "edit"; changes: TextChange[] }
  | { op: "replace"; find: string; with: string; all?: boolean }
  | { op: "insert"; text: string; after?: string; before?: string; at?: InsertPlace }
  | { op: "replace_lines"; from: number; to: number; text: string }
  | { op: "set_text"; text: string };

const INSERT_PLACES = ["start", "end", "end_of_preamble", "end_of_body"] as const;
type InsertPlace = (typeof INSERT_PLACES)[number];

/** How much text around a replacement an edit keeps to find its place again. */
export const ANCHOR_LENGTH = 24;

export const OPERATIONS_HELP = `Operations (apply takes one at a time; line numbers are 1-based, as listed above):
- {"op":"replace","find":"old text","with":"new text"}: find must occur exactly once (add surrounding text to make it unique), or pass "all":true to replace every occurrence.
- {"op":"insert","text":"...","after":"unique text"} or "before":"unique text", or "at":"start"|"end"|"end_of_preamble"|"end_of_body" (just before \\begin{document} / \\end{document}). The text goes in exactly as given; end it with \\n to insert whole lines.
- {"op":"replace_lines","from":12,"to":14,"text":"new lines"}: replaces lines 12 to 14 (without their last line break); "to": from - 1 inserts the text as new lines before line "from".
- {"op":"set_text","text":"..."}: replaces the whole document; prefer the smaller operations.`;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isLine = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

function parseChange(raw: unknown, index: number): TextChange {
  const where = `change ${index + 1} of the edit`;
  if (!isObject(raw)) throw new Error(`${where} is not an object with from, to, insert and expect.`);
  const { from, to, insert, expect, prefix, suffix } = raw;
  if (!isLine(from) || !isLine(to) || to < from) throw new Error(`${where} needs whole numbers from <= to, got from ${JSON.stringify(from)} and to ${JSON.stringify(to)}.`);
  if (typeof insert !== "string" || typeof expect !== "string") throw new Error(`${where} needs insert and expect as strings.`);
  if (expect.length !== to - from) throw new Error(`${where}: expect is ${expect.length} characters long but from..to covers ${to - from}.`);
  if ((prefix !== undefined && typeof prefix !== "string") || (suffix !== undefined && typeof suffix !== "string")) throw new Error(`${where}: prefix and suffix must be strings.`);
  return { from, to, insert, expect, prefix, suffix };
}

/** Checks an operation as it came from the agent or the view, saying what is wrong and what would work. */
export function parseOperation(raw: unknown): Operation {
  if (!isObject(raw) || typeof raw.op !== "string") throw new Error(`An operation is an object with an "op". ${OPERATIONS_HELP}`);
  switch (raw.op) {
    case "edit":
      if (!Array.isArray(raw.changes)) throw new Error('edit needs "changes", a list of {from, to, insert, expect}.');
      return { op: "edit", changes: raw.changes.map(parseChange) };
    case "replace":
      if (typeof raw.find !== "string" || raw.find === "") throw new Error('replace needs "find", the text to replace, not empty.');
      if (typeof raw.with !== "string") throw new Error('replace needs "with", the new text (an empty string deletes).');
      if (raw.all !== undefined && typeof raw.all !== "boolean") throw new Error('replace\'s "all" is true or false.');
      return { op: "replace", find: raw.find, with: raw.with, all: raw.all === true };
    case "insert": {
      if (typeof raw.text !== "string") throw new Error('insert needs "text", the text to insert.');
      const places = [raw.after, raw.before, raw.at].filter((place) => place !== undefined);
      if (places.length !== 1) throw new Error('insert needs exactly one of "after" or "before" (a unique piece of the text) or "at".');
      if (raw.after !== undefined && (typeof raw.after !== "string" || raw.after === "")) throw new Error('insert\'s "after" is a piece of the text, not empty.');
      if (raw.before !== undefined && (typeof raw.before !== "string" || raw.before === "")) throw new Error('insert\'s "before" is a piece of the text, not empty.');
      if (raw.at !== undefined && !(INSERT_PLACES as readonly unknown[]).includes(raw.at)) throw new Error(`insert's "at" is one of ${INSERT_PLACES.join(", ")}.`);
      return { op: "insert", text: raw.text, after: raw.after as string | undefined, before: raw.before as string | undefined, at: raw.at as InsertPlace | undefined };
    }
    case "replace_lines":
      if (!Number.isInteger(raw.from) || !Number.isInteger(raw.to)) throw new Error('replace_lines needs whole line numbers "from" and "to".');
      if (typeof raw.text !== "string") throw new Error('replace_lines needs "text", the new lines.');
      return { op: "replace_lines", from: raw.from as number, to: raw.to as number, text: raw.text };
    case "set_text":
      if (typeof raw.text !== "string") throw new Error('set_text needs "text", the whole new document.');
      return { op: "set_text", text: raw.text };
    default:
      throw new Error(`There is no operation "${raw.op}". ${OPERATIONS_HELP}`);
  }
}

const quote = (text: string, length = 40) => {
  const flat = text.replace(/\n/g, "⏎");
  return `“${flat.length > length ? `${flat.slice(0, length - 1)}…` : flat}”`;
};

/** Where a change made on an older text goes in this one. */
function locate(text: string, change: TextChange): Hunk {
  const prefix = change.prefix ?? "";
  const suffix = change.suffix ?? "";
  if (change.from - prefix.length >= 0 && text.startsWith(prefix + change.expect + suffix, change.from - prefix.length)) {
    return { from: change.from, to: change.to, insert: change.insert };
  }
  if (prefix + change.expect + suffix === "") return { from: Math.min(change.from, text.length), to: Math.min(change.from, text.length), insert: change.insert };
  // Text changed near the edit too, so look for it with less around it: both sides, then one, then the replaced text alone.
  const tries: [string, string][] = [[prefix, suffix], [prefix.slice(-8), suffix.slice(0, 8)], ["", suffix], [prefix, ""]];
  if (change.expect !== "") tries.push(["", ""]);
  for (const [before, after] of tries) {
    const needle = before + change.expect + after;
    if (needle === "") continue;
    const start = change.from - before.length;
    let best = -1;
    for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + 1)) {
      if (best === -1 || Math.abs(index - start) < Math.abs(best - start)) best = index;
    }
    if (best !== -1) return { from: best + before.length, to: best + before.length + change.expect.length, insert: change.insert };
  }
  const what = change.expect !== "" ? quote(change.expect) : `the place between ${quote(prefix.slice(-12))} and ${quote(suffix.slice(0, 12))}`;
  throw new Error(`The text changed before this edit reached it: line ${lineAt(text, Math.min(change.from, text.length))} no longer has ${what}.`);
}

/** The occurrences of `find` in the text. */
function occurrences(text: string, find: string): number[] {
  const found: number[] = [];
  for (let index = text.indexOf(find); index !== -1; index = text.indexOf(find, index + find.length)) found.push(index);
  return found;
}

function uniqueIndex(text: string, find: string, what: string): number {
  const found = occurrences(text, find);
  if (found.length === 0) throw new Error(`${what} ${quote(find)} isn't in the document; read the document again, the text may have changed.`);
  if (found.length > 1) {
    const lines = found.slice(0, 8).map((index) => lineAt(text, index));
    throw new Error(`${what} ${quote(find)} occurs ${found.length} times (lines ${lines.join(", ")}${found.length > 8 ? ", …" : ""}); give more of the text around it so it occurs once.`);
  }
  return found[0]!;
}

/** "line 3", "lines 3–5", "lines 3, 8–9 and 20". */
function linesSaid(ranges: [number, number][]): string {
  const merged: [number, number][] = [];
  for (const [first, last] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && first <= previous[1] + 1) previous[1] = Math.max(previous[1], last);
    else merged.push([first, last]);
  }
  const said = merged.map(([first, last]) => (first === last ? `${first}` : `${first}–${last}`));
  const single = merged.length === 1 && merged[0]![0] === merged[0]![1];
  if (said.length > 4) return `${said.length} places, from line ${merged[0]![0]} to ${merged.at(-1)![1]}`;
  return `${single ? "line" : "lines"} ${said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said.at(-1)}` : said[0]}`;
}

interface Committed {
  text: string;
  inverse: Operation;
  touched: string[];
  /** The lines the changes cover in the new text. */
  ranges: [number, number][];
}

/** Makes the replacements, which are on `text`, and the edit that undoes them. */
function commit(text: string, hunks: Hunk[]): Committed {
  const sorted = [...hunks].sort((a, b) => a.from - b.from || a.to - b.to);
  sorted.forEach((hunk, index) => {
    const previous = sorted[index - 1];
    if (previous && hunk.from < previous.to) throw new Error(`Two changes of the edit overlap at line ${lineAt(text, hunk.from)}; make them one change.`);
  });
  let next = "";
  let position = 0;
  const placed: { from: number; to: number; old: string }[] = [];
  for (const hunk of sorted) {
    next += text.slice(position, hunk.from);
    placed.push({ from: next.length, to: next.length + hunk.insert.length, old: text.slice(hunk.from, hunk.to) });
    next += hunk.insert;
    position = hunk.to;
  }
  next += text.slice(position);
  const starts = lineStarts(next);
  const lineOf = (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  const ranges = placed.map(({ from, to }): [number, number] => [lineOf(from), lineOf(Math.max(from, to - 1))]);
  const touched = new Set<string>();
  for (const [first, last] of ranges) for (let line = first; line <= last && touched.size < 500; line++) touched.add(`line:${line}`);
  const changes = placed.map(({ from, to, old }) => ({
    from,
    to,
    insert: old,
    expect: next.slice(from, to),
    prefix: next.slice(Math.max(0, from - ANCHOR_LENGTH), from),
    suffix: next.slice(to, to + ANCHOR_LENGTH),
  }));
  return { text: next, inverse: { op: "edit", changes }, touched: [...touched], ranges };
}

function lineCount(text: string, inserted: string) {
  const lines = inserted.replace(/\n$/, "").split("\n").length;
  return inserted.includes("\n") ? `${lines} line${lines === 1 ? "" : "s"}` : quote(inserted);
}

export interface Applied {
  document: TexDocument;
  inverse: Operation;
  summary: string;
  touched: string[];
}

export function applyOperation(document: TexDocument, operation: Operation): Applied {
  const { text } = document;
  let hunks: Hunk[];
  let say: (committed: Committed) => string;
  switch (operation.op) {
    case "edit":
      hunks = operation.changes.map((change) => locate(text, change));
      say = ({ ranges }) => `Edited ${linesSaid(ranges)}`;
      break;
    case "replace": {
      const found = operation.all ? occurrences(text, operation.find) : [uniqueIndex(text, operation.find, "The text")];
      if (found.length === 0) throw new Error(`The text ${quote(operation.find)} isn't in the document; read the document again, the text may have changed.`);
      hunks = found.map((from) => ({ from, to: from + operation.find.length, insert: operation.with }));
      say = ({ ranges }) =>
        `${operation.with === "" ? `Deleted ${quote(operation.find)}` : `Replaced ${quote(operation.find)} with ${quote(operation.with)}`} ${found.length > 1 ? `in ${found.length} places` : `on ${linesSaid(ranges)}`}`;
      break;
    }
    case "insert": {
      let at: number;
      if (operation.after !== undefined) at = uniqueIndex(text, operation.after, "The text to insert after,") + operation.after.length;
      else if (operation.before !== undefined) at = uniqueIndex(text, operation.before, "The text to insert before,");
      else if (operation.at === "start") at = 0;
      else if (operation.at === "end") at = text.length;
      else {
        const marker = operation.at === "end_of_preamble" ? "\\begin{document}" : "\\end{document}";
        const index = text.search(new RegExp(`^[ \\t]*${marker.replace(/[\\{}]/g, "\\$&")}`, "m"));
        if (index === -1) throw new Error(`The document has no line with ${marker}; insert "after" or "before" a piece of its text instead.`);
        at = index;
      }
      const atLineStart = at === 0 || text[at - 1] === "\n";
      const insert = (operation.at === "end_of_preamble" || operation.at === "end_of_body") && atLineStart && !operation.text.endsWith("\n") ? `${operation.text}\n` : operation.text;
      hunks = [{ from: at, to: at, insert }];
      say = ({ ranges }) => `Inserted ${lineCount(text, insert)} at ${linesSaid(ranges)}`;
      break;
    }
    case "replace_lines": {
      const starts = lineStarts(text);
      const count = starts.length;
      const { from, to } = operation;
      if (from < 1 || from > count + 1 || to < from - 1 || to > count) {
        throw new Error(`replace_lines from ${from} to ${to} is outside the document, which has ${count} lines; "from" is 1 to ${count + 1} and "to" is from - 1 to ${count}.`);
      }
      if (to >= from) {
        const end = to < count ? starts[to]! - 1 : text.length;
        hunks = [{ from: starts[from - 1]!, to: end, insert: operation.text }];
        say = () => `Replaced ${linesSaid([[from, to]])}`;
      } else {
        const atEnd = from === count + 1;
        const insert = atEnd ? `${text.length > 0 && !text.endsWith("\n") ? "\n" : ""}${operation.text}` : `${operation.text}\n`;
        hunks = [{ from: atEnd ? text.length : starts[from - 1]!, to: atEnd ? text.length : starts[from - 1]!, insert }];
        say = ({ ranges }) => `Inserted ${lineCount(text, operation.text + "\n")} at ${linesSaid(ranges)}`;
      }
      break;
    }
    case "set_text":
      hunks = hunksBetween(text, operation.text);
      say = ({ ranges }) => `Rewrote the document (${linesSaid(ranges)})`;
      break;
  }
  if (hunks.length === 0 || hunks.every((hunk) => hunk.from === hunk.to && hunk.insert === "")) {
    return { document, inverse: { op: "edit", changes: [] }, summary: "Nothing changed", touched: [] };
  }
  const committed = commit(text, hunks);
  return { document: { ...document, text: committed.text }, inverse: committed.inverse, summary: say(committed), touched: committed.touched };
}
