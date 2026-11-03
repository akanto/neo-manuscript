/**
 * The screenshots in screenshots/, for Mirador's plugin store: the view in Chrome around the harness, on
 * examples/paper.tex and on a Markdown file. `bun run build && bun scripts/screenshots.ts`; needs Chrome and TeX.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { startHarness } from "../e2e/harness.ts";

const repo = join(import.meta.dir, "..");
const out = join(repo, "screenshots");
const viewport = { width: 1440, height: 900 };

async function open(file: string, ready: (page: Page) => Promise<unknown>) {
  const harness = await startHarness(file);
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2, colorScheme: "light" });
  await page.goto(harness.url);
  await ready(page);
  return { page, stop: async () => (await browser.close(), harness.stop()) };
}

const settle = (page: Page) => page.waitForTimeout(1500);

// LaTeX in Visual mode next to its PDF, with a formula's source open to edit.
{
  const { page, stop } = await open(join(repo, "examples", "paper.tex"), (page) => page.locator(".pdf-page canvas").first().waitFor({ timeout: 90_000 }));
  await page.locator(".build-status", { hasText: /0 errors/ }).waitFor({ timeout: 60_000 });
  await page.locator(".cm-v-math").nth(1).click();
  await settle(page);
  await page.screenshot({ path: join(out, "visual.png") });

  // Source mode, with an error in the list and on its line.
  await page.getByRole("button", { name: "Source" }).click();
  await page.locator(".cm-line", { hasText: "links five constants" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" \\nosuchcommand", { delay: 10 });
  await page.locator(".problems-toggle.has-errors").waitFor({ timeout: 60_000 });
  await page.locator(".problems-toggle").click();
  await settle(page);
  await page.screenshot({ path: join(out, "errors.png") });
  await stop();
}

// A Markdown file in Visual mode, with its preview where the PDF would be.
{
  const folder = await mkdtemp(join(tmpdir(), "manuscript-shots-"));
  const file = join(folder, "notes.md");
  await writeFile(
    file,
    `# Reading notes

Notes for the **related work** section, to move into \`paper.tex\` later.

## Euler's identity

It links five constants: $e^{i\\pi} + 1 = 0$. The series behind it,

$$
e^{x} = \\sum_{n=0}^{\\infty} \\frac{x^n}{n!},
$$

converges for every $x$.

## To do

- [x] Check the proof of the convergence
- [ ] Add a figure of the partial sums
- [ ] Ask the agent to turn the table into LaTeX

| Terms | Error at $x = 1$ |
| ----: | ---------------: |
| 2 | 0.718 |
| 4 | 0.052 |
| 8 | 0.00003 |

> Write first; fix the formatting later.
`,
  );
  const { page, stop } = await open(file, (page) => page.locator(".md-preview h1").waitFor({ timeout: 30_000 }));
  await settle(page);
  await page.screenshot({ path: join(out, "markdown.png") });
  await stop();
}

console.log(`Wrote the screenshots to ${out}`);
