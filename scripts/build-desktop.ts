/** Builds the desktop app's view into dist/desktop; Electrobun runs it before every build (see electrobun.config.ts). */
import { join } from "node:path";
import { buildView } from "./build.ts";
import { thirdPartyNotices } from "./notices.ts";
import { manifestFromLock, MANIFEST_NAME } from "../hosts/desktop/claude-code.ts";

const repo = join(import.meta.dir, "..");
const output = await buildView(join(repo, "dist", "desktop"), join(repo, "hosts", "desktop", "view.ts"));
console.log(`${output.path}: ${(output.size / 1024 / 1024).toFixed(2)} MB`);

// The agents' ACP sides, one file each, which the app runs with its own Bun (see hosts/desktop/agents.ts).
const AGENTS = {
  "claude-agent-acp": "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
  "pi-acp": "node_modules/pi-acp/dist/index.js",
};
await Bun.write(join(repo, "dist", "desktop", "THIRD-PARTY-NOTICES.txt"), thirdPartyNotices(repo));

for (const [name, entry] of Object.entries(AGENTS)) {
  const result = await Bun.build({ entrypoints: [join(repo, entry)], target: "bun", format: "esm", outdir: join(repo, "dist", "desktop", "agents"), naming: `${name}.js` });
  if (!result.success) throw new Error(`Building ${name} failed:\n${result.logs.join("\n")}`);
  console.log(`${result.outputs[0]!.path}: ${(result.outputs[0]!.size / 1024 / 1024).toFixed(2)} MB`);
}

// The Claude Code to fetch when the user has none: the SDK's version claude-agent-acp is built with, and its hashes.
const manifest = manifestFromLock(await Bun.file(join(repo, "bun.lock")).text());
await Bun.write(join(repo, "dist", "desktop", "agents", MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Claude Code to fetch when missing: ${manifest.version}, for ${Object.keys(manifest.integrity).join(", ")}`);
