import { describe, expect, test } from "bun:test";
import { packedThesaurus } from "../scripts/thesaurus.ts";
import { matchCase, Thesaurus, unpackThesaurus } from "../view/thesaurus.ts";

const SAMPLE = [
  "v|reduce#1.102,cut down,trim|@3|cut down on; make a reduction in",
  "v|simplify,reduce#2.5||make less complex",
  "n|layout,design||a plan or design of something that is laid out",
  "v|decrease,lessen,minify||make smaller",
  "v|go,travel||change location",
  "a|large,big|&6|above average in size",
  "a|huge,immense||unusually great in size",
  "#exc",
  "v|went|go",
  "v|gone|go",
  "v|trimmed|trim",
  "a|larger|large",
].join("\n");

describe("Thesaurus", () => {
  const thesaurus = Thesaurus.parse(SAMPLE);

  test("looks an inflected word up by its base form, and says how it was inflected", () => {
    expect(thesaurus.bases("reduces")).toEqual([{ lemma: "reduce", pos: "v", form: "s" }]);
    expect(thesaurus.bases("reducing")).toEqual([{ lemma: "reduce", pos: "v", form: "ing" }]);
    expect(thesaurus.bases("layouts")).toEqual([{ lemma: "layout", pos: "n", form: "s" }]);
    expect(thesaurus.bases("went")).toEqual([{ lemma: "go", pos: "v", form: "ed" }]);
    expect(thesaurus.bases("gone")).toEqual([{ lemma: "go", pos: "v", form: "en" }]);
    expect(thesaurus.bases("Cuts  down")).toEqual([{ lemma: "cut down", pos: "v", form: "s" }]);
    expect(thesaurus.bases("compaction")).toEqual([]);
  });

  test("gives the synonyms in the selection's form, the most used sense first", () => {
    const senses = thesaurus.lookup("reduces");
    expect(senses.map((sense) => sense.definition)).toEqual(["cut down on; make a reduction in", "make less complex"]);
    expect(senses[0]).toMatchObject({ lemma: "reduce", pos: "v", form: "s", synonyms: ["cuts down", "trims"], related: ["decreases", "lessens", "minifies"] });
    expect(senses[1]!.synonyms).toEqual(["simplifies"]);
    expect(thesaurus.lookup("reduced")[0]!.synonyms).toEqual(["cut down", "trimmed"]);
  });

  test("inflects by WordNet's irregular forms, else by the spelling rules", () => {
    expect(thesaurus.inflect("go", "v", "ed")).toBe("went");
    expect(thesaurus.inflect("go", "v", "en")).toBe("gone");
    expect(thesaurus.inflect("go", "v", "s")).toBe("goes");
    expect(thesaurus.inflect("cut down", "v", "ed")).toBe("cut down");
    expect(thesaurus.inflect("simplify", "v", "s")).toBe("simplifies");
    expect(thesaurus.inflect("simplify", "v", "ed")).toBe("simplified");
    expect(thesaurus.inflect("decrease", "v", "ing")).toBe("decreasing");
    expect(thesaurus.inflect("have", "v", "s")).toBe("has");
    expect(thesaurus.inflect("data set", "n", "s")).toBe("data sets");
    expect(thesaurus.inflect("large", "a", "er")).toBe("larger");
  });

  test("adds similar adjectives", () => {
    expect(thesaurus.lookup("large")[0]).toMatchObject({ synonyms: ["big"], related: ["huge", "immense"] });
  });

  test("gives a suggestion the selection's capitals", () => {
    expect(matchCase("Reduces", "lowers")).toBe("Lowers");
    expect(matchCase("RAR", "ratio")).toBe("RATIO");
    expect(matchCase("reduces", "Lowers")).toBe("Lowers");
    expect(matchCase("A", "one")).toBe("One");
  });
});

describe("Thesaurus, from WordNet", async () => {
  const thesaurus = await unpackThesaurus(await packedThesaurus());
  const synonymsOf = (word: string) => thesaurus.lookup(word).flatMap((sense) => sense.synonyms);

  test("finds the words of the paper, in their form", () => {
    expect(synonymsOf("reduced")).toEqual(expect.arrayContaining(["cut down", "trimmed", "brought down"]));
    expect(synonymsOf("went")).toContain("went away");
    expect(synonymsOf("gone")).toContain("gone away");
    expect(synonymsOf("has")).toContain("holds");
    expect(synonymsOf("children")).toContain("kids");
    expect(synonymsOf("stopped")).toContain("quit");
    expect(thesaurus.lookup("data")[0]).toMatchObject({ lemma: "data", form: "", synonyms: ["information"] });
  });
});
