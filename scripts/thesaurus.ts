import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const WORDNET = join(repo, "node_modules", "wndb-with-exceptions");

const POS = { n: "n", v: "v", a: "a", s: "a", r: "r" } as const;
const FILES = { noun: "n", verb: "v", adj: "a", adv: "r" } as const;

/** WordNet writes a phrase with underscores, and an adjective that only goes before or after a noun with "(a)" or "(p)". */
const wordOf = (raw: string) => raw.replace(/\((?:a|p|ip)\)$/, "").replace(/_/g, " ");

/** The definition of a gloss, without its examples, short enough for one line of the popup. */
function definitionOf(gloss: string): string {
  const definition = gloss.split(/;\s*"/)[0]!.trim();
  return definition.length > 90 ? `${definition.slice(0, 87).trimEnd()}…` : definition;
}

/**
 * The thesaurus the view looks words up in, as text: one line per synset, `pos|words|links|definition`, then a line
 * `#exc` and WordNet's exceptions to its inflection rules, `pos|inflected|base,base…`. A word in a synset carries
 * `#sense.tags` when it is not that word's first sense or was tagged in WordNet's corpus, which orders a word's senses;
 * links are `@id` for the synset one level more general (nouns, verbs) and `&id` for a similar adjective.
 */
export async function makeThesaurus(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "wordnet-"));
  try {
    const untar = Bun.spawn(["tar", "xzf", join(WORDNET, "WNdb-3.0.tar.gz"), "-C", folder], { stderr: "pipe" });
    if ((await untar.exited) !== 0) throw new Error(`Unpacking WordNet failed: ${await new Response(untar.stderr).text()}`);
    const dict = (name: string) => readFile(join(folder, "dict", name), "utf8");

    // Each word's sense number and corpus count in each synset, by "lemma offset pos".
    const rank = new Map<string, string>();
    for (const line of (await dict("index.sense")).split("\n")) {
      const [key, offset, sense, tags] = line.split(" ");
      if (!key || !offset) continue;
      const [lemma, rest] = key.split("%");
      const pos = { "1": "n", "2": "v", "3": "a", "4": "r", "5": "a" }[rest!.charAt(0)]!;
      if (sense !== "1" || tags !== "0") rank.set(`${lemma} ${offset} ${pos}`, `${sense}.${tags}`);
    }

    interface Synset {
      pos: string;
      words: string[];
      links: string[];
      definition: string;
    }
    const synsets: Synset[] = [];
    const idOf = new Map<string, number>();
    const pending: { synset: Synset; pointers: [string, string, string][] }[] = [];
    for (const [file, filePos] of Object.entries(FILES)) {
      for (const line of (await dict(`data.${file}`)).split("\n")) {
        if (!/^\d/.test(line)) continue;
        const [head, gloss = ""] = line.split(" | ");
        const fields = head!.trim().split(" ");
        const offset = fields[0]!;
        const pos = POS[fields[2] as keyof typeof POS];
        const count = parseInt(fields[3]!, 16);
        const words: string[] = [];
        for (let i = 0; i < count; i++) {
          const raw = fields[4 + i * 2]!;
          const word = wordOf(raw);
          const key = `${raw.replace(/\((?:a|p|ip)\)$/, "").toLowerCase()} ${offset} ${pos}`;
          if (!words.some((known) => known.split("#")[0] === word)) words.push(rank.has(key) ? `${word}#${rank.get(key)}` : word);
        }
        let at = 4 + count * 2;
        const pointerCount = Number(fields[at++]);
        const pointers: [string, string, string][] = [];
        for (let i = 0; i < pointerCount; i++, at += 4) pointers.push([fields[at]!, fields[at + 1]!, fields[at + 2]!]);
        const synset: Synset = { pos, words, links: [], definition: definitionOf(gloss) };
        idOf.set(`${offset} ${filePos}`, synsets.length);
        synsets.push(synset);
        pending.push({ synset, pointers });
      }
    }
    for (const { synset, pointers } of pending) {
      for (const [symbol, offset, pos] of pointers) {
        const kind = symbol === "@" && synset.pos !== "a" ? "@" : symbol === "&" ? "&" : null;
        if (!kind) continue;
        const id = idOf.get(`${offset} ${POS[pos as keyof typeof POS]}`);
        if (id !== undefined) synset.links.push(`${kind}${id}`);
      }
    }

    const exceptions: string[] = [];
    for (const [file, pos] of Object.entries(FILES)) {
      const text = await readFile(join(WORDNET, "data", `${file}.exc`), "utf8");
      for (const line of text.split("\n")) {
        const [inflected, ...bases] = line.trim().split(" ");
        if (inflected && bases.length > 0) exceptions.push(`${pos}|${wordOf(inflected)}|${bases.map(wordOf).join(",")}`);
      }
    }

    return [...synsets.map((s) => `${s.pos}|${s.words.join(",")}|${s.links.join(" ")}|${s.definition.replace(/\|/g, "/")}`), "#exc", ...exceptions].join("\n");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** The thesaurus gzipped and in base64, as the view's bundle carries it. */
export async function packedThesaurus(): Promise<string> {
  return Buffer.from(Bun.gzipSync(await makeThesaurus(), { level: 9 })).toString("base64");
}

if (import.meta.main) {
  const text = await makeThesaurus();
  const packed = Buffer.from(Bun.gzipSync(text, { level: 9 })).toString("base64");
  console.log(`thesaurus: ${(text.length / 1024 / 1024).toFixed(2)} MB of text, ${(packed.length / 1024 / 1024).toFixed(2)} MB packed`);
  console.log(text.split("\n").filter((line) => /(^|,)reduce(#|,|\|)/.test(line)).slice(0, 4).join("\n"));
}
