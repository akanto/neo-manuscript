/**
 * The view in Chrome, around the harness's stand-in for Mirador: what Visual mode draws, that typing reaches the file,
 * that the agent's changes merge with the user's typing, and that a build shows its PDF and its errors.
 * Runs with the Chrome installed on the machine (playwright-core downloads no browser); skipped without one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit, type Browser, type FrameLocator, type Page } from "playwright-core";
import { searchPath } from "../core/compile.ts";
import { MIRADOR_CANVAS, startHarness, type Harness } from "./harness.ts";

const repo = join(import.meta.dir, "..");
const chrome = process.platform === "darwin" ? "/Applications/Google Chrome.app" : "/usr/bin/google-chrome";
const haveTex = ["latexmk", "pdflatex", "tectonic"].some((command) => Bun.which(command, { PATH: searchPath() }));
const built = existsSync(join(repo, "dist", "view.js")) && haveTex;
const haveWebKit = existsSync(webkit.executablePath());

/**
 * Twice: in Chrome as a plain page, and in WebKit (the engine of Mirador's app) framed as Mirador frames it, with its
 * sandbox, Content-Security-Policy and bridge, where every error the frame reports fails the run.
 */
const setups = [
  { name: "in Chrome", run: existsSync(chrome) && built, launch: () => chromium.launch({ channel: "chrome" }), mirador: false },
  { name: "in WebKit, framed as Mirador frames it", run: haveWebKit && existsSync(MIRADOR_CANVAS) && built, launch: () => webkit.launch(), mirador: true },
];

for (const setup of setups) describe.skipIf(!setup.run)(`the view ${setup.name}`, () => {
  let harness: Harness;
  let browser: Browser;
  let page: Page;
  let root: Page | FrameLocator;
  const errors: string[] = [];

  beforeAll(async () => {
    harness = await startHarness(join(repo, "examples", "paper.tex"), { mirador: setup.mirador });
    browser = await setup.launch();
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => message.text().startsWith("FRAME ERROR: ") && errors.push(message.text()));
    await page.goto(harness.url);
    root = setup.mirador ? page.frameLocator("iframe") : page;
    await root.locator(".pdf-page canvas").first().waitFor({ timeout: 60_000 });
    if (setup.mirador) {
      // Scrollbars that take room, as on a Mac with a mouse: headless WebKit's float over the page and hide layout loops.
      const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
      await frame.evaluate(() => {
        const style = document.createElement("style");
        style.textContent = "::-webkit-scrollbar { width: 15px; height: 15px; background: #ddd } ::-webkit-scrollbar-thumb { background: #999 }";
        document.head.append(style);
      });
    }
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    harness?.stop();
  });

  // Mirador's ⌘ is the Mac's; WebKit on Playwright takes Meta as well.
  const mod = "Meta";

  const fileHas = async (text: string, within = 5000) => {
    for (const started = Date.now(); Date.now() - started < within; await Bun.sleep(100)) if ((await harness.text()).includes(text)) return true;
    return false;
  };

  test("Visual mode draws the document: preamble folded, numbered headings, math, resolved references", async () => {
    await expect(root.locator(".cm-v-preamble").textContent()).resolves.toContain("Preamble · article");
    await expect(root.locator(".cm-v-title").textContent()).resolves.toBe("A Small Example");
    await expect(root.locator(".cm-v-h1").first().textContent()).resolves.toBe("1 Introduction");
    expect(await root.locator(".cm-v-math .katex").count()).toBeGreaterThan(5);
    await expect(root.locator(".cm-v-ref").first().textContent()).resolves.toBe("2");
    await expect(root.locator(".cm-v-cite").textContent()).resolves.toBe("[1]");
    await root.locator(".build-status", { hasText: /2 pages, 0 errors/ }).waitFor({ timeout: 30_000 });
  }, 40_000);

  test("clicking a formula shows its source to edit", async () => {
    const before = await root.locator(".cm-v-math-source").count();
    await root.locator(".cm-v-math").first().click();
    expect(await root.locator(".cm-v-math-source").count()).toBeGreaterThan(before);
  });

  test("typing reaches the file", async () => {
    await root.locator(".cm-line", { hasText: "links five constants" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Typed by the user.", { delay: 15 });
    expect(await fileHas("links five constants. Typed by the user.")).toBe(true);
  });

  test("the agent's change merges with what the user is typing", async () => {
    await page.keyboard.type(" More", { delay: 25 });
    await harness.agentApply({ op: "replace", find: "A Small Example", with: "A Bigger Example" });
    await page.keyboard.type(" words.", { delay: 25 });
    expect(await fileHas("Typed by the user. More words.")).toBe(true);
    expect(await harness.text()).toContain("A Bigger Example");
    await expect(root.locator(".cm-v-title").textContent()).resolves.toBe("A Bigger Example");
  });

  test("⌘B makes the selection bold", async () => {
    await page.keyboard.down("Shift");
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
    await page.keyboard.up("Shift");
    await page.keyboard.press(`${mod}+b`);
    expect(await fileHas("More \\textbf{words.}")).toBe(true);
  });

  test("a LaTeX error shows in the list with its line", async () => {
    await page.keyboard.press("End");
    await page.keyboard.type(" \\nosuchcommand", { delay: 10 });
    await root.locator(".problems-toggle.has-errors").waitFor({ timeout: 60_000 });
    await expect(root.locator(".problems").textContent()).resolves.toContain("line 26 Undefined control sequence");
    expect(await root.locator(".cm-problem-error").count()).toBe(1);
  }, 70_000);

  test("the layout switch hides and shows the PDF, and the hidden PDF's errors show in the toolbar", async () => {
    await root.getByRole("button", { name: "Editor", exact: true }).click();
    expect(await root.locator(".preview-pane").isVisible()).toBe(false);
    await expect(root.locator(".build-badge").textContent()).resolves.toBe("1 error");
    await root.getByRole("button", { name: "PDF", exact: true }).click();
    expect(await root.locator(".editor-pane").isVisible()).toBe(false);
    expect(await root.locator(".pdf-page canvas").first().isVisible()).toBe(true);
    await root.getByRole("button", { name: "Split", exact: true }).click();
    expect(await root.locator(".editor-pane").isVisible()).toBe(true);
    expect(await root.locator(".preview-pane").isVisible()).toBe(true);
  });

  test("Source mode shows the plain source with line numbers", async () => {
    await root.getByRole("button", { name: "Source" }).click();
    expect(await root.locator(".cm-source .cm-lineNumbers").count()).toBe(1);
    expect(await root.locator(".cm-v-preamble").count()).toBe(0);
    await root.getByRole("button", { name: "Visual" }).click();
    expect(await root.locator(".cm-visual").count()).toBe(1);
  });

  test("resizing the panel, and hiding and showing the PDF, lays it out again without a ResizeObserver loop", async () => {
    for (const width of [1200, 1013, 977, 860, 845, 790, 700, 620, 655, 900, 1400]) {
      await page.setViewportSize({ width, height: 700 + (width % 7) * 10 });
      await Bun.sleep(200);
    }
    for (let round = 0; round < 3; round++) {
      await root.getByRole("button", { name: "Editor", exact: true }).click();
      await Bun.sleep(150);
      await root.getByRole("button", { name: "Split", exact: true }).click();
      await Bun.sleep(300);
    }
    await page.setViewportSize({ width: 1400, height: 900 });
  }, 30_000);

  test("switching between the editor and the PDF keeps the place", async () => {
    // A low panel, so the conclusion's paragraph can be scrolled to the top of the editor.
    await page.setViewportSize({ width: 1400, height: 420 });
    await root.getByRole("button", { name: "Editor", exact: true }).click();
    const scroller = root.locator(".cm-scroller");
    await scroller.evaluate((element) => (element.scrollTop = element.scrollHeight));
    await Bun.sleep(100);
    await scroller.evaluate((element) => {
      const line = [...element.querySelectorAll(".cm-line")].find((candidate) => candidate.textContent?.includes("Gradient descent is simple"))!;
      element.scrollTop += line.getBoundingClientRect().top - element.getBoundingClientRect().top;
    });
    await Bun.sleep(100);

    // The paragraph is on the PDF's second page.
    await root.getByRole("button", { name: "PDF", exact: true }).click();
    const pageAtTop = () =>
      root.locator(".pdf-scroll").evaluate((element) => {
        const top = element.getBoundingClientRect().top + 16;
        const pages = [...element.querySelectorAll<HTMLElement>(".pdf-page")];
        return Number(pages.find((box) => box.getBoundingClientRect().bottom > top)?.dataset.page);
      });
    for (let tries = 0; tries < 20 && (await pageAtTop()) !== 2; tries++) await Bun.sleep(100);
    expect(await pageAtTop()).toBe(2);

    // Back from the top of the PDF to the top of the editor, where the abstract is.
    await root.locator(".pdf-scroll").hover();
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -1000);
    for (let tries = 0; tries < 20 && (await root.locator(".pdf-scroll").evaluate((element) => element.scrollTop)) > 0; tries++) await Bun.sleep(100);
    await root.getByRole("button", { name: "Editor", exact: true }).click();
    const abstractInSight = () =>
      scroller.evaluate((element) => {
        const line = [...element.querySelectorAll(".cm-line")].find((candidate) => candidate.textContent?.includes("This document shows what"));
        const box = element.getBoundingClientRect();
        const top = line?.getBoundingClientRect().top ?? -1;
        return top >= box.top && top < box.bottom;
      });
    for (let tries = 0; tries < 20 && !(await abstractInSight()); tries++) await Bun.sleep(100);
    expect(await abstractInSight()).toBe(true);

    await root.getByRole("button", { name: "Split", exact: true }).click();
    await page.setViewportSize({ width: 1400, height: 900 });
  }, 30_000);

  /** Selects a word of the editor as a mouse would, through the DOM selection that CodeMirror reads. */
  const selectWord = (word: string) => {
    const frame = setup.mirador ? page.frames().find((candidate) => candidate !== page.mainFrame())! : page.mainFrame();
    return frame.evaluate((word) => {
      const walker = document.createTreeWalker(document.querySelector(".cm-content")!, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent!.search(new RegExp(`\\b${word}\\b`));
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + word.length);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        return true;
      }
      return false;
    }, word);
  };

  test("selecting a word shows its synonyms, and one takes its place in the same form", async () => {
    await root.locator(".cm-line", { hasText: "grows fastest" }).click();
    expect(await selectWord("grows")).toBe(true);
    await root.locator(".syn-panel .syn-word").first().waitFor({ timeout: 10_000 });
    await root.locator(".syn-word", { hasText: /^increases$/ }).first().click();
    expect(await fileHas("where $f$ increases fastest")).toBe(true);
    expect(await root.locator(".syn-panel").count()).toBe(0);
  });

  test("Escape closes the synonyms, and Ask sends the word and its sentence to the agent", async () => {
    expect(await selectWord("points")).toBe(true);
    await root.locator(".syn-panel .syn-word").first().waitFor({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    expect(await root.locator(".syn-panel").count()).toBe(0);
    expect(await selectWord("smooth")).toBe(true);
    await root.locator(".syn-ask").click();
    const prompts = await page.evaluate(() => (window as unknown as { __prompts: string[] }).__prompts);
    expect(prompts.at(-1)).toContain("Suggest alternatives for “smooth” on line");
    expect(prompts.at(-1)).toContain("be a smooth function.");
  });

  test("selecting a passage offers writing actions, which go to the agent with the passage and its lines", async () => {
    expect(await selectWord("Its gradient")).toBe(true);
    expect(await root.locator(".assist-panel").count()).toBe(0);
    const frame = setup.mirador ? page.frames().find((candidate) => candidate !== page.mainFrame())! : page.mainFrame();
    // A whole line: more than the synonyms take.
    await frame.evaluate(() => {
      const line = [...document.querySelectorAll(".cm-line")].find((node) => node.textContent!.startsWith("Let "))!;
      const range = document.createRange();
      range.selectNodeContents(line);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    await root.locator(".assist-panel .assist-action[data-action=grammar]").waitFor({ timeout: 10_000 });
    expect(await root.locator(".syn-panel").count()).toBe(0);
    await root.locator(".assist-action[data-action=grammar]").click();
    let prompts: string[] = [];
    for (let tries = 0; tries < 20 && !prompts.at(-1)?.startsWith("Rewrite"); tries++, await Bun.sleep(100)) prompts = await page.evaluate(() => (window as unknown as { __prompts: string[] }).__prompts);
    expect(prompts.at(-1)).toStartWith("Rewrite this passage of the document (line 24 of the open file). Correct only errors of grammar");
    expect(prompts.at(-1)).toContain("```latex\nLet $f\\colon \\R^n \\to \\R$ be a smooth function.");
    await page.keyboard.press("Escape");
  });

  test("⌘F finds in the file from anywhere, looking for the text selected in the PDF", async () => {
    const span = root.locator(".textLayer span", { hasText: "Euler" }).first();
    await span.waitFor({ timeout: 10_000 });
    // A click in the PDF takes the focus there, as selecting in it does.
    await span.click();
    await span.evaluate((node) => {
      const text = node.firstChild!;
      const at = text.textContent!.indexOf("Euler");
      const range = document.createRange();
      range.setStart(text, at);
      range.setEnd(text, at + "Euler".length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    await page.keyboard.press("Meta+f");
    await root.locator(".cm-search [name=search]").waitFor({ timeout: 5_000 });
    expect(await root.locator(".cm-search [name=search]").inputValue()).toBe("Euler");
    await page.keyboard.press("Escape");
    expect(await root.locator(".cm-search").count()).toBe(0);
    // In the editor too: it looks for the word selected there.
    expect(await selectWord("gradient")).toBe(true);
    await page.keyboard.press("Meta+f");
    await root.locator(".cm-search [name=search]").waitFor({ timeout: 5_000 });
    expect(await root.locator(".cm-search [name=search]").inputValue()).toBe("gradient");
    await page.keyboard.press("Escape");
  });

  test("text selected in the PDF can be copied, and Ask asks about it with its source lines", async () => {
    // The synonyms test's edit builds while the tests after it run. Its PDF, laid out during the drag, would move the
    // text under the pointer, so the drag waits for that PDF to be drawn and the build to end.
    await root.locator(".textLayer span", { hasText: "increases" }).first().waitFor({ timeout: 30_000 });
    const compileButton = root.getByRole("button", { name: "▶ Compile" });
    for (let tries = 0; tries < 100 && (await compileButton.isDisabled()); tries++) await Bun.sleep(100);
    await Bun.sleep(300);
    const span = root.locator(".textLayer span", { hasText: "Euler" }).first();
    await span.waitFor({ timeout: 10_000 });
    const box = (await span.boundingBox())!;
    // A few pixels in: Chrome starts no selection at the first pixel of a span the text layer narrows (its --scale-x
    // below 1), which this line's span is once an earlier test's edit is built.
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const selected = await root.locator(".pdf-scroll").evaluate(() => getSelection()?.toString() ?? "");
    expect(selected).toContain("Euler");

    await root.locator(".ask-toggle").click();
    await expect(root.locator(".ask input").getAttribute("placeholder")).resolves.toContain("selected in the PDF");
    await root.locator(".ask input").fill("Is this identity right?");
    await root.locator(".ask input").press("Enter");
    let prompts: string[] = [];
    for (let tries = 0; tries < 20 && prompts.length === 0; tries++, await Bun.sleep(100)) prompts = await page.evaluate(() => (window as unknown as { __prompts: string[] }).__prompts);
    const asked = prompts.at(-1)!;
    expect(asked).toStartWith("Is this identity right?\n\n(About this text on page 1 of the PDF:)\n> ");
    expect(asked).toContain("Euler");
    // The line of the PDF begins with the end of source line 25 and goes on with line 26.
    // Mirador names the open file (plugin API 6), so the question does too.
    expect(asked).toContain("(It comes from lines 25–26 of paper.tex:)\n```latex\n");
    expect(asked).toContain("fastest --- a fact we use in Section~\\ref{sec:method}.\nEuler's identity, $e^{i\\pi} + 1 = 0$");
  }, 30_000);

  test("text selected in the PDF stays selected while a new build draws its pages anew", async () => {
    const selected = () => root.locator(".pdf-scroll").evaluate(() => getSelection()?.toString() ?? "");
    const compileButton = root.getByRole("button", { name: "▶ Compile" });
    /** Builds again, with the pages drawn now marked, so that a page drawn by the new build can be told from them. */
    const build = async () => {
      await root.locator(".pdf-page canvas").evaluateAll((all) => all.forEach((canvas) => canvas.classList.add("before-build")));
      await compileButton.evaluate((button: HTMLButtonElement) => button.click());
    };
    /** Waits for the build to end and its PDF's pages to be drawn. */
    const built = async (...numbers: number[]) => {
      await Promise.all(numbers.map(redrawn));
      for (let tries = 0; tries < 100 && (await compileButton.isDisabled()); tries++) await Bun.sleep(100);
      await Bun.sleep(300);
    };
    const redrawn = (number: number) => root.locator(`.pdf-page[data-page="${number}"] canvas:not(.before-build)`).waitFor({ timeout: 20_000 });

    // Across two pages: the end on each page stays where it was, rather than going to the top of the page.
    await root.locator('.pdf-page[data-page="2"] .textLayer span').first().waitFor({ timeout: 10_000 });
    // A click in the PDF takes the focus there, as selecting in it does; else the editor puts its own selection back.
    await root.locator('.pdf-page[data-page="1"] .textLayer span').first().click();
    const across = await root.locator(".pdf-pages").evaluate((pages) => {
      const [first, second] = [1, 2].map((number) => [...pages.querySelectorAll<HTMLElement>(`.pdf-page[data-page="${number}"] .textLayer span`)].filter((span) => span.textContent!.trim().length > 20));
      const from = first!.at(-1)!.firstChild!;
      const to = second![0]!.firstChild!;
      getSelection()!.setBaseAndExtent(from, 0, to, to.textContent!.length);
      return getSelection()!.toString();
    });
    expect(across.length).toBeGreaterThan(0);
    await build();
    await built(1, 2);
    expect(await selected()).toBe(across);

    // A build that ends while the pointer is pressed in a page, as during a drag, leaves the old pages as they are, laid
    // out and scrolled as they were, and shows the new PDF once the press ends, even when it ends without letting go,
    // as when the selected text is dragged away.
    await root.locator('.pdf-page[data-page="1"] .textLayer').dispatchEvent("pointerdown");
    const scrolled = await root.locator(".pdf-scroll").evaluate((scroller) => scroller.scrollTop);
    await build();
    await built();
    // Time for the view to read the new PDF, which waits for the press.
    await Bun.sleep(1500);
    expect(await root.locator(".pdf-page[data-stale]").count()).toBe(0);
    expect(await root.locator('.pdf-page[data-page="1"] canvas:not(.before-build)').count()).toBe(0);
    await expect(root.locator(".pdf-scroll").evaluate((scroller) => scroller.scrollTop)).resolves.toBe(scrolled);
    await root.locator(".pdf-scroll").evaluate(() => dispatchEvent(new PointerEvent("pointercancel")));
    await redrawn(1);
    await root.locator(".pdf-scroll").evaluate((scroller) => {
      getSelection()!.removeAllRanges();
      scroller.scrollTop = 0;
    });
  }, 60_000);

  test("a release the view never saw ends the press once the pointer moves with no button held", async () => {
    const compileButton = root.getByRole("button", { name: "▶ Compile" });
    await root.locator('.pdf-page[data-page="1"] .textLayer span').first().waitFor({ timeout: 10_000 });
    for (let tries = 0; tries < 100 && (await compileButton.isDisabled()); tries++) await Bun.sleep(100);
    // The test before leaves pages to draw after its scroll back to the top.
    await Bun.sleep(1_000);
    await root.locator(".pdf-page canvas").evaluateAll((all) => all.forEach((canvas) => canvas.classList.add("before-build")));
    // The press begins, and its release is lost: no pointerup reaches the view.
    await root.locator('.pdf-page[data-page="1"] .textLayer').dispatchEvent("pointerdown");
    await compileButton.evaluate((button: HTMLButtonElement) => button.click());
    await Bun.sleep(300);
    for (let tries = 0; tries < 100 && (await compileButton.isDisabled()); tries++) await Bun.sleep(100);
    await Bun.sleep(300);
    // The new PDF waits for the press: the old pages are still there, and the text layer is still marked.
    expect(await root.locator('.pdf-page[data-page="1"] canvas:not(.before-build)').count()).toBe(0);
    expect(await root.locator(".textLayer.selecting").count()).toBeGreaterThan(0);
    // A move with a button held doesn't end it.
    await root.locator(".pdf-scroll").evaluate(() => dispatchEvent(new PointerEvent("pointermove", { buttons: 1 })));
    await Bun.sleep(300);
    expect(await root.locator(".textLayer.selecting").count()).toBeGreaterThan(0);
    // The pointer seen with no button held ends it, and the new PDF shows.
    await root.locator(".pdf-scroll").evaluate(() => dispatchEvent(new PointerEvent("pointermove", { buttons: 0 })));
    await root.locator('.pdf-page[data-page="1"] canvas:not(.before-build)').waitFor({ timeout: 20_000 });
    expect(await root.locator(".textLayer.selecting").count()).toBe(0);
  }, 60_000);

  test("the PDF scrolls with the editor while the lock is on", async () => {
    await root.getByRole("button", { name: "Split", exact: true }).click();
    const pdfTop = () => root.locator(".pdf-scroll").evaluate((element) => element.scrollTop);
    const scrollEditorTo = (heading: string) =>
      root.locator(".cm-scroller").evaluate((scroller, heading) => {
        const line = [...scroller.querySelectorAll(".cm-line")].find((candidate) => candidate.textContent?.includes(heading) && /cm-v-h/.test(candidate.className))!;
        scroller.scrollTop += line.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      }, heading);
    await scrollEditorTo("Method");
    await Bun.sleep(300);
    expect(await pdfTop()).toBeGreaterThan(100);
    await root.locator(".cm-scroller").evaluate((scroller) => (scroller.scrollTop = 0));
    await Bun.sleep(300);
    expect(await pdfTop()).toBe(0);
    // Unlocked, the PDF stays where it is.
    await root.locator(".scroll-lock").click();
    await scrollEditorTo("Method");
    await Bun.sleep(300);
    expect(await pdfTop()).toBe(0);
    await root.locator(".scroll-lock").click();
    await root.locator(".cm-scroller").evaluate((scroller) => (scroller.scrollTop = 0));
  });

  test("a file of the workspace opens from the list, in its language, and the first one comes back", async () => {
    await mkdir(join(harness.folder, "notes"), { recursive: true });
    await writeFile(join(harness.folder, "notes", "todo.md"), "# To do\n\n- Write the *paper*.\n");
    await root.locator(".files button[title='List the files again']").click();
    await expect(root.locator('.file-row[data-path="paper.tex"] .main-badge').textContent()).resolves.toBe("main");
    await root.locator('.file-row[data-path="notes"]').click();
    await root.locator('.file-row[data-path="notes/todo.md"]').click();
    await root.locator('.app[data-language="markdown"]').waitFor({ timeout: 10_000 });
    await expect(root.locator(".md-preview h1").textContent()).resolves.toBe("To do");
    await expect(root.locator(".file-row.open").getAttribute("data-path")).resolves.toBe("notes/todo.md");
    await root.locator('.file-row[data-path="paper.tex"]').click();
    await root.locator('.app[data-language="latex"]').waitFor({ timeout: 10_000 });
    // An earlier test made it "A Bigger Example".
    await expect(root.locator(".cm-v-title").textContent()).resolves.toEndWith("Example");
  }, 30_000);

  test("Changes marks the words changed since the file was opened, and its file in the list, until it is off", async () => {
    await root.locator(".changes-toggle").click();
    await expect(root.locator(".changes-menu").inputValue()).resolves.toBe("");
    // Earlier tests typed this, and the agent made the title "A Bigger Example".
    await root.locator(".cm-changed", { hasText: "Typed by the user" }).first().waitFor({ timeout: 5000 });
    await expect(root.locator(".cm-content").evaluate((content) => [...content.querySelectorAll(".cm-changed")].some((mark) => mark.textContent?.includes("links five constants")))).resolves.toBe(false);
    await root.locator('.file-row[data-path="paper.tex"] .changed-dot').waitFor({ timeout: 5000 });
    await root.locator(".cm-line", { hasText: "links five constants" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Freshly", { delay: 15 });
    await root.locator(".cm-changed", { hasText: "Freshly" }).first().waitFor({ timeout: 5000 });
    // Only the command around a word changes, which Visual mode hides: the mark goes to the word it wraps.
    await root.getByRole("button", { name: "Source" }).click();
    await root.locator(".cm-line", { hasText: "\\emph{emphasis}" }).click();
    // Selects "emph" in the line, which may wrap, through the page's own selection.
    await root.locator(".cm-content").evaluate((content) => {
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = (node as Text).data.indexOf("\\emph");
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at + 1);
        range.setEnd(node, at + 5);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      throw new Error("no emph in the source");
    });
    await page.keyboard.type("textbf", { delay: 15 });
    await root.getByRole("button", { name: "Visual" }).click();
    // Visual mode shows the markup under the cursor, so the cursor goes elsewhere.
    await root.locator(".cm-line", { hasText: "links five constants" }).click();
    await root.locator(".cm-changed", { hasText: "emphasis" }).first().waitFor({ timeout: 5000 });
    await root.locator(".changes-toggle").click();
    await expect(root.locator(".cm-changed").count()).resolves.toBe(0);
    await expect(root.locator(".changed-dot").count()).resolves.toBe(0);
  }, 20_000);

  test("nothing threw", () => {
    expect(errors).toEqual([]);
  });
});
