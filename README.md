# NeoManuscript

Tired of formatting tables, typesetting equations and hunting down build errors? NeoManuscript is a LaTeX editor for
papers, theses and reports. You write; an agent (Claude Code or pi) can take on the tedious parts: equations, tables
and the errors that stop a build. The PDF updates next to the text as you type.

It's a macOS app, and also a plugin for [Mirador](https://github.com/sodre90/mirador).

[![NeoManuscript in 75 seconds: watch the video](https://img.youtube.com/vi/G6SaiSa4uYQ/maxresdefault.jpg)](https://youtu.be/G6SaiSa4uYQ)

## Install

Download `macos-arm64-NeoManuscript.dmg` from the [latest release](https://github.com/akanto/neo-manuscript/releases/latest)
and drag NeoManuscript to Applications. The app isn't signed yet, so the first time, right-click it and choose
**Open**. That's all: the app fetches what it needs the first time it needs it, and updates itself.

## Using it

- **Projects**: open a folder with ⌘O. Its files are listed on the left; click one to edit it. The *main* file
  (usually `main.tex`) is the one that gets built.
- **Source and Visual**: Source is plain LaTeX. Visual shows headings, math, lists and references as they'll look,
  and shows the markup again where your cursor is.
- **Engine**: the menu next to **Compile**. **Auto** builds with MacTeX's latexmk when it's installed, else with
  Tectonic; choose **latexmk** or **Tectonic** to fix it for the file (see [TeX: MacTeX or Tectonic](#tex-mactex-or-tectonic)).
- **PDF**: builds as you type, or with ⌘S. Errors link to their lines. Double-click the PDF to jump to the source.
  With ⇅ on (by default), the PDF, or a Markdown file's preview, scrolls along with the editor.
- **Markdown**: `.md` files open too, with the same Source and Visual modes and a live preview where the PDF would be.
  Open a README.md (or a folder of Markdown) with ⌘O; nothing needs TeX.
- **Chat** (⌘J): talk to Claude or pi about your document. The agent edits the files directly and you see its changes
  as they happen. Pick the model at the top of the chat. Select text and press **Ask** to ask about it.
- **Synonyms**: select a word or two to see synonyms.

Shortcuts: ⌘B bold, ⌘I italic, ⌘M inline math, ⇧⌘M display math, ⌥⌘P show or hide the PDF, ⌘F search.

## Advanced

### TeX: MacTeX or Tectonic

With MacTeX installed, the PDF is built with latexmk. Without it, it's built with
[Tectonic](https://tectonic-typesetting.github.io/), which the app downloads on the first build if it isn't installed.
That build is slow, as Tectonic also fetches the TeX packages the document uses; the PDF pane says so while it works.
Later builds are quick and only fetch new packages.

[MacTeX](https://www.tug.org/mactex/) is the full TeX Live, and is worth installing when a document needs:

- `minted` or anything else that runs programs during the build (shell escape);
- Biber setups Tectonic doesn't handle, or a package Tectonic's bundle doesn't have;
- builds with no network at all;
- the same TeX as your co-authors or a journal that uses TeX Live.

latexmk runs pdfLaTeX, BibTeX or Biber, and pdfLaTeX again as many times as the references need. To fix the engine
for one file, choose **latexmk** or **Tectonic** in the menu: the choice is kept as a `% !TEX program = latexmk` (or
`tectonic`) line at the top of the main file, so it goes with the file; TeXShop and VS Code read it too. **Auto**
takes the line out. A line naming `xelatex` or `lualatex` builds with that engine through latexmk.

To install MacTeX, run `brew install --cask mactex-no-gui` (about 6 GB), or download `MacTeX.pkg` from
[tug.org/mactex](https://www.tug.org/mactex/). For a smaller install, use BasicTeX (`brew install --cask basictex`),
then run `sudo tlmgr update --self && sudo tlmgr install latexmk`, and add the packages a document needs with
`sudo tlmgr install <name>`. Restart NeoManuscript afterwards.

### Chat

The chat uses [Claude Code](https://claude.com/claude-code) if it's installed. Otherwise the app downloads it on the
first chat and asks you to sign in with your Claude account. To use
[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) instead, install it and set up a model with `pi`.

### In Mirador

NeoManuscript is also a plugin for [Mirador](https://github.com/sodre90/mirador) (plugin API 6). Mirador builds it with
its own Bun; to install it by hand, you need [Bun](https://bun.sh):

```bash
git clone https://github.com/akanto/neo-manuscript && cd neo-manuscript
bun install && bun run build
ln -s "$PWD" ~/.mirador/plugins/neo-manuscript
```

Restart Mirador and ask its agent to open a `.tex` or `.md` file in NeoManuscript. The workspace's files are listed on
the left; click one to edit it. Builds work as in the app; the chat is Mirador's own.

### Building from source

You need [Bun](https://bun.sh); the end-to-end tests also need Chrome.

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
