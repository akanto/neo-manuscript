/**
 * THIRD-PARTY-NOTICES for the desktop app, which carries the code of its dependencies: each production dependency,
 * however deep, with its license and the license's text where the package has one. NeoManuscript's own code is under
 * the MIT license (LICENSE); these packages are under their own.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface Manifest {
  name: string;
  version: string;
  license?: string | { type: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** Where Node would find a package from a folder: its node_modules, then its parents'. */
function packageFolder(name: string, from: string): string | null {
  for (let folder = from; ; folder = dirname(folder)) {
    const candidate = join(folder, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(folder) === folder) return null;
  }
}

export function thirdPartyNotices(repo: string): string {
  const own = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as Manifest;
  const found = new Map<string, { manifest: Manifest; folder: string }>();
  const visit = (name: string, from: string) => {
    const folder = packageFolder(name, from);
    if (!folder || found.has(folder)) return;
    const manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as Manifest;
    found.set(folder, { manifest, folder });
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) visit(dependency, folder);
  };
  for (const dependency of Object.keys(own.dependencies ?? {})) visit(dependency, repo);

  const sections = [...found.values()]
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
    .map(({ manifest, folder }) => {
      const license = typeof manifest.license === "object" ? manifest.license.type : (manifest.license ?? "unknown");
      const file = readdirSync(folder).find((name) => /^(licen[sc]e|copying)(\.|$)/i.test(name));
      const text = file ? readFileSync(join(folder, file), "utf8").trim() : license.startsWith("SEE LICENSE") ? `See ${manifest.name}'s ${license.slice("SEE LICENSE IN ".length)}.` : "";
      return `${manifest.name} ${manifest.version} — ${license}\n${"-".repeat(72)}\n${text}`;
    });
  return [
    "NeoManuscript is under the MIT license. It carries the code of these packages, each under its own license.",
    "The Claude Agent SDK (@anthropic-ai/claude-agent-sdk) is under Anthropic's Commercial Terms of Service:",
    "https://www.anthropic.com/legal/commercial-terms. WordNet's license is in WORDNET-LICENSE.",
    "",
    ...sections,
  ].join("\n\n");
}
