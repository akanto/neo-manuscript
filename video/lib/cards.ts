/** Draws the title and end cards as 2560 x 1440 stills into video/out/cards. `bun video/lib/cards.ts` */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const out = join(import.meta.dir, "..", "out", "cards");
mkdirSync(out, { recursive: true });

const style = `
body { margin: 0; width: 1536px; height: 864px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px;
  background: radial-gradient(ellipse at 50% 40%, #1d2b4a 0%, #0c1220 72%); color: #f4f1ea; }
.big { font: 600 84px/1.1 "Iowan Old Style", Palatino, Georgia, serif; letter-spacing: -0.5px; }
.big em { color: #ffd479; font-style: normal; }
.small { font: 400 30px/1.4 -apple-system, "Helvetica Neue", sans-serif; color: #c3cce0; }
.mono { font: 400 24px/1.4 "SF Mono", Menlo, monospace; color: #8fa3c8; margin-top: 26px; }
`;

const cards = {
  title: `<div class="big">Neo<em>Manuscript</em></div><div class="small">A LaTeX editor for papers, theses and reports</div>`,
  end: `<div class="big">Neo<em>Manuscript</em></div><div class="small">For macOS, and as a Mirador plugin · free and open source</div><div class="mono">github.com/akanto/neo-manuscript</div>`,
};

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1536, height: 864 }, deviceScaleFactor: 5 / 3 });
for (const [name, html] of Object.entries(cards)) {
  await page.setContent(`<style>${style}</style>${html}`);
  await page.screenshot({ path: join(out, `${name}.jpg`), type: "jpeg", quality: 95 });
}
await browser.close();
console.log("cards in", out);
