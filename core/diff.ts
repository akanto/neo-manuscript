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

/**
 * Where `after` has words that `before` doesn't: the ranges of `after` that were added or changed. Whitespace doesn't
 * count, so reflowing a paragraph or changing indentation marks nothing, and removed words leave no mark.
 */
export function changedRanges(before: string, after: string): { from: number; to: number }[] {
  if (before === after) return [];
  // Each distinct word is one character, and every run of whitespace is the same one, so that a character diff of the
  // two is a diff of their words that doesn't see whitespace.
  const codes = new Map<string, string>();
  const space = String.fromCodePoint(0xe000);
  const tokensOf = (text: string) => text.match(TOKENS) ?? [];
  const encode = (tokens: string[]) =>
    tokens
      .map((token) => {
        if (/^\s/u.test(token)) return space;
        let code = codes.get(token);
        if (code === undefined) {
          code = String.fromCodePoint(0xe001 + codes.size);
          codes.set(token, code);
        }
        return code;
      })
      .join("");
  const tokens = tokensOf(after);
  const ranges: { from: number; to: number }[] = [];
  let index = 0;
  let offset = 0;
  for (const [kind, code] of fastDiff(encode(tokensOf(before)), encode(tokens))) {
    if (kind === fastDiff.DELETE) continue;
    for (const char of code) {
      const token = tokens[index++]!;
      if (kind === fastDiff.INSERT && char !== space) {
        const last = ranges.at(-1);
        // Words added one after another, with only whitespace between them, make one range.
        if (last && /^\s*$/u.test(after.slice(last.to, offset))) last.to = offset + token.length;
        else ranges.push({ from: offset, to: offset + token.length });
      }
      offset += token.length;
    }
  }
  return ranges;
}
