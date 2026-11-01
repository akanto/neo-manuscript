import { describe, expect, test } from "bun:test";
import { AGENT_TOOLS, type AgentSession } from "../core/agent-tools.ts";
import { parseDocument, type TexDocument } from "../core/document.ts";
import { applyOperation } from "../core/ops.ts";

const SAMPLE = "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nHello world.\n\\end{document}\n";

/** A host with the document in memory, as an MCP server or a built-in chat would keep it. */
function session(text: string): AgentSession & { builds: number } {
  let document: TexDocument = parseDocument(text);
  return {
    builds: 0,
    document: () => document,
    async apply(operation) {
      const applied = applyOperation(document, operation);
      document = applied.document;
      return applied.summary;
    },
    async compile() {
      this.builds++;
      return "Compiled paper.tex with pdflatex to .latex-build/paper.pdf: 1 page, 0 errors, 0 warnings.";
    },
  };
}

const tool = (name: string) => AGENT_TOOLS.find((known) => known.name === name)!;

describe("the agent's tools", () => {
  test("each has a name, a description and an input schema", () => {
    expect(AGENT_TOOLS.map((known) => known.name)).toEqual(["get_document", "apply", "compile"]);
    for (const known of AGENT_TOOLS) {
      expect(known.description.length).toBeGreaterThan(20);
      expect(known.inputSchema.type).toBe("object");
    }
  });

  test("get_document gives the outline and source, and names the compile tool", async () => {
    const described = await tool("get_document").run(session(SAMPLE), {});
    expect(described).toContain("- line 3: \\section Intro");
    expect(described).toContain('the "compile" tool builds the PDF');
    expect(described).not.toContain("app_run");
  });

  test("apply checks the operation and changes the document", async () => {
    const host = session(SAMPLE);
    expect(await tool("apply").run(host, { operation: { op: "replace", find: "Hello world", with: "Hi" } })).toContain("Replaced");
    expect(host.document().text).toContain("Hi.");
    await expect(tool("apply").run(host, { operation: { op: "delete" } })).rejects.toThrow(/replace_lines/);
  });

  test("compile builds through the host", async () => {
    const host = session(SAMPLE);
    expect(await tool("compile").run(host, {})).toStartWith("Compiled");
    expect(host.builds).toBe(1);
  });
});
