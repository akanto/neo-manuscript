/**
 * Synonyms from WordNet, for the word or phrase the writer selects. The data is the text `scripts/thesaurus.ts` makes:
 * one synset per line, then WordNet's exceptions to its inflection rules. A selected word in an inflected form ("reduces",
 * "stopped") is looked up by its base form, and every suggestion comes back in the same form ("lowers", "halted").
 */

export type Pos = "n" | "v" | "a" | "r";
/**
 * How a word is inflected from its base form; a suggestion gets the same inflection. "en" is an irregular participle
 * ("gone", "taken"), told apart from the past ("went") so that a suggestion keeps the same one.
 */
export type Form = "" | "s" | "ed" | "en" | "ing" | "er" | "est";

export interface Sense {
  /** The base form the selection was looked up as, and how the selection inflects it. */
  lemma: string;
  pos: Pos;
  form: Form;
  definition: string;
  /** The other words of the synset, inflected as the selection is. */
  synonyms: string[];
  /** Words one level more general (nouns and verbs), or similar adjectives. */
  related: string[];
}

interface Indexed {
  id: number;
  sense: number;
  tags: number;
}

/** WordNet's detachment rules: an ending, what replaces it in the base form, and the inflection that ending marks. */
const RULES: Record<Pos, [string, string, Form][]> = {
  n: [["ses", "s", "s"], ["xes", "x", "s"], ["zes", "z", "s"], ["ches", "ch", "s"], ["shes", "sh", "s"], ["men", "man", "s"], ["ies", "y", "s"], ["s", "", "s"]],
  v: [["ies", "y", "s"], ["es", "e", "s"], ["es", "", "s"], ["s", "", "s"], ["ed", "e", "ed"], ["ed", "", "ed"], ["ing", "e", "ing"], ["ing", "", "ing"]],
  a: [["er", "", "er"], ["est", "", "est"], ["er", "e", "er"], ["est", "e", "est"]],
  r: [],
};

const POS_ORDER: Pos[] = ["v", "n", "a", "r"];

/** The inflection an irregular form has: "running" is -ing, "has" the third person, "ran" the past, "taken" a participle. */
function irregularForm(pos: Pos, inflected: string): Form {
  if (pos === "n") return "s";
  if (pos === "v") {
    if (inflected.endsWith("ing")) return "ing";
    if (inflected.endsWith("s") && inflected !== "was") return "s";
    return /n$|ne$/.test(inflected) ? "en" : "ed";
  }
  return inflected.endsWith("st") ? "est" : "er";
}

/** Verbs whose past is the base form, which WordNet's exceptions leave out, as its rules never need to undo them. */
const SAME_PAST = new Set("bet broadcast burst cast cost cut fit hit hurt let put quit rid set shed shut slit split spread thrust upset".split(" "));

/** Verbs whose third person WordNet's exceptions don't list, as they list only what its rules can't take apart. */
const THIRD_PERSON: Record<string, string> = { be: "is", have: "has" };

/** A word inflected by the regular rules of English spelling. */
function regular(word: string, pos: Pos, form: Form): string {
  switch (form) {
    case "":
      return word;
    case "s":
      if (pos === "v" && THIRD_PERSON[word]) return THIRD_PERSON[word];
      if (/(s|x|z|ch|sh)$/.test(word) || (pos === "v" && /[^aeiou]o$/.test(word))) return `${word}es`;
      return /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`;
    case "ed":
    case "en":
      if (pos === "v" && SAME_PAST.has(word)) return word;
      if (word.endsWith("e")) return `${word}d`;
      return /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ied` : `${word}ed`;
    case "ing":
      if (word.endsWith("ie")) return `${word.slice(0, -2)}ying`;
      return /[^e]e$/.test(word) ? `${word.slice(0, -1)}ing` : `${word}ing`;
    case "er":
    case "est":
      if (word.endsWith("e")) return `${word}${form.slice(1)}`;
      return /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}i${form}` : `${word}${form}`;
  }
}

export class Thesaurus {
  private constructor(
    private readonly synsets: string[],
    private readonly index: Map<string, Indexed[]>,
    /** Inflected form to its base forms, per part of speech. */
    private readonly baseForms: Map<string, string[]>,
    /** Base form to its irregular inflected forms, per part of speech. */
    private readonly irregular: Map<string, string[]>,
  ) {}

  static parse(text: string): Thesaurus {
    const lines = text.split("\n");
    const end = lines.indexOf("#exc");
    const synsets = end < 0 ? lines : lines.slice(0, end);
    const index = new Map<string, Indexed[]>();
    synsets.forEach((line, id) => {
      const pos = line.charAt(0);
      const words = line.slice(2, line.indexOf("|", 2));
      for (const entry of words.split(",")) {
        const [word, rank] = entry.split("#");
        const [sense, tags] = rank ? rank.split(".").map(Number) : [1, 0];
        const key = `${pos} ${word!.toLowerCase()}`;
        const list = index.get(key) ?? [];
        list.push({ id, sense: sense!, tags: tags! });
        index.set(key, list);
      }
    });
    const baseForms = new Map<string, string[]>();
    const irregular = new Map<string, string[]>();
    for (const line of end < 0 ? [] : lines.slice(end + 1)) {
      const [pos, inflected, baseList] = line.split("|");
      if (!pos || !inflected || !baseList) continue;
      const list = baseList.split(",");
      baseForms.set(`${pos} ${inflected}`, list);
      for (const base of list) {
        const forms = irregular.get(`${pos} ${base}`) ?? [];
        forms.push(inflected);
        irregular.set(`${pos} ${base}`, forms);
      }
    }
    return new Thesaurus(synsets, index, baseForms, irregular);
  }

  /** The base forms the text can be an inflection of, with the inflection: WordNet's morphy. */
  bases(text: string): { lemma: string; pos: Pos; form: Form }[] {
    const key = text.trim().toLowerCase().replace(/\s+/g, " ");
    const found: { lemma: string; pos: Pos; form: Form }[] = [];
    const add = (lemma: string, pos: Pos, form: Form) => {
      if (this.index.has(`${pos} ${lemma}`) && !found.some((known) => known.lemma === lemma && known.pos === pos)) found.push({ lemma, pos, form });
    };
    for (const pos of POS_ORDER) {
      // A word that is a base form itself isn't also taken for an inflection: "data" is data, not the plural of datum.
      if (this.index.has(`${pos} ${key}`)) {
        add(key, pos, "");
        continue;
      }
      for (const { base, form } of this.detach(key, pos)) add(base, pos, form);
      // A phrase inflects its verb at the front ("cuts down") and its noun at the end ("data sets").
      const words = key.split(" ");
      if (words.length > 1 && (pos === "v" || pos === "n")) {
        const at = pos === "v" ? 0 : words.length - 1;
        for (const { base, form } of this.detach(words[at]!, pos)) add(words.map((word, i) => (i === at ? base : word)).join(" "), pos, form);
      }
    }
    return found;
  }

  /** What base forms a word could be inflected from, by WordNet's exceptions and its rules, found in the index or not. */
  private detach(word: string, pos: Pos): { base: string; form: Form }[] {
    const found = (this.baseForms.get(`${pos} ${word}`) ?? []).map((base) => ({ base, form: irregularForm(pos, word) }));
    for (const [ending, replacement, form] of RULES[pos]) {
      if (word.endsWith(ending) && word.length > ending.length) found.push({ base: word.slice(0, -ending.length) + replacement, form });
    }
    return found;
  }

  /** The word in the form given: from WordNet's irregular forms when it has one, else by the spelling rules. */
  inflect(word: string, pos: Pos, form: Form): string {
    if (form === "") return word;
    const words = word.split(" ");
    if (words.length > 1) {
      const at = pos === "v" ? 0 : words.length - 1;
      return words.map((single, i) => (i === at ? this.inflect(single, pos, form) : single)).join(" ");
    }
    const forms = this.irregular.get(`${pos} ${word.toLowerCase()}`) ?? [];
    if (pos === "v" && (form === "ed" || form === "en")) {
      if (SAME_PAST.has(word.toLowerCase())) return word;
      // The past and the participle stand in for each other where a verb has only one of them irregular.
      const past = forms.filter((inflected) => irregularForm(pos, inflected) === "ed" || irregularForm(pos, inflected) === "en");
      return past.find((inflected) => irregularForm(pos, inflected) === form) ?? past[0] ?? regular(word, pos, form);
    }
    // The third person of a verb is regular apart from be and have, which the spelling rules know.
    if (pos === "v" && form === "s") return regular(word, pos, form);
    return forms.find((inflected) => irregularForm(pos, inflected) === form) ?? regular(word, pos, form);
  }

  /** The senses of the text, most used first, each with its synonyms in the text's form. */
  lookup(text: string): Sense[] {
    const senses: (Sense & { order: [number, number] })[] = [];
    const seen = new Set<number>();
    for (const { lemma, pos, form } of this.bases(text)) {
      for (const { id, sense, tags } of this.index.get(`${pos} ${lemma}`) ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        const [, words, links, definition] = this.synsets[id]!.split("|");
        const others = (list: string) => list.split(",").map((entry) => entry.split("#")[0]!).filter((word) => word.toLowerCase() !== lemma);
        const synonyms = others(words!).map((word) => this.inflect(word, pos, form));
        const related = links!
          .split(" ")
          .filter(Boolean)
          .flatMap((link) => others(this.synsets[Number(link.slice(1))]!.split("|")[1]!))
          .filter((word, i, all) => all.indexOf(word) === i && !synonyms.includes(word))
          .slice(0, 8)
          .map((word) => this.inflect(word, pos, form));
        if (synonyms.length === 0 && related.length === 0) continue;
        senses.push({ lemma, pos, form, definition: definition!, synonyms, related, order: [-tags, sense] });
      }
    }
    senses.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);
    return senses.map(({ order: _, ...sense }) => sense);
  }
}

/** Gives a suggestion the capitals of the selection it replaces: "Reduce" becomes "Lower", "RAR" stays upper case. */
export function matchCase(selected: string, word: string): string {
  if (selected.length > 1 && selected === selected.toUpperCase() && selected !== selected.toLowerCase()) return word.toUpperCase();
  if (/^\p{Lu}/u.test(selected) && word === word.toLowerCase()) return word.charAt(0).toUpperCase() + word.slice(1);
  return word;
}

/** The thesaurus from its packed form: gzipped, in base64. */
export async function unpackThesaurus(packed: string): Promise<Thesaurus> {
  const bytes = Uint8Array.from(atob(packed), (char) => char.charCodeAt(0));
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  return Thesaurus.parse(text);
}
