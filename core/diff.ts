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
