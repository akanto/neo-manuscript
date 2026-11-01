/**
 * Records the promo video: the real view, around the e2e harness, on a rough draft that the "agent" (operations applied
 * as the agent would) turns into a typeset paper. Title cards and captions are overlays on the page; frames come from
 * Chrome's screencast and ffmpeg makes them an MP4.
 * `bun run build && bun video/record.ts` writes video/out/manuscript.mp4.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { startHarness } from "../e2e/harness.ts";

const here = import.meta.dir;
const out = join(here, "out");
const framesDir = join(out, "frames");
await rm(out, { recursive: true, force: true });
await mkdir(framesDir, { recursive: true });

const harness = await startHarness(join(here, "draft.tex"));
const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 4 / 3 });
const page = await context.newPage();
page.on("pageerror", (error) => console.error("page error:", error.message));
await page.goto(harness.url);
await page.locator(".cm-v-title").waitFor({ timeout: 30_000 });

const OVERLAY = `
#promo-card { position: fixed; inset: 0; z-index: 10000; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 18px; background: radial-gradient(ellipse at 50% 40%, #1d2b4a 0%, #0c1220 70%); color: #f4f1ea; opacity: 1; transition: opacity 0.7s ease; }
#promo-card.hidden { opacity: 0; pointer-events: none; }
#promo-card .big { font: 600 64px/1.15 "Iowan Old Style", "Palatino", Georgia, serif; text-align: center; letter-spacing: -0.5px; }
#promo-card .big em { color: #ffd479; font-style: italic; }
#promo-card .small { font: 400 24px/1.4 -apple-system, "Helvetica Neue", sans-serif; color: #b9c3d8; text-align: center; }
#promo-card .mono { font: 400 20px/1.4 "SF Mono", Menlo, monospace; color: #8fa3c8; margin-top: 18px; }
#promo-card > * { transition: opacity 0.6s ease, transform 0.6s ease; }
#promo-card.enter > * { opacity: 0; transform: translateY(14px); }
#promo-caption { position: fixed; left: 50%; bottom: 34px; z-index: 9999; transform: translate(-50%, 10px); opacity: 0;
  background: rgba(12, 18, 32, 0.92); color: #f4f1ea; padding: 14px 28px; border-radius: 14px; white-space: nowrap;
  font: 500 26px/1.3 -apple-system, "Helvetica Neue", sans-serif; box-shadow: 0 10px 40px rgba(0,0,0,0.25);
  transition: opacity 0.45s ease, transform 0.45s ease; }
#promo-caption.on { opacity: 1; transform: translate(-50%, 0); }
#promo-caption b { color: #ffd479; font-weight: 600; }
`;

await page.evaluate((css) => {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  const card = document.createElement("div");
  card.id = "promo-card";
  document.body.append(card);
  const caption = document.createElement("div");
  caption.id = "promo-caption";
  document.body.append(caption);
}, OVERLAY);

const sleep = (ms: number) => Bun.sleep(ms);

async function card(html: string) {
  await page.evaluate((html) => {
    const card = document.getElementById("promo-card")!;
    card.classList.add("enter");
    card.innerHTML = html;
    card.classList.remove("hidden");
    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.remove("enter")));
  }, html);
}
const hideCard = () => page.evaluate(() => document.getElementById("promo-card")!.classList.add("hidden"));

async function caption(html: string | null) {
  await page.evaluate(async (html) => {
    const caption = document.getElementById("promo-caption")!;
    if (caption.classList.contains("on")) {
      caption.classList.remove("on");
      await new Promise((resolve) => setTimeout(resolve, 450));
    }
    if (html === null) return;
    caption.innerHTML = html;
    caption.classList.add("on");
  }, html);
}

/** Scrolls the editor so the agent's latest change (it flashes) is in the middle. */
const showFlash = () =>
  page.evaluate(() => document.querySelector(".cm-flash")?.scrollIntoView({ behavior: "smooth", block: "center" }));

/** Scrolls the PDF to a fraction of its height. */
const scrollPdf = (fraction: number) =>
  page.evaluate((fraction) => {
    const scroll = document.querySelector(".pdf-scroll") as HTMLElement;
    scroll.scrollTo({ top: (scroll.scrollHeight - scroll.clientHeight) * fraction, behavior: "smooth" });
  }, fraction);

/** Scrolls the PDF to the top of one of its pages. */
const showPage = (index: number) =>
  page.evaluate((index) => {
    const scroll = document.querySelector(".pdf-scroll") as HTMLElement;
    const target = scroll.querySelectorAll(".pdf-page")[index] as HTMLElement;
    scroll.scrollTo({ top: target.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 8, behavior: "smooth" });
  }, index);

const status = () => page.locator(".build-status").textContent();

/** Waits for the build the last change started, and for its PDF to be drawn. */
async function built() {
  for (let i = 0; i < 40 && !(await status())?.includes("Compiling"); i++) await sleep(100);
  for (let i = 0; i < 300 && (await status())?.includes("Compiling"); i++) await sleep(100);
  await sleep(700);
  console.log("built:", await status());
}

// The first build of the draft, before recording.
await built();
await card(`<div class="big">Beautiful <em>LaTeX</em> documents.</div><div class="big">Never been easier.</div>`);
await sleep(800);

// Recording.
const frames: { t: number; file: string }[] = [];
const cdp = await context.newCDPSession(page);
let pending = Promise.resolve();
cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
  const file = join(framesDir, `f${String(frames.length).padStart(5, "0")}.jpg`);
  frames.push({ t: metadata.timestamp!, file });
  pending = pending.then(() => writeFile(file, Buffer.from(data, "base64")));
  void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
// A tick that changes the page, so the screencast has a frame at least every ~half second, even when nothing moves.
await page.evaluate(() => {
  const tick = document.createElement("div");
  tick.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;z-index:10001;opacity:0.01";
  document.body.append(tick);
  let on = false;
  setInterval(() => { on = !on; tick.style.background = on ? "#000" : "#fff"; }, 100);
});

await sleep(3400);
await card(`<div class="small">You write the content.</div><div class="big">NeoManuscript does the <em>labour</em>.</div>`);
await sleep(2800);
await hideCard();
await sleep(900);

// 1. The author writes.
await caption("<b>You</b> write the content.");
await sleep(1200);
await page.locator(".cm-line", { hasText: "Conclusion" }).click();
await page.keyboard.press("End");
await page.keyboard.press("ArrowDown");
await page.keyboard.type(
  "A few thousand steps of warm-up are enough: every schedule we tried trained stably, and the longest gave the best perplexity.",
  { delay: 32 },
);
await page.keyboard.press("ArrowDown");
await sleep(900);
await caption("The draft is rough, and it doesn't even build.");
await sleep(2600);

// 2. Equations.
await caption("NeoManuscript <b>typesets the equations</b>…");
await sleep(800);
await harness.agentApply({
  op: "replace",
  find: "learning rate at step t: eta_t = eta_max * min(1, t/T_w), T_w = warm-up length",
  with: `The learning rate rises linearly over the first $T_w$ steps and then stays at its peak,
\\begin{equation}
  \\eta_t = \\eta_{\\max} \\cdot \\min\\!\\left(1, \\frac{t}{T_w}\\right).
  \\label{eq:warmup}
\\end{equation}`,
});
await sleep(150);
await showFlash();
await sleep(1500);
await harness.agentApply({
  op: "replace",
  find: "loss: L(theta) = -1/N sum_i log p(y_i | x_i) + lambda ||theta||^2",
  with: `We minimise the cross-entropy with weight decay,
\\begin{equation}
  \\mathcal{L}(\\theta) = -\\frac{1}{N} \\sum_{i=1}^{N} \\log p_\\theta(y_i \\mid x_i) + \\lambda \\lVert \\theta \\rVert_2^2 .
  \\label{eq:loss}
\\end{equation}`,
});
await sleep(150);
await showFlash();
await built();
await scrollPdf(0.18);
await sleep(2200);

// 3. The table.
await caption("…<b>formats the tables</b>…");
await sleep(600);
await harness.agentApply({ op: "insert", after: "\\usepackage{amsmath,amssymb}\n", text: "\\usepackage{booktabs}\n" });
await harness.agentApply({
  op: "replace",
  find: `WikiText-103, 5 seeds each:
none: ppl 31.8, 3/5 diverged
linear 1k: ppl 24.6, 0/5 diverged
linear 4k: ppl 24.1, 0/5 diverged
cosine 4k: ppl 24.3, 0/5 diverged`,
  with: `Table~\\ref{tab:results} compares four schedules on WikiText-103, five seeds each.
Any warm-up removes the divergent runs.

\\begin{table}[ht]
  \\centering
  \\caption{Validation perplexity and divergent runs on WikiText-103 (5 seeds).}
  \\label{tab:results}
  \\begin{tabular}{lcc}
    \\toprule
    Warm-up schedule & Perplexity $\\downarrow$ & Diverged \\\\
    \\midrule
    None             & 31.8          & 3/5 \\\\
    Linear, 1k steps & 24.6          & 0/5 \\\\
    Linear, 4k steps & \\textbf{24.1} & 0/5 \\\\
    Cosine, 4k steps & 24.3          & 0/5 \\\\
    \\bottomrule
  \\end{tabular}
\\end{table}`,
});
await sleep(150);
await showFlash();
await built();
await scrollPdf(0.55);
await sleep(2400);

// 4. Citations and cross-references.
await caption("…<b>links citations and references</b>…");
await sleep(600);
await harness.agentApply({ op: "replace", find: "Transformers (Vaswani et al. 2017)", with: "Transformers~\\cite{vaswani2017}" });
await sleep(150);
await showFlash();
await sleep(1200);
await harness.agentApply({ op: "replace", find: "gave the best perplexity.", with: "gave the best perplexity (Table~\\ref{tab:results})." });
await sleep(150);
await showFlash();
await sleep(1200);
await harness.agentApply({
  op: "insert",
  at: "end_of_body",
  text: `\\begin{thebibliography}{9}
\\bibitem{vaswani2017} A.~Vaswani, N.~Shazeer, N.~Parmar et al., \\emph{Attention Is All You Need}, NeurIPS, 2017.
\\end{thebibliography}

`,
});
await sleep(150);
await showFlash();
await built();
await scrollPdf(1);
await sleep(2400);

// 5. The result.
await caption("…and <b>the build is clean</b>. 0 errors.");
await sleep(2400);
await caption(null);
await page.getByRole("button", { name: "PDF", exact: true }).click();
await page.locator('button[title="Fit page"]').click();
await sleep(700);
await showPage(0);
await sleep(1200);
await caption("<b>You</b> write. <b>NeoManuscript</b> does the rest.");
await sleep(1600);
await showPage(1);
await sleep(3000);
await caption(null);
await card(`<div class="big">NeoManuscript</div><div class="small">A LaTeX editor in Mirador</div><div class="mono">github.com/akanto/neo-manuscript</div>`);
await sleep(4000);

await cdp.send("Page.stopScreencast");
await pending;
await browser.close();
harness.stop();

// Each frame lasts until the next one; the last one a moment.
const list = frames
  .map((frame, i) => `file '${frame.file}'\nduration ${((frames[i + 1]?.t ?? frame.t + 0.5) - frame.t).toFixed(4)}`)
  .join("\n") + `\nfile '${frames.at(-1)!.file}'\n`;
await writeFile(join(out, "frames.txt"), list);
console.log(`${frames.length} frames over ${(frames.at(-1)!.t - frames[0]!.t).toFixed(1)} s`);

const ffmpeg = Bun.spawnSync([
  "ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(out, "frames.txt"),
  "-vf", "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "18",
  "-movflags", "+faststart", join(out, "manuscript.mp4"),
], { stdout: "inherit", stderr: "inherit" });
if (ffmpeg.exitCode !== 0) throw new Error("ffmpeg failed");
await rm(framesDir, { recursive: true });
console.log("wrote", join(out, "manuscript.mp4"));
