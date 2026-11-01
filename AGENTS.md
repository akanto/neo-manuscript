# Working on NeoManuscript

Notes for anyone (human or agent) changing the code. The README is for users; keep it short and put details here.

## Commands

```bash
bun install
bun run app:prepare      # Electrobun's toolchain and SDK (.hutch/devkit); the typecheck needs it; once per checkout
bun run typecheck
bun test tests           # unit tests; the compile and SyncTeX ones skip without TeX
bun run e2e              # the Mirador view in Chrome (and WebKit framed as Mirador frames it, if Mirador is installed)
bun run app              # desktop app in dev mode (Electrobun)
bun run app:build        # stable build: build/ and artifacts/ (DMG, update files, patch)
bun run build            # the Mirador plugin's view: dist/view.js
bun run harness          # Mirador stand-in at http://127.0.0.1:4810 on examples/paper.tex
bun hosts/desktop/serve.ts <folder>   # the desktop app's server alone, to use the view in a browser
```

`electrobun dev` and `electrobun build` share a lock: stop a running dev app before a stable build.
`NEO_DEBUG=1 bun run app` prints the page's URL and every request the window makes.

## Layout

- `core/`: no host in it. `ops.ts` (operations and their inverses), `compile.ts` (the build), `describe.ts` (the
  document in words for an agent), `agent-tools.ts`, `project.ts` and `project-files.ts` (files, main file),
  `chat.ts` (chat events), and `host-api.ts`: the `HostBridge` the view talks to its host through. A bridge's
  `project` and `chat` parts are optional, and so are most project operations; the view offers only what a host has.
- `view/`: the editor (`main.ts`, `editor.ts`, `visual.ts` on `scan.ts`'s tokens), `sync.ts` (keeps the editor and the
  host's text the same, merging remote changes around the cursor), `pdf.ts` and `synctex.ts`, `files.ts` (the file
  tree), `chat.ts` (the chat panel).
- `hosts/desktop/`: the Electrobun app. `main.ts` (window, menus, dialogs), `server.ts` (127.0.0.1 server the window
  loads the view from, with a per-run token; states go back as server-sent events), `view.ts` (the view's bridge to
  it), `project-host.ts` (a folder: files, main file, builds, watching), `document-host.ts` (one open text file),
  `agents.ts` and `chat.ts` (ACP agents), `updates.ts`, `settings.ts`.
- `hosts/mirador/`: the Mirador plugin. `host.ts` is the AppHost Mirador runs; `api.ts` copies the parts of
  Mirador's plugin API it uses; `project.ts` gives the view the project's files.
- `scripts/`: `build.ts` (bundles a view, with KaTeX's fonts and pdf.js's worker inside, since Mirador's frame loads
  nothing from the network), `build-desktop.ts` (desktop view, agent bundles, notices), `thesaurus.ts` (WordNet),
  `notices.ts` (THIRD-PARTY-NOTICES).

## How things work

- **Build engine**, in order: a `% !TEX program = …` line; `latexmk` if installed; the plain engine with BibTeX or
  Biber between passes; Tectonic. Output goes to `.latex-build/`, with a `<job>.report.json` the view reads. TeX is
  also looked for in `/Library/TeX/texbin`, `/opt/homebrew/bin` and `/usr/local/bin`, as apps started from the Dock
  don't get the shell's PATH.
- **Main file**: `main.tex`, else the only top-level `.tex` with `\documentclass`, else the one named like the
  folder, else the first by name; the user can choose another in the desktop app.
- **Agents (desktop)**: Claude Code via `claude-agent-acp` and pi via `pi-acp`, bundled into `dist/desktop/agents` and
  run with the app's Bun. `pi-acp` doesn't pass MCP servers to pi, so agents edit files with their own tools in the
  project folder; the app sees the changes and credits the agent while its turn runs. Claude's ACP file reads and
  writes go through the open documents. Agents build through `POST /agent/compile` (a `curl` line in the context
  added after the user's first message). Conversations resume with ACP `session/load`; projects open by real path
  because agents file sessions by it.
- **Agents (Mirador)**: `app_state`, `apply` (`replace`, `insert`, `replace_lines`, `set_text`) and `app_run compile`.
  Mirador's view API can't list files or open another file, so builds and the `files` task write
  `.latex-build/project.json` for the view.
- **Updates**: `release.baseUrl` in `electrobun.config.ts` (GitHub `releases/latest/download`). `updates.ts` also ends
  the launcher Electrobun 2.0.5 leaves behind on the first start, which otherwise stops the app from relaunching after
  an update.

## Releasing

Bump `version` in `package.json`, commit, and push a matching tag: `git tag v0.2.0 && git push origin main v0.2.0`.
`.github/workflows/release.yml` builds on macOS and publishes the DMG and update files as the latest release. To try
an update locally, build two versions with `NEO_RELEASE_BASE_URL=http://127.0.0.1:8765` and serve the newer one's
`artifacts/` there while the older one runs.

## Conventions

- Bun and TypeScript throughout; no Node-only tooling.
- Comments and messages in plain, short sentences that say what a thing is or does.
- Run the typecheck and unit tests before committing; run `bun run e2e` when the view changes.
