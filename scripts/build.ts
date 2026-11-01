import type { BunPlugin } from "bun";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { packedThesaurus } from "./thesaurus.ts";

const repo = join(import.meta.dir, "..");

/**
 * KaTeX's styles with its fonts inside as data: URLs, as a string: the canvas frame loads fonts only from data: URLs.
 * Only the woff2 files go in; every browser Mirador runs in reads them.
 */
const katexStyles: BunPlugin = {
  name: "katex styles with fonts inside",
  setup(build) {
    build.onLoad({ filter: /katex(\.min)?\.css$/ }, async ({ path }) => {
      const css = await readFile(path, "utf8");
      const fonts = new Map<string, string>();
      for (const [, file] of css.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)) {
        if (!fonts.has(file!)) fonts.set(file!, (await readFile(join(dirname(path), file!))).toString("base64"));
      }
      const inlined = css.replace(/src:([^;}]*)/g, (_whole, sources: string) => {
        const woff2 = /url\((fonts\/[^)]+\.woff2)\)/.exec(sources)?.[1];
        return woff2 ? `src:url(data:font/woff2;base64,${fonts.get(woff2)}) format("woff2")` : `src:${sources}`;
      });
      return { contents: `export default ${JSON.stringify(inlined)};`, loader: "js" };
    });
  },
};

/** WordNet for the synonyms, made from the wndb-with-exceptions package as the view is built. */
const thesaurus: BunPlugin = {
  name: "thesaurus",
  setup(build) {
    build.onResolve({ filter: /^thesaurus:packed$/ }, () => ({ path: "packed", namespace: "thesaurus" }));
    build.onLoad({ filter: /.*/, namespace: "thesaurus" }, async () => ({ contents: `export default ${JSON.stringify(await packedThesaurus())};`, loader: "js" }));
  },
};

/**
 * Bundles a host's view entry (Mirador's by default) into `<outdir>/view.js`: one ES module with its styles, fonts and
 * pdf.js's worker inside.
 *
 * Mirador loads the view from its assets origin into a sandboxed frame, whose origin is opaque, so WebKit hides the
 * message of every error the view throws ("A script on the page threw an error"). So view.js only holds the bundle as
 * text and runs it from a blob: URL the frame makes, which is the frame's own origin: its errors then say what they are.
 */
export async function buildView(outdir: string, entry = join(repo, "hosts", "mirador", "view.ts")) {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    minify: true,
    splitting: false,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [katexStyles, thesaurus],
  });
  if (!result.success) throw new Error(`Building the view failed:\n${result.logs.join("\n")}`);
  if (result.outputs.length !== 1) throw new Error(`Expected one output file, got ${result.outputs.map((output) => output.path).join(", ")}`);
  const bundle = await result.outputs[0]!.text();
  const loader = `const code = ${JSON.stringify(bundle)};
import(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
`;
  const path = join(outdir, "view.js");
  await Bun.write(path, loader);
  // The view carries a copy of WordNet, and WordNet's license has to go with every copy.
  await Bun.write(join(outdir, "WORDNET-LICENSE"), Bun.file(join(repo, "node_modules", "wndb-with-exceptions", "LICENSE")));
  return { path, size: loader.length };
}

if (import.meta.main) {
  const output = await buildView(join(repo, "dist"));
  console.log(`${output.path}: ${(output.size / 1024 / 1024).toFixed(2)} MB`);
}
