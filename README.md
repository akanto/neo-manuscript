# NeoManuscript

Tired of formatting tables, typesetting equations and hunting down build errors? NeoManuscript is a LaTeX editor for
papers, theses and reports. You write; an agent (Claude Code or pi) can take on the tedious parts: equations, tables
and the errors that stop a build. The PDF updates next to the text as you type.

It's a macOS app, and also a plugin for [Mirador](https://github.com/sodre90/mirador).

[![NeoManuscript in 75 seconds: watch the video](https://img.youtube.com/vi/G6SaiSa4uYQ/maxresdefault.jpg)](https://youtu.be/G6SaiSa4uYQ)

## Install

1. Download `macos-arm64-NeoManuscript.dmg` from the [latest release](https://github.com/akanto/neo-manuscript/releases/latest)
   (Apple silicon) and drag NeoManuscript to Applications.
2. The app isn't signed yet, so the first time, right-click it and choose **Open**.
3. You need TeX to build PDFs: [MacTeX](https://www.tug.org/mactex/) (`brew install --cask mactex-no-gui`) or
   [Tectonic](https://tectonic-typesetting.github.io/).
4. For the chat, install [Claude Code](https://claude.com/claude-code) or
   [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) and sign in to it once.

The app updates itself: it checks for new versions on its own, and asks before restarting.

## Using it

- **Projects**: open a folder with ⌘O. Its files are listed on the left; click one to edit it. The *main* file
  (usually `main.tex`) is the one that gets built.
- **Source and Visual**: Source is plain LaTeX. Visual shows headings, math, lists and references as they'll look,
  and shows the markup again where your cursor is.
- **PDF**: builds as you type, or with ⌘S. Errors link to their lines. Double-click the PDF to jump to the source.
- **Markdown**: `.md` files open too, with the same Source and Visual modes and a live preview where the PDF would be.
  Open a README.md (or a folder of Markdown) with ⌘O; nothing needs TeX.
- **Chat** (⌘J): talk to Claude or pi about your document. The agent edits the files directly and you see its changes
  as they happen. Pick the model at the top of the chat. Select text and press **Ask** to ask about it.
- **Synonyms**: select a word or two to see synonyms.

Shortcuts: ⌘B bold, ⌘I italic, ⌘M inline math, ⇧⌘M display math, ⌥⌘P show or hide the PDF, ⌘F search.

## In Mirador

```bash
git clone https://github.com/akanto/neo-manuscript && cd neo-manuscript
bun install && bun run build
ln -s "$PWD" ~/.mirador/plugins/neo-manuscript
```

Restart Mirador and ask its agent to open a `.tex` or `.md` file in NeoManuscript. The workspace's files are listed on
the left; click one to edit it. It needs Mirador with plugin API 6.

## Building from source

You need [Bun](https://bun.sh).

```bash
bun install
bun run app:prepare   # once: fetches Electrobun, the desktop toolkit
bun run app           # builds and opens the app
```

See [AGENTS.md](AGENTS.md) for how the code is laid out, the tests, and releasing.

## License

MIT. The app also bundles third-party code under its own licenses, listed in `THIRD-PARTY-NOTICES.txt` inside the
app, including Anthropic's Claude Agent SDK ([Commercial Terms](https://www.anthropic.com/legal/commercial-terms)).
Synonyms come from [WordNet](https://wordnet.princeton.edu/) 3.0, © 2006 Princeton University.
