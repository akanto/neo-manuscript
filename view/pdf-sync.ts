import { commentStart } from "../core/latex.ts";

/** The words of a text, lower case, without accents, ligatures or punctuation. */
function wordsOf(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3);
}

/** A source line as the words it would print: commands' names dropped, their arguments kept. */
function printedWords(line: string): string[] {
  return wordsOf(line.slice(0, commentStart(line)).replace(/\\[A-Za-z@]+\*?/g, " "));
}

/**
 * The source line a line of the PDF most likely came from: the one sharing the most of its words, in pairs that follow
 * each other, so that a line of common words doesn't win. Without SyncTeX this is a guess, good for running text.
 */
export function lineForPdfText(source: string, pdfText: string): number | null {
  const words = wordsOf(pdfText);
  if (words.length === 0) return null;
  const pairs = new Set(words.slice(1).map((word, index) => `${words[index]} ${word}`));
  const wanted = new Set(words);
  let best: { line: number; score: number } | null = null;
  source.split("\n").forEach((line, index) => {
    const printed = printedWords(line);
    if (printed.length === 0) return;
    let score = 0;
    printed.forEach((word, at) => {
      if (wanted.has(word)) score += 1;
      if (at > 0 && pairs.has(`${printed[at - 1]} ${word}`)) score += 2;
    });
    if (score > 0 && (!best || score > best.score)) best = { line: index + 1, score };
  });
  return (best as { line: number } | null)?.line ?? null;
}
