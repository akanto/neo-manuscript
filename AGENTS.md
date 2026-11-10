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
bun run screenshots      # screenshots/*.png for Mirador's plugin store, from the harness in Chrome
```

`electrobun dev` and `electrobun build` share a lock: stop a running dev app before a stable build.
`NEO_DEBUG=1 bun run app` prints the page's URL and every request the window makes.

To try a checkout in Mirador instead of the store's version, build the view and link the checkout as a plugin, then
restart Mirador:

```bash
bun run build
ln -s "$PWD" ~/.mirador/plugins/neo-manuscript
```

## Layout

- `core/`: no host in it. `ops.ts` (operations and their inverses), `compile.ts` (the build), `describe.ts` (the
  document in words for an agent), `agent-tools.ts`, `project.ts` and `project-files.ts` (files, main file),
  `chat.ts` (chat events), and `host-api.ts`: the `HostBridge` the view talks to its host through. A bridge's
  `project` and `chat` parts are optional, and so are most project operations; the view offers only what a host has.
- `view/`: the editor (`main.ts`, `editor.ts`, `visual.ts` on `scan.ts`'s tokens; `markdown.ts` for Markdown files:
  their highlighting, Visual mode, commands and the preview shown in place of the PDF), `sync.ts` (keeps the editor and the
  host's text the same, merging remote changes around the cursor), `pdf.ts` and `synctex.ts`, `files.ts` (the file
  tree), `chat.ts` (the chat panel).
- `hosts/desktop/`: the Electrobun app. `main.ts` (window, menus, dialogs), `server.ts` (127.0.0.1 server the window
  loads the view from, with a per-run token; states go back as server-sent events), `view.ts` (the view's bridge to
  it), `project-host.ts` (a folder: files, main file, builds, watching), `document-host.ts` (one open text file),
  `agents.ts` and `chat.ts` (ACP agents), `updates.ts`, `settings.ts`.
- `hosts/mirador/`: the Mirador plugin (plugin API 6). `host.ts` is the AppHost Mirador runs; `api.ts` copies the parts
  of Mirador's plugin API it uses; `project.ts` gives the view the workspace as its project.
- `scripts/`: `build.ts` (bundles a view, with KaTeX's fonts and pdf.js's worker inside, since Mirador's frame loads
  nothing from the network), `build-desktop.ts` (desktop view, agent bundles, notices), `thesaurus.ts` (WordNet),
  `notices.ts` (THIRD-PARTY-NOTICES).

## How things work

- **Build engine**: a `% !TEX program = …` line names it: `tectonic`, `latexmk` (latexmk with pdflatex), or
  `pdflatex`/`xelatex`/`lualatex` through latexmk, else the plain engine with BibTeX or Biber between passes. Without
  the line, latexmk builds when it is installed, else an installed Tectonic, else pdflatex, else a downloaded Tectonic.
  Tectonic runs with `--keep-intermediates`, as the view reads citations from the `.aux`. Output goes to
  `.latex-build/`, with a `<job>.report.json` the view reads. TeX is also looked for in `/Library/TeX/texbin`,
  `/opt/homebrew/bin` and `/usr/local/bin`, as apps started from the Dock don't get the shell's PATH. When the build
  needs Tectonic and none is installed, `compile()` downloads the pinned one (`core/tectonic.ts`, sha256-checked by `core/downloads.ts`) on the
  first build and keeps it in the tools folder (`~/Library/Application Support/NeoManuscript/tools` on macOS,
  `NEO_TOOLS_DIR` overrides it). While it downloads, and while Tectonic fetches packages for its first build, the build's
  progress text is one of `core/build.ts`'s, and the view shows it over the PDF. The view's engine menu (Auto, latexmk
  or Tectonic) writes or takes out the `% !TEX program` line (`engineChange` in `core/latex.ts`) in the main file, names
  what Auto builds with, and greys out latexmk when the host's `engines()` doesn't list it (the desktop app's `/engines`; Mirador's view can't tell).
- **Markdown**: `.md` and `.markdown` files are edited as Markdown and don't build; the preview pane renders them.
  A folder with no main file opens its README.md, else index.md, else its first Markdown file. A project with no
  `.tex` file at all doesn't build, and the agent is told it is Markdown.
- **Main file**: `main.tex`, else the only top-level `.tex` with `\documentclass`, else the one named like the
  folder, else the first by name; the user can choose another in the desktop app.
- **Agents (desktop)**: Claude Code via `claude-agent-acp` and pi via `pi-acp`, bundled into `dist/desktop/agents` and
  run with the app's Bun. With no `claude` installed, the app fetches the SDK's own Claude Code from npm on the first
  chat (`claude-code.ts`; version and sha512 from bun.lock, written to `claude-code.json` at build time) into the
  tools folder of `core/downloads.ts`. A signed-out Claude Code gets a "signed-out" status, and the chat's Sign in
  button runs `claude auth login`. `pi-acp` doesn't pass MCP servers to pi, so agents edit files with their own tools in the
  project folder; the app sees the changes and credits the agent while its turn runs. Claude's ACP file reads and
  writes go through the open documents. Agents build through `POST /agent/compile` (a `curl` line in the context
  added after the user's first message). Conversations resume with ACP `session/load`; projects open by real path
  because agents file sessions by it.
- **Writing actions**: selecting a passage of four or more words (`view/assist.ts`; one to three get the synonyms)
  offers Grammar, Rephrase, Shorten, Scientific, Clearer and an instruction of the user's own; `core/assist.ts` has the
  prompts. In the desktop app the chat's agent answers in a side session on the same ACP connection (`rewrite()` in
  `hosts/desktop/chat.ts`, `POST /chat/rewrite`): a folder of its own in the temp folder, and for Claude its own system
  prompt, no tools and nothing kept, with the chat's model. The view shows the answer as a word diff to accept. Mirador
  has no side session: the action goes to its agent as a message, and the agent changes the file.
- **Change highlight**: the toolbar's Changes toggle (`view/changes.ts`) marks the words of the open file added or
  changed since a baseline (`changedRanges` in `core/diff.ts`: removed words and whitespace leave no mark), and dots
  the changed files in the file tree. The baseline is the last commit or a tag, for a host with the `ProjectBridge`'s
  git methods (the desktop app, through `core/git.ts` and `/git/*`; it watches the git folder and sends a `git` event
  when HEAD or the tags move), else the text as the view first opened the file: in Mirador, whose plugin API reads no
  git yet, and in a folder that isn't a repository.
- **Agents (Mirador)**: `app_state`, `apply` (`replace`, `insert`, `replace_lines`, `set_text`) and `app_run compile`.
- **Mirador's view**: the project is the workspace, and paths are named from it, as the desktop app names them from its
  folder. The view lists it with `listFiles` (again on `onFiles`), opens a file with `open` (after a running build ends,
  as Mirador refuses it during one) and reads files through `../` from the document's folder. A chapter builds with the
  main file its `% !TEX root` names, else the nearest one in its folder or above (`mainFileFor`); the build goes in that
  file's folder, and the view rebases the report's paths onto the folder its report is in.
- **Updates**: `release.baseUrl` in `electrobun.config.ts` (GitHub `releases/latest/download`). `updates.ts` also ends
  the launcher Electrobun 2.0.5 leaves behind on the first start, which otherwise stops the app from relaunching after
  an update.

## CI

`.github/workflows/ci.yml` runs on pushes to main and on pull requests. One job installs Tectonic and BasicTeX (with
latexmk), then runs the typecheck, the unit tests and `bun run e2e` in the runner's Chrome. The other runs a stable
`app:build` and keeps the DMG as a workflow artifact for 7 days.

## Releasing

Bump `version` in `package.json` and `plugin.json` (Mirador's plugin store installs the plugin at the tag and checks it), commit, and push a matching tag: `git tag v0.2.0 && git push origin main v0.2.0`.
`.github/workflows/release.yml` builds on macOS and publishes the DMG and update files as the latest release. To try
an update locally, build two versions with `NEO_RELEASE_BASE_URL=http://127.0.0.1:8765` and serve the newer one's
`artifacts/` there while the older one runs.

## Conventions

- Bun and TypeScript throughout; no Node-only tooling.
- Comments and messages in plain, short sentences that say what a thing is or does.
- Run the typecheck and unit tests before committing; run `bun run e2e` when the view changes.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:46cd31e7 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
