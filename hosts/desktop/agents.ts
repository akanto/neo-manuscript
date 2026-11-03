/**
 * The AI agents the app talks to over ACP (the Agent Client Protocol): Claude Code through claude-agent-acp, and pi
 * through pi-acp. Each runs as a process of its own, bundled into dist/desktop/agents by scripts/build-desktop.ts and
 * run with the app's Bun, and works in the project's folder with its own tools; see chat.ts for a conversation.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { canDownloadClaudeCode, downloadClaudeCode, downloadedClaudeCode } from "./claude-code.ts";

export type AgentId = "claude" | "pi";

export interface AgentInfo {
  id: AgentId;
  label: string;
  /** Why it can't run here, when it can't: the program it drives isn't installed. */
  missing: string | null;
}

/** Where programs are often installed, for an app started from the Dock, which doesn't get the shell's PATH. */
const USUAL_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/Library/TeX/texbin", join(homedir(), ".local", "bin"), join(homedir(), ".bun", "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

let shellPath: Promise<string> | null = null;

/**
 * The PATH of the user's login shell, which an app started from the Dock doesn't have, with the usual places added.
 * The shell runs in a session of its own, away from any terminal, and is given 5 seconds.
 */
export function agentPath(): Promise<string> {
  shellPath ??= new Promise<string>((resolve) => {
    let output = "";
    const shell = spawn(process.env.SHELL || "/bin/zsh", ["-ilc", 'printf "\n%s" "$PATH"'], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => shell.kill("SIGKILL"), 5000);
    shell.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    // Not every shell starts in time, or at all; the usual places are then a fair guess.
    shell.on("error", () => resolve(""));
    shell.on("close", () => {
      clearTimeout(timer);
      resolve(output.trim().split("\n").pop() ?? "");
    });
  }).then((fromShell) => {
    const dirs = [...fromShell.split(delimiter), ...(process.env.PATH ?? "").split(delimiter), ...USUAL_DIRS].filter(Boolean);
    return [...new Set(dirs)].join(delimiter);
  });
  return shellPath;
}

const find = async (command: string) => Bun.which(command, { PATH: await agentPath() });

const PROGRAMS: Record<AgentId, { label: string; program: string; install: string }> = {
  claude: { label: "Claude", program: "claude", install: "Claude Code isn't installed: see claude.com/claude-code, then sign in with `claude`." },
  pi: { label: "pi", program: "pi", install: "pi isn't installed: `npm install -g @earendil-works/pi-coding-agent`, then set up a model with `pi`." },
};

/** Claude Code as installed, else as fetched before (see claude-code.ts); null when it has to be fetched first. */
export async function claudeProgram(agentsFolder: string): Promise<string | null> {
  return (await find("claude")) ?? downloadedClaudeCode(agentsFolder);
}

/** Claude needs nothing installed when the app can fetch Claude Code for this machine; pi needs pi. */
export async function agents(agentsFolder: string): Promise<AgentInfo[]> {
  const available = async (id: AgentId) => (await find(PROGRAMS[id].program)) !== null || (id === "claude" && canDownloadClaudeCode(agentsFolder));
  return Promise.all((Object.keys(PROGRAMS) as AgentId[]).map(async (id) => ({ id, label: PROGRAMS[id].label, missing: (await available(id)) ? null : PROGRAMS[id].install })));
}

/** The environment an agent's programs run with: the user's login shell's PATH. */
export async function agentEnvironment(extraEnvironment: Record<string, string> = {}): Promise<Record<string, string>> {
  return { ...(process.env as Record<string, string>), PATH: await agentPath(), ...extraEnvironment };
}

/**
 * The command and environment that start an agent's ACP side, and the program it drives. Claude Code is fetched
 * first when the user has none, with `downloading` told how far it got (0 to 1, or null when the size isn't known).
 */
export async function agentCommand(
  id: AgentId,
  agentsFolder: string,
  extraEnvironment: Record<string, string>,
  downloading?: (share: number | null) => void,
): Promise<{ command: string[]; env: Record<string, string>; program: string }> {
  const script = join(agentsFolder, id === "claude" ? "claude-agent-acp.js" : "pi-acp.js");
  if (!existsSync(script)) throw new Error(`The app is missing ${script}; build it with \`bun scripts/build-desktop.ts\``);
  let program = id === "claude" ? await claudeProgram(agentsFolder) : await find(PROGRAMS[id].program);
  if (!program && id === "claude" && canDownloadClaudeCode(agentsFolder)) {
    downloading?.(null);
    program = await downloadClaudeCode(agentsFolder, { progress: downloading });
  }
  if (!program) throw new Error(PROGRAMS[id].install);
  const env = await agentEnvironment(extraEnvironment);
  // claude-agent-acp runs this Claude Code, as the user signed in to it; pi-acp the pi installed.
  if (id === "claude") env.CLAUDE_CODE_EXECUTABLE = program;
  else env.PI_ACP_PI_COMMAND = program;
  return { command: [process.execPath, script], env, program };
}
