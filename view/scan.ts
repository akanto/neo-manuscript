import { closingBrace } from "../core/latex.ts";

/** A part of the text, `from..to`. */
export interface Span {
  from: number;
  to: number;
}

export type Token =
  | { kind: "comment"; from: number; to: number }
  /** Math: `inner` is the formula without its delimiters; `env` is the environment's name for \begin{equation} and its kin. */
  | { kind: "math"; from: number; to: number; inner: Span; display: boolean; env: string | null }
  /** A command with the arguments read for it: `args` are the parts inside the braces, `optional` the one in brackets. */
  | { kind: "command"; name: string; from: number; to: number; star: boolean; optional: Span | null; args: Span[] }
  | { kind: "begin" | "end"; name: string; from: number; to: number }
  /** An environment whose content is not LaTeX, such as verbatim, from its \begin to its \end. */
  | { kind: "verbatim"; name: string; from: number; to: number; inner: Span }
  | { kind: "special"; from: number; to: number; text: string };

/** How many arguments a command takes, and whether its arguments are LaTeX to read on (true) or names and paths (false). */
const COMMANDS: Record<string, { args: number; inside: boolean; optional?: boolean; star?: boolean }> = {};
const define = (names: string, spec: (typeof COMMANDS)[string]) => names.split(" ").forEach((name) => (COMMANDS[name] = spec));
define("part chapter section subsection subsubsection paragraph subparagraph", { args: 1, inside: true, optional: true, star: true });
define("textbf textit emph underline texttt textsc textsf textrm textup textsl textmd mbox caption footnote title author date thanks", { args: 1, inside: true, optional: true });
define("label ref eqref autoref pageref nameref cref Cref url input include bibliography bibliographystyle", { args: 1, inside: false });
define("cite citep citet citeauthor citeyear nocite parencite textcite autocite", { args: 1, inside: false, optional: true, star: true });
define("includegraphics", { args: 1, inside: false, optional: true, star: true });
define("usepackage documentclass", { args: 1, inside: false, optional: true });
define("href", { args: 2, inside: false });
define("newcommand renewcommand providecommand", { args: 2, inside: false, optional: true, star: true });
define("DeclareMathOperator", { args: 2, inside: false, star: true });
define("item", { args: 0, inside: false, optional: true });
define("bibitem", { args: 1, inside: false, optional: true });
define("vspace hspace", { args: 1, inside: false, star: true });

export const MATH_ENVS = new Set(["equation", "align", "gather", "multline", "flalign", "alignat", "eqnarray", "displaymath", "math"].flatMap((name) => [name, `${name}*`]));
const VERBATIM_ENVS = new Set(["verbatim", "verbatim*", "Verbatim", "lstlisting", "minted", "comment"]);

const isLetter = (c: string | undefined) => c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "@");

/** Skips spaces and at most one line break (a blank line ends a command's arguments in LaTeX). */
function skipSpace(text: string, i: number): number {
  let breaks = 0;
  while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n")) {
    if (text[i] === "\n" && ++breaks > 1) break;
    i++;
  }
  return i;
}

/** The bracketed argument at `i`, if any: the span inside and the position after it. */
function bracket(text: string, i: number): { inner: Span; end: number } | null {
  if (text[i] !== "[") return null;
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") j++;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "]" && depth === 0) return { inner: { from: i + 1, to: j }, end: j + 1 };
    else if (c === "\n" && text[j + 1] === "\n") return null;
  }
  return null;
}

/** Where math that opened at `i` with `close` closes, skipping escapes; -1 when a blank line or the end comes first. */
function mathEnd(text: string, i: number, close: string): number {
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") {
      if (text.startsWith(close, j)) return j;
      j++;
    } else if (text.startsWith(close, j)) return j;
    else if (c === "\n" && text[j + 1] === "\n") return -1;
  }
  return -1;
}

/** The tokens of a LaTeX text, in order of where they start. Arguments read on hold tokens of their own, after the command's. */
export function scan(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "%") {
      const end = text.indexOf("\n", i);
      const to = end === -1 ? text.length : end;
      tokens.push({ kind: "comment", from: i, to });
      i = to;
      continue;
    }
    if (c === "$") {
      const display = text[i + 1] === "$";
      const open = display ? 2 : 1;
      const end = mathEnd(text, i + open, display ? "$$" : "$");
      if (end === -1) {
        i += open;
        continue;
      }
      tokens.push({ kind: "math", from: i, to: end + open, inner: { from: i + open, to: end }, display, env: null });
      i = end + open;
      continue;
    }
    if (c === "`" && text[i + 1] === "`") {
      tokens.push({ kind: "special", from: i, to: i + 2, text: "“" });
      i += 2;
      continue;
    }
    if (c === "'" && text[i + 1] === "'") {
      tokens.push({ kind: "special", from: i, to: i + 2, text: "”" });
      i += 2;
      continue;
    }
    if (c === "~") {
      tokens.push({ kind: "special", from: i, to: i + 1, text: "\u00a0" });
      i++;
      continue;
    }
    if (c === "-" && text[i + 1] === "-") {
      const em = text[i + 2] === "-";
      tokens.push({ kind: "special", from: i, to: i + (em ? 3 : 2), text: em ? "—" : "–" });
      i += em ? 3 : 2;
      continue;
    }
    if (c !== "\\") {
      i++;
      continue;
    }

    // A command: a backslash and letters, or a backslash and one other character.
    const from = i;
    let nameEnd = i + 1;
    if (isLetter(text[nameEnd])) while (isLetter(text[nameEnd])) nameEnd++;
    else nameEnd = Math.min(text.length, nameEnd + 1);
    const name = text.slice(i + 1, nameEnd);

    if (name === "(" || name === "[") {
      const close = name === "(" ? "\\)" : "\\]";
      const end = mathEnd(text, nameEnd, close);
      if (end !== -1) {
        tokens.push({ kind: "math", from, to: end + 2, inner: { from: nameEnd, to: end }, display: name === "[", env: null });
        i = end + 2;
        continue;
      }
    }

    if (name === "begin" || name === "end") {
      const open = skipSpace(text, nameEnd);
      const close = text[open] === "{" ? closingBrace(text, open) : -1;
      if (close === -1) {
        i = nameEnd;
        continue;
      }
      const env = text.slice(open + 1, close - 1).trim();
      if (name === "begin" && (MATH_ENVS.has(env) || VERBATIM_ENVS.has(env))) {
        const endMarker = `\\end{${env}}`;
        const endAt = text.indexOf(endMarker, close);
        if (endAt !== -1) {
          const to = endAt + endMarker.length;
          tokens.push(
            MATH_ENVS.has(env)
              ? { kind: "math", from, to, inner: { from: close, to: endAt }, display: true, env }
              : { kind: "verbatim", name: env, from, to, inner: { from: close, to: endAt } },
          );
          i = to;
          continue;
        }
      }
      tokens.push({ kind: name, name: env, from, to: close });
      i = close;
      continue;
    }

    const spec = COMMANDS[name];
    if (!spec) {
      tokens.push({ kind: "command", name, from, to: nameEnd, star: false, optional: null, args: [] });
      i = nameEnd;
      continue;
    }
    let at = nameEnd;
    let star = false;
    if (spec.star && text[at] === "*") {
      star = true;
      at++;
    }
    let optional: Span | null = null;
    if (spec.optional) {
      const found = bracket(text, skipSpace(text, at));
      if (found) {
        optional = found.inner;
        at = found.end;
      }
    }
    const args: Span[] = [];
    for (let n = 0; n < spec.args; n++) {
      const open = skipSpace(text, at);
      if (text[open] !== "{") break;
      const close = closingBrace(text, open);
      if (close === -1) break;
      args.push({ from: open + 1, to: close - 1 });
      at = close;
    }
    const complete = args.length === spec.args;
    tokens.push({ kind: "command", name, from, to: complete ? at : nameEnd + (star ? 1 : 0), star, optional, args: complete ? args : [] });
    // Read on inside the arguments of formatting commands, so that \textbf{a \emph{b}} has both.
    i = complete && spec.inside && args.length > 0 ? args[0]!.from : complete ? at : nameEnd;
  }
  return tokens;
}

/** The simple macros of the preamble, \newcommand{\R}{\mathbb{R}} and \DeclareMathOperator{\tr}{tr}, for KaTeX. */
export function macrosOf(text: string, tokens: Token[]): Record<string, string> {
  const macros: Record<string, string> = {};
  for (const token of tokens) {
    if (token.kind !== "command" || token.args.length !== 2) continue;
    const name = text.slice(token.args[0]!.from, token.args[0]!.to).trim();
    const body = text.slice(token.args[1]!.from, token.args[1]!.to);
    if (!/^\\[A-Za-z]+$/.test(name)) continue;
    if (token.name === "DeclareMathOperator") macros[name] = `\\operatorname${token.star ? "*" : ""}{${body}}`;
    else if (token.name.endsWith("newcommand") || token.name === "providecommand") {
      const count = token.optional ? Number(text.slice(token.optional.from, token.optional.to)) : 0;
      if (Number.isInteger(count) && count >= 0 && count <= 9) macros[name] = body;
    }
  }
  return macros;
}
