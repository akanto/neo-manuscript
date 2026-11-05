/**
 * Writing actions on a selected passage, as Overleaf offers them: fix its grammar, rephrase it, shorten it, make it
 * read as scientific writing, make it clearer, or follow the user's own instruction. A host with an agent turns a
 * RewriteRequest into the passage rewritten (the desktop app through a side conversation with its agent); this file
 * says what the agent is asked and how its answer is read.
 */

export type AssistAction = "grammar" | "rephrase" | "shorten" | "scientific" | "clearer" | "custom";

export interface AssistActionInfo {
  id: AssistAction;
  /** The button's text. */
  label: string;
  /** The button's tooltip. */
  title: string;
  /** What the popup says while the agent works. */
  working: string;
}

/** The actions the popup offers, in its order; "custom" is the instruction field after them. */
export const ASSIST_ACTIONS: AssistActionInfo[] = [
  { id: "grammar", label: "Grammar", title: "Fix grammar, spelling and punctuation, changing as little as possible", working: "Checking the grammar…" },
  { id: "rephrase", label: "Rephrase", title: "Say the same in other words, with a better flow", working: "Rephrasing…" },
  { id: "shorten", label: "Shorten", title: "Make it more concise, keeping every claim", working: "Shortening…" },
  { id: "scientific", label: "Scientific", title: "Make it read as a peer-reviewed paper: formal, precise, objective", working: "Making it more scientific…" },
  { id: "clearer", label: "Clearer", title: "Make it easier to follow, without losing precision", working: "Making it clearer…" },
  { id: "custom", label: "Ask", title: "Rewrite it as you say", working: "Rewriting…" },
];

export interface RewriteRequest {
  action: AssistAction;
  /** The user's own instruction, for "custom". */
  instruction?: string;
  /** The passage, as selected. */
  text: string;
  /** Some of the text before and after the passage, so the rewrite fits it; not to be changed. */
  before: string;
  after: string;
  language: "latex" | "markdown";
}

const INSTRUCTIONS: Record<Exclude<AssistAction, "custom">, string> = {
  grammar: [
    "Correct only errors of grammar, spelling, punctuation, agreement, articles and tense.",
    "Make the fewest changes you can: keep the author's words, style and sentence structure, and don't rephrase what is already correct.",
    "If nothing needs fixing, return the passage exactly as it is.",
  ].join(" "),
  rephrase: "Rephrase the passage so it reads well and flows naturally in an academic register. Keep its meaning, its claims and their strength, its hedging and its technical terms.",
  shorten: "Make the passage more concise, about a third shorter: cut redundancy, filler and wordy constructions. Keep every claim, number, citation, reference and technical term.",
  scientific: [
    "Rewrite the passage in the register of a peer-reviewed scientific paper: precise, formal and objective, with exact terminology,",
    "no colloquialisms or contractions, and claims hedged as the evidence allows. Don't add claims, results or citations the passage doesn't have.",
  ].join(" "),
  clearer: "Make the passage clearer and easier to follow: plainer sentence structure, explicit subjects, and clear logical connections between sentences, without losing precision.",
};

/** What the writing assistant is, for an agent that takes a system prompt of its own (Claude Code does). */
export const ASSIST_SYSTEM_PROMPT = [
  "You are the writing assistant of NeoManuscript, an editor for scientific writing in LaTeX and Markdown.",
  "Each message gives you a passage of a manuscript and what to do with it. You answer with the passage rewritten, between <rewrite> and </rewrite>, and nothing else:",
  "no comments, no explanations, no code fences. You don't use tools and you don't read or change files.",
].join(" ");

/** The rules every rewrite keeps, whatever the action. */
function rules(language: RewriteRequest["language"]): string[] {
  const markup =
    language === "latex"
      ? "Keep LaTeX commands, \\cite, \\ref, \\label and their keys, math between $…$ or \\(…\\), environments, comments and line breaks in place and unchanged, unless the instruction is about them."
      : "Keep the Markdown markup, links, code, math and line breaks in place and unchanged, unless the instruction is about them.";
  return [
    markup,
    "Write in the passage's language, with its spelling (British or American) and its person (we, I, or impersonal).",
    "Don't add facts, results or references. The text around the passage is there for context: don't repeat or change it.",
  ];
}

/** The message that asks the agent for a rewrite. */
export function rewritePrompt(request: RewriteRequest): string {
  const task = request.action === "custom" ? `Rewrite the passage as follows: ${request.instruction?.trim() || "improve it"}.` : INSTRUCTIONS[request.action];
  const kind = request.language === "latex" ? "LaTeX" : "Markdown";
  return [
    `Here is a passage of a ${kind} manuscript. ${task}`,
    "",
    ...rules(request.language),
    "",
    "<before>",
    request.before,
    "</before>",
    "<passage>",
    request.text.trim(),
    "</passage>",
    "<after>",
    request.after,
    "</after>",
    "",
    "Answer with the rewritten passage between <rewrite> and </rewrite>, and nothing else.",
  ].join("\n");
}

/**
 * The message that asks an agent to rewrite a passage in the file itself, for a host whose agent can't answer a
 * rewrite on the side (Mirador's): the agent edits the document, and the user sees the change come in.
 */
export function rewriteInFilePrompt(request: RewriteRequest, place: string): string {
  const task = request.action === "custom" ? `Rewrite it as follows: ${request.instruction?.trim() || "improve it"}.` : INSTRUCTIONS[request.action];
  const kind = request.language === "latex" ? "latex" : "markdown";
  return [
    `Rewrite this passage of the document (${place}). ${task}`,
    ...rules(request.language),
    "Change only this passage in the document, then say in a line what you changed.",
    "",
    "```" + kind,
    request.text.trim(),
    "```",
  ].join("\n");
}

/** The rewritten passage in the agent's answer, with the selection's own whitespace around it. */
export function rewriteFrom(answer: string, original: string): string {
  const tagged = /<rewrite>\n?([\s\S]*?)\n?<\/rewrite>/.exec(answer);
  let text = tagged ? tagged[1]! : answer.replace(/<\/?rewrite>/g, "");
  const fenced = /^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/.exec(text);
  if (fenced) text = fenced[1]!;
  text = text.trim();
  if (!text) throw new Error("The agent answered with no text.");
  const lead = /^\s*/.exec(original)![0];
  const trail = /\s*$/.exec(original)![0];
  return lead + text + trail;
}
