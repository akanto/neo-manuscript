import { describeDocument } from "./describe.ts";
import type { TexDocument } from "./document.ts";
import { OPERATIONS_HELP, parseOperation, type Operation } from "./ops.ts";

/**
 * The agent's tools, for a host that gives an agent tools of its own: an MCP server, or a chat that runs the agent
 * itself. Mirador has its own (app_state, apply, app_run), which reach the same code through hosts/mirador/host.ts.
 */

/** What a host lets the tools do: read the document as it is now, change it as the agent, and build the PDF. */
export interface AgentSession {
  document(): TexDocument;
  /** Applies an operation as the agent; returns what it did, in a few words. */
  apply(operation: Operation): Promise<string>;
  /** Builds the PDF; returns the build's summary, with its first errors, or throws them. */
  compile(): Promise<string>;
}

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema of the tool's input. */
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[] };
  run(session: AgentSession, input: Record<string, unknown>): Promise<string>;
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "get_document",
    description: "The LaTeX document open in the editor: its class, outline and source with line numbers, and the operations that change it. Read it before changing the document, and again when an operation says the text has changed.",
    inputSchema: { type: "object", properties: {}, required: [] },
    run: async (session) => describeDocument(session.document(), 'the "compile" tool'),
  },
  {
    name: "apply",
    description: `Changes the document, as the user sees it in the editor. ${OPERATIONS_HELP}`,
    inputSchema: {
      type: "object",
      properties: { operation: { type: "object", description: 'One operation, such as {"op":"replace","find":"old text","with":"new text"}.' } },
      required: ["operation"],
    },
    run: async (session, input) => session.apply(parseOperation(input.operation)),
  },
  {
    name: "compile",
    description: "Builds the PDF and reports LaTeX errors and warnings with their lines. The user sees the new PDF beside the editor.",
    inputSchema: { type: "object", properties: {}, required: [] },
    run: async (session) => session.compile(),
  },
];
