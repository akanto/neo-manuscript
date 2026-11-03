/**
 * What a host with a chat tells the view of a conversation with an agent, in order: ACP's session updates (the agent's
 * text, thoughts, tool calls and plan), its questions for permission, and the session's options, such as its model.
 */
import type { RequestPermissionRequest, SessionConfigOption, SessionUpdate } from "@agentclientprotocol/sdk";

export interface AgentChoice {
  id: string;
  label: string;
  /** Why it can't run here, when it can't. */
  missing: string | null;
}

/** An image in a message, as ACP carries it. */
export interface ChatImage {
  mimeType: string;
  /** The image's bytes, in base64. */
  data: string;
}

/** A conversation of the past, as the agent lists them, to take up again. */
export interface PastChat {
  sessionId: string;
  title: string | null;
  updatedAt: string | null;
}

export type ChatEvent =
  | { type: "agents"; agents: AgentChoice[]; current: string }
  | { type: "status"; state: "starting" | "ready" | "working" | "failed" | "closed" | "signed-out" | "signing-in"; message?: string }
  | { type: "config"; options: SessionConfigOption[] }
  | { type: "user"; text: string; images?: ChatImage[] }
  | { type: "update"; update: SessionUpdate }
  | { type: "permission"; id: number; request: RequestPermissionRequest }
  | { type: "permission-answered"; id: number; optionId: string | null }
  | { type: "turn-end"; stopReason: string };
