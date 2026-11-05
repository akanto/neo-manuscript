import fastDiff from "fast-diff";

/** A replacement of `from..to` of the old text with `insert`. */
export interface Hunk {
  from: number;
  to: number;
  insert: string;
}

/** The replacements that turn `before` into `after`, in order, none touching another. */
export function hunksBetween(before: string, after: string): Hunk[] {
  if (before === after) return [];
  const hunks: Hunk[] = [];
  let position = 0;
  let open: Hunk | null = null;
  for (const [kind, text] of fastDiff(before, after)) {
    if (kind === fastDiff.EQUAL) {
      if (open) hunks.push(open);
      open = null;
      position += text.length;
    } else {
      open ??= { from: position, to: position, insert: "" };
      if (kind === fastDiff.DELETE) {
        position += text.length;
        open.to = position;
      } else open.insert += text;
    }
  }
  if (open) hunks.push(open);
  return hunks;
}

/** A piece of a word diff: text both have, text only the old one has, or text only the new one has. */
export interface DiffPart {
  kind: "same" | "removed" | "added";
  text: string;
}

const TOKENS = /\s+|\\[A-Za-z@]+|[\p{L}\p{N}'’-]+|./gsu;

/** The difference between two texts word by word, as a reader wants to see it: whole words removed and added. */
export function wordDiff(before: string, after: string): DiffPart[] {
  // Each distinct word becomes one character, so a character diff of the two is a diff of their words.
  const codes = new Map<string, string>();
  const words: string[] = [];
  const encode = (text: string) =>
    (text.match(TOKENS) ?? [])
      .map((token) => {
        let code = codes.get(token);
        if (code === undefined) {
          code = String.fromCodePoint(0xe000 + words.length);
          codes.set(token, code);
          words.push(token);
        }
        return code;
      })
      .join("");
  const decode = (code: string) => [...code].map((char) => words[char.codePointAt(0)! - 0xe000]).join("");
  const parts: DiffPart[] = [];
  for (const [kind, code] of fastDiff(encode(before), encode(after))) {
    const part: DiffPart = { kind: kind === fastDiff.EQUAL ? "same" : kind === fastDiff.DELETE ? "removed" : "added", text: decode(code) };
    const last = parts.at(-1);
    if (last && last.kind === part.kind) last.text += part.text;
    else parts.push(part);
  }
  return parts;
}
