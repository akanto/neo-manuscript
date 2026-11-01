/**
 * Films NeoManuscript in a real Mirador: a throwaway host from the Mirador checkout (its e2e TestHost), with this plugin
 * linked in, running the real Claude Code on the owner's login. A person types prompts into the conversation and a line
 * into the paper; the agent does the rest. Frames come from Chrome's screencast with the moment each was presented, and
 * the moments that matter (a prompt sent, the paper changed, a turn ended) go to video/out/capture/moments.json for the
 * edit. `bun video/lib/capture.ts`
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Frame, type Page } from "playwright-core";
import { TestHost } from "../../../../sodre90/mirador/e2e/test-host.ts";
import { Cursor } from "./cursor.ts";
import { typeLikeAPerson } from "./typing.ts";

const repo = join(import.meta.dir, "..", "..");
/** `--short`: one turn that opens the paper and typesets its equations, for the desktop video's Mirador beat. */
const short = process.argv.includes("--short");
const out = join(import.meta.dir, "..", "out", short ? "mirador" : "capture");
const framesDir = join(out, "frames");
rmSync(out, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });

/** The app at a laptop's size, drawn at 5/3 so frames are 2560 x 1440, made 1080p in the edit. */
const FRAME = { cssWidth: 1536, cssHeight: 864, scale: 5 / 3 };
const width = Math.round(FRAME.cssWidth * FRAME.scale);
const height = Math.round(FRAME.cssHeight * FRAME.scale);

// The paper, in a folder the sidebar shows as ~/papers/warmup.
const paper = join(homedir(), "papers", "warmup");
rmSync(paper, { recursive: true, force: true });
mkdirSync(join(paper, ".claude"), { recursive: true });
cpSync(join(import.meta.dir, "..", "draft.tex"), join(paper, "paper.tex"));
writeFileSync(join(paper, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["mcp__canvas", "Read", "Bash"] } }, null, 2));

const host = new TestHost({ usesClaudeLogin: true, environment: { MIRADOR_TEST_MODEL: "sonnet", MIRADOR_TEST_EFFORT: "medium" } });
mkdirSync(join(host.dataDir, "plugins"), { recursive: true });
symlinkSync(repo, join(host.dataDir, "plugins", "neo-manuscript"));
await host.start();
console.log("host on", host.authUrl);

const profile = mkdtempSync(join(tmpdir(), "manuscript-video-chrome-"));
mkdirSync(join(profile, "Default"));
writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({ partition: { default_zoom_level: { x: Math.log(FRAME.scale) / Math.log(1.2) } } }));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chrome",
  headless: true,
  viewport: { width, height },
  deviceScaleFactor: 1,
  args: [`--window-size=${width},${height}`, `--screen-info={${width}x${height}}`, "--hide-scrollbars"],
});
const page = context.pages()[0] ?? (await context.newPage());
await page.addInitScript(() => {
  if (window.top !== window) return;
  localStorage.setItem("mirador-theme", "dark");
  localStorage.setItem("mirador-sidebar-width", "200");
});
const cursor = new Cursor(page as never, { x: FRAME.cssWidth * 0.6, y: FRAME.cssHeight * 0.7 });
await cursor.install();

const moments: { name: string; at: number }[] = [];
const mark = (name: string) => {
  moments.push({ name, at: Date.now() / 1000 });
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${name}`);
};
watch(join(paper, "paper.tex"), () => mark("paper changed"));

const shot = (name: string) => page.screenshot({ path: join(out, `${name}.png`) });

// Off camera: sign in, add the paper's folder, start a conversation.
await page.goto(host.authUrl);
await page.getByText("No conversation selected").or(page.getByRole("heading", { name: "Set up a profile to start" })).waitFor({ timeout: 60_000 });
await page.getByRole("button", { name: "Add workspace" }).click();
await page.getByLabel("Workspace directory").fill(paper);
await page.getByLabel("Workspace directory").press("Enter");
const card = page.locator(".workspace", { has: page.locator(`.workspace-heading[title="${paper}"]`) });
await card.waitFor({ timeout: 30_000 });
await card.getByRole("button", { name: "+ New conversation" }).click();
await page.locator(".chat-header:visible").getByLabel("Model", { exact: true }).waitFor({ timeout: 90_000 });
// A narrow chat and a wide canvas, as the paper is the star.
const divider = page.getByRole("separator", { name: "Resize the left and right panes" });
await divider.focus();
for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
await page.mouse.click(5, 5);
await page.waitForTimeout(1500);
await shot("start");

// Filming.
const frames: { t: number; file: string }[] = [];
const cdp = await context.newCDPSession(page);
let pending = Promise.resolve();
/** At most 24 frames a second, enough for the edit, which speeds the waits up anyway; Mirador's "Working…" dots would make 60. */
const FPS = 24;
let stopped = false;
cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
  void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  if (stopped || (frames.length && metadata.timestamp! - frames.at(-1)!.t < 1 / FPS - 0.002)) return;
  if (frames.length > 20_000) {
    stopped = true;
    console.error("Over 20000 frames: the take is stuck; stopping it.");
    return;
  }
  const file = join(framesDir, `f${String(frames.length).padStart(6, "0")}.jpg`);
  frames.push({ t: metadata.timestamp!, file });
  pending = pending.then(() => writeFile(file, Buffer.from(data, "base64")));
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
mark("start");

const composer = page.locator(".composer:visible textarea");

async function send(name: string, text: string) {
  await page.locator(".composer:visible .send").waitFor({ timeout: 120_000 });
  await cursor.click(composer);
  mark(`${name} typing`);
  await typeLikeAPerson(page as never, text);
  await page.waitForTimeout(500);
  mark(`${name} sent`);
  await composer.press("Enter");
}

/** Waits for the agent's turn to end, answering any permission question with Allow so the take goes on. */
async function turnEnds(name: string) {
  const badge = async () => (await page.locator(".chat-header:visible .badge").textContent())?.trim();
  for (let i = 0; i < 120 && (await badge()) === "idle"; i++) await page.waitForTimeout(250);
  mark(`${name} working`);
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    if (stopped) throw new Error("the take ran too long");
    if ((await badge()) === "idle") break;
    const always = page.getByRole("button", { name: /^Yes, and don.t ask again/ }).first();
    const once = page.getByRole("button", { name: "Yes", exact: true }).first();
    for (const allow of [always, once]) {
      if (!(await allow.isVisible().catch(() => false))) continue;
      mark(`${name} asked permission`);
      await page.waitForTimeout(900);
      await cursor.click(allow as never);
      break;
    }
    await page.waitForTimeout(500);
  }
  mark(`${name} done`);
}

/** The frame NeoManuscript's view runs in, inside the canvas's frames. */
async function manuscript(): Promise<Frame> {
  for (let i = 0; i < 120; i++) {
    for (const frame of page.frames()) if (await frame.locator(".cm-editor").count().catch(() => 0)) return frame;
    await page.waitForTimeout(500);
  }
  throw new Error("NeoManuscript's view never showed");
}

try {
  take: {
  await page.waitForTimeout(1500);
  if (short) {
    await send("open", "Open paper.tex in NeoManuscript and typeset my method notes as numbered equations.");
    await turnEnds("open");
    await page.waitForTimeout(3000);
    await shot("opened");
    mark("end");
    break take;
  }
  await send("open", "Open paper.tex in NeoManuscript.");
  await turnEnds("open");
  const view = await manuscript();
  await page.waitForTimeout(2500);
  await shot("opened");

  // The author writes the conclusion.
  await view.evaluate(() => {
    const scroller = document.querySelector(".cm-scroller") as HTMLElement;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  });
  await page.waitForTimeout(1500);
  const conclusion = view.locator(".cm-line", { hasText: "Conclusion" });
  await cursor.click(conclusion as never, { offsetX: 0.3 });
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowDown");
  mark("author typing");
  await typeLikeAPerson(page as never, "A few thousand steps of warm-up are enough: every schedule we tried trained stably, and the longest gave the best perplexity.");
  await page.keyboard.press("ArrowDown");
  mark("author done");
  await page.waitForTimeout(4000);
  await shot("written");

  await send("equations", "Typeset my method notes as proper numbered equations.");
  await turnEnds("equations");
  await page.waitForTimeout(2000);
  await shot("equations");

  await send("table", "Turn the raw results into a booktabs table with a caption.");
  await turnEnds("table");
  await page.waitForTimeout(2000);
  await shot("table");

  await send("refs", "Cite Vaswani et al. 2017 properly with a bibliography, reference the table from the conclusion, and compile until the build is clean.");
  await turnEnds("refs");
  await page.waitForTimeout(3000);
  await shot("refs");

  // The result: the PDF alone, a page at a time.
  const pdfButton = view.getByRole("button", { name: "PDF", exact: true });
  await cursor.click(pdfButton as never);
  mark("pdf");
  await view.locator('button[title="Fit page"]').click();
  await page.waitForTimeout(3000);
  await view.evaluate(() => {
    const scroll = document.querySelector(".pdf-scroll") as HTMLElement;
    const second = scroll.querySelectorAll(".pdf-page")[1] as HTMLElement | undefined;
    if (second) scroll.scrollTo({ top: second.offsetTop - 8, behavior: "smooth" });
  });
  mark("pdf page 2");
  await page.waitForTimeout(3500);
  await shot("pdf");
  mark("end");
  }
} finally {
  await cdp.send("Page.stopScreencast").catch(() => {});
  await pending;
  writeFileSync(join(out, "frames.json"), JSON.stringify(frames.map(({ t, file }) => ({ t, file: file.split("/").at(-1) }))));
  writeFileSync(join(out, "moments.json"), JSON.stringify(moments, null, 2));
  cpSync(join(paper, "paper.tex"), join(out, "paper.tex"));
  console.log(`${frames.length} frames`);
  await context.close();
  await host.stop();
  await host.cleanUp();
  rmSync(profile, { recursive: true, force: true });
}
