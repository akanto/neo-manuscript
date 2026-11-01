import type { ElectrobunConfig } from "electrobun";
import pkg from "./package.json" with { type: "json" };

export default {
  app: {
    name: "NeoManuscript",
    identifier: "com.akanto.neo-manuscript",
    // package.json has the version; a release's tag is it with a v (see .github/workflows/release.yml).
    version: pkg.version,
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "hosts/desktop/main.ts",
    },
    copy: {
      // Built by the preBuild script below: the window loads the view from the app's server, not as an Electrobun view.
      "dist/desktop/view.js": "views/neo-manuscript/view.js",
      "dist/desktop/WORDNET-LICENSE": "views/neo-manuscript/WORDNET-LICENSE",
      "dist/desktop/THIRD-PARTY-NOTICES.txt": "views/neo-manuscript/THIRD-PARTY-NOTICES.txt",
      LICENSE: "views/neo-manuscript/LICENSE",
      "dist/desktop/agents": "views/neo-manuscript/agents",
    },
    watch: ["core", "view", "hosts/desktop"],
    mac: { bundleCEF: false },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
  scripts: {
    preBuild: "scripts/build-desktop.ts",
  },
  release: {
    // Where the app looks for its updates: the files `electrobun build` leaves in artifacts/, published as they are on
    // the latest GitHub release. NEO_RELEASE_BASE_URL puts them elsewhere, as for trying an update out locally.
    baseUrl: process.env.NEO_RELEASE_BASE_URL ?? "https://github.com/akanto/neo-manuscript/releases/latest/download",
  },
} satisfies ElectrobunConfig;
