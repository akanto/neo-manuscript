/**
 * Films the desktop app: its real server and view (as `bun hosts/desktop/serve.ts` runs them) in Chrome, on a rough draft
 * in ~/papers/warmup, with the real Claude Code in the chat on the owner's login. A person shows Visual mode, types a
 * line, jumps from the PDF to the source and looks up a synonym; then asks the agent to clean the draft up. Frames come
 * from Chrome's screencast, and the moments that matter go to video/out/desktop/moments.json for the edit.
 * `bun scripts/build-desktop.ts && bun video/lib/capture-desktop.ts`
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator } from "playwright-core";
import { ProjectHost } from "../../hosts/desktop/project-host.ts";
import { startServer } from "../../hosts/desktop/server.ts";
import { Settings } from "../../hosts/desktop/settings.ts";
import { Cursor } from "./cursor.ts";
import { typeLikeAPerson } from "./typing.ts";

const repo = join(import.meta.dir, "..", "..");
const out = join(import.meta.dir, "..", "out", "desktop");
const framesDir = join(out, "frames");
rmSync(out, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });

/** A laptop's window, drawn at 5/3 so frames are 2560 x 1440, made 1080p in the edit. */
const CSS = { width: 1536, height: 864 };
const SCALE = 5 / 3;

// The paper, in a folder named like a real one.
const paper = join(homedir(), "papers", "warmup");
rmSync(paper, { recursive: true, force: true });
mkdirSync(paper, { recursive: true });
cpSync(join(import.meta.dir, "..", "draft.tex"), join(paper, "main.tex"));

// The app's server with settings of its own: Claude in the chat, nothing remembered.
const data = mkdtempSync(join(tmpdir(), "manuscript-video-settings-"));
const settings = new Settings(data);
settings.view.set("agent", "claude");
const server = startServer({
  viewCode: () => Bun.file(join(repo, "dist", "desktop", "view.js")).text(),
  storage: settings.view,
  agentsFolder: join(repo, "dist", "desktop", "agents"),
  chats: settings.chats,
});
server.show(await ProjectHost.open(paper, { trash: async (path) => rmSync(path, { recursive: true, force: true }) }));

// Chrome's page zoom, not a device scale, so the screencast's frames have the zoomed size; the page still lays out at
// CSS's size, and the mouse goes by CSS pixels.
const profile = mkdtempSync(join(tmpdir(), "manuscript-video-chrome-"));
mkdirSync(join(profile, "Default"));
writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({ partition: { default_zoom_level: { x: Math.log(SCALE) / Math.log(1.2) } } }));
const width = Math.round(CSS.width * SCALE);
const height = Math.round(CSS.height * SCALE);
const context = await chromium.launchPersistentContext(profile, {
  channel: "chrome",
  headless: true,
  viewport: { width, height },
  deviceScaleFactor: 1,
  args: [`--window-size=${width},${height}`, "--hide-scrollbars"],
});
const page = context.pages()[0] ?? (await context.newPage());
page.on("pageerror", (error) => console.error("page error:", error.message));
const cursor = new Cursor(page as never, { x: CSS.width * 0.55, y: CSS.height * 0.6 });
await cursor.install();

const moments: { name: string; at: number }[] = [];
const mark = (name: string) => {
  moments.push({ name, at: Date.now() / 1000 });
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${name}`);
};
watch(join(paper, "main.tex"), () => mark("paper changed"));
const shot = (name: string) => page.screenshot({ path: join(out, `${name}.png`) });
const wait = (ms: number) => page.waitForTimeout(ms);
const at = (target: Locator) => target as never;

const buildStatus = page.locator(".build-status");
/** Waits for a build to start (if one is coming) and end, and for its PDF to be drawn. */
async function built() {
  for (let i = 0; i < 30 && !(await buildStatus.textContent())?.match(/Compiling|Building/); i++) await wait(100);
  for (let i = 0; i < 600 && (await buildStatus.textContent())?.match(/Compiling|Building/); i++) await wait(100);
  await wait(800);
  console.log("built:", await buildStatus.textContent());
}

await page.goto(server.url);
await page.locator(".cm-v-title").waitFor({ timeout: 30_000 });
await page.locator(".chat-send").waitFor({ state: "attached" });
await built();
await page.locator(".chat-status").filter({ hasText: /^$/ }).waitFor({ timeout: 60_000 }).catch(() => {});
// Off camera: the agent may edit files without asking; anything else it still asks for.
const chatButton = page.getByRole("button", { name: "✦ Chat" });
await chatButton.click();
const mode = page.locator(".chat-config select").first();
await mode.waitFor({ state: "attached", timeout: 90_000 });
const chosen = await mode.evaluate((select: HTMLSelectElement) => {
  const options = [...select.options].map((option) => ({ value: option.value, text: option.text }));
  const pick = [/accept/i].map((re) => options.find((o) => re.test(o.text) || re.test(o.value))).find(Boolean);
  if (pick) {
    select.value = pick.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return { options, pick };
});
console.log("mode:", JSON.stringify(chosen));
await wait(1000);
await chatButton.click();
await wait(1500);
await shot("start");

// Filming.
const frames: { t: number; file: string }[] = [];
const cdp = await context.newCDPSession(page);
let pending = Promise.resolve();
const FPS = 30;
let stopped = false;
cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
  void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  if (stopped || (frames.length && metadata.timestamp! - frames.at(-1)!.t < 1 / FPS - 0.002)) return;
  if (frames.length > 30_000) {
    stopped = true;
    console.error("Over 30000 frames: the take is stuck; stopping it.");
    return;
  }
  const file = join(framesDir, `f${String(frames.length).padStart(6, "0")}.jpg`);
  frames.push({ t: metadata.timestamp!, file });
  pending = pending.then(() => writeFile(file, Buffer.from(data, "base64")));
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
// A pixel that changes, so the screencast sends a frame now and then even when nothing moves.
await page.evaluate(() => {
  const tick = document.createElement("div");
  tick.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;z-index:10001;opacity:0.01";
  document.body.append(tick);
  let on = false;
  setInterval(() => ((on = !on), (tick.style.background = on ? "#000" : "#fff")), 100);
});
mark("start");

const scroller = page.locator(".cm-scroller").first();
const scrollEditor = (where: "top" | "bottom") =>
  scroller.evaluate((node, where) => node.scrollTo({ top: where === "top" ? 0 : node.scrollHeight, behavior: "smooth" }), where);

try {
  await wait(2500);

  // Visual mode: the heading shows its markup where the cursor is.
  mark("visual");
  await cursor.click(at(page.locator(".cm-line", { hasText: "Introduction" }).first()), { offsetX: 0.25 });
  await wait(2200);
  await cursor.glideTo({ x: CSS.width * 0.3, y: CSS.height * 0.45 });
  await wait(600);

  // The author writes the conclusion; the PDF follows.
  await scrollEditor("bottom");
  await wait(1200);
  const conclusion = page.locator(".cm-line", { hasText: "Conclusion" }).first();
  await cursor.click(at(conclusion), { offsetX: 0.4 });
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowDown");
  mark("author typing");
  await typeLikeAPerson(page as never, "A few thousand steps of warm-up are enough: every schedule we tried trained stably, and the longest gave the best perplexity.");
  mark("author done");
  await built();
  mark("pdf updated");
  await wait(1500);
  await shot("written");

  // From the PDF to the source: a double-click on the introduction.
  await scrollEditor("top");
  await wait(900);
  const pdfPage = page.locator(".pdf-page").first();
  const box = (await pdfPage.boundingBox())!;
  const intro = { x: box.x + box.width * 0.42, y: box.y + box.height * 0.465 };
  await cursor.glideTo(intro);
  mark("synctex");
  await page.evaluate(() => (window as unknown as { moviePointer: { press(): void } }).moviePointer.press());
  await page.mouse.dblclick(intro.x, intro.y);
  await wait(2600);
  await shot("synctex");

  // A synonym for a word.
  const word = page.locator(".cm-line", { hasText: "shape matters" }).first();
  await word.scrollIntoViewIfNeeded();
  const wordBox = await word.evaluate((line) => {
    const text = line.textContent ?? "";
    const index = text.indexOf("matters");
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent!.length;
      if (seen + length > index) {
        const range = document.createRange();
        range.setStart(node, index - seen);
        range.setEnd(node, index - seen + "matters".length);
        const rect = range.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }
      seen += length;
    }
    return null;
  });
  if (wordBox) {
    await cursor.glideTo(wordBox);
    mark("synonyms");
    await page.evaluate(() => (window as unknown as { moviePointer: { press(): void } }).moviePointer.press());
    await page.mouse.dblclick(wordBox.x, wordBox.y);
    await wait(3000);
    await shot("synonyms");
    await page.keyboard.press("Escape");
    await page.keyboard.press("ArrowRight");
  }

  // The agent: the chat opens beside the paper.
  await cursor.click(at(chatButton));
  mark("chat open");
  await wait(1500);
  const input = page.locator(".chat-input");
  await cursor.click(at(input));
  mark("ask typing");
  await typeLikeAPerson(
    page as never,
    "Tidy up this draft: typeset my method notes as numbered equations, turn the results into a booktabs table, and build until it's clean.",
  );
  await wait(500);
  mark("ask sent");
  await input.press("Enter");

  // The turn: keep the agent's latest change in view, and allow anything it asks for.
  const send = page.locator(".chat-send");
  for (let i = 0; i < 100 && (await send.textContent()) !== "Stop"; i++) await wait(100);
  mark("agent working");
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline && (await send.textContent()) === "Stop") {
    if (stopped) throw new Error("the take ran too long");
    const allow = page.locator(".chat-permission-buttons button.allow:not(:disabled)").last();
    if (await allow.isVisible().catch(() => false)) {
      mark("agent asked permission");
      await wait(700);
      await cursor.click(at(allow));
    }
    await page.evaluate(() => {
      const flash = document.querySelector(".cm-flash");
      if (flash && !(flash as HTMLElement).dataset.seen) {
        (flash as HTMLElement).dataset.seen = "1";
        flash.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
    await wait(250);
  }
  mark("agent done");
  await built();
  await wait(1500);
  await shot("agent");

  // The result: the PDF alone, a page at a time.
  await cursor.click(at(page.getByRole("button", { name: "PDF", exact: true })));
  mark("pdf");
  await wait(600);
  await page.locator('button[title="Fit page"]').click();
  await wait(3200);
  await shot("pdf");
  const pages = await page.locator(".pdf-page").count();
  if (pages > 1) {
    await page.evaluate(() => {
      const scroll = document.querySelector(".pdf-scroll") as HTMLElement;
      const second = scroll.querySelectorAll(".pdf-page")[1] as HTMLElement;
      scroll.scrollTo({ top: second.offsetTop - 8, behavior: "smooth" });
    });
    mark("pdf page 2");
    await wait(3000);
  }
  mark("end");
} finally {
  await cdp.send("Page.stopScreencast").catch(() => {});
  await pending;
  writeFileSync(join(out, "frames.json"), JSON.stringify(frames.map(({ t, file }) => ({ t, file: file.split("/").at(-1) }))));
  writeFileSync(join(out, "moments.json"), JSON.stringify(moments, null, 2));
  cpSync(join(paper, "main.tex"), join(out, "main.tex"));
  console.log(`${frames.length} frames`);
  await context.close();
  server.stop();
  rmSync(data, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
  process.exit(0);
}
