/**
 * The Claude Code the chat runs when the user has none installed: the one the Claude Agent SDK ships for this
 * platform, fetched from npm the first time the chat starts. Which version, and the hash each platform's package
 * must have, come from bun.lock at build time (scripts/build-desktop.ts writes them to claude-code.json beside the
 * agents), so it is the same Claude Code that claude-agent-acp was built against. Signing in to it signs in to
 * Claude Code as a whole: it keeps its account where an installed Claude Code does.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { downloadProgram, toolsFolder, type Download, type DownloadOptions } from "../../core/downloads.ts";

/** What scripts/build-desktop.ts writes: the SDK's version, and each platform package's npm integrity. */
export interface ClaudeCodeManifest {
  version: string;
  /** By `${platform}-${arch}` (as Node names them, e.g. "darwin-arm64"): its `sha512-…` integrity. */
  integrity: Record<string, string>;
}

export const MANIFEST_NAME = "claude-code.json";

const PACKAGE = (key: string) => `claude-agent-sdk-${key}`;

/** The manifest from bun.lock's text: the SDK's version, and the integrity of each platform package it lists. */
export function manifestFromLock(lock: string): ClaudeCodeManifest {
  const version = /"@anthropic-ai\/claude-agent-sdk": \["@anthropic-ai\/claude-agent-sdk@([^"]+)"/.exec(lock)?.[1];
  if (!version) throw new Error("bun.lock doesn't list @anthropic-ai/claude-agent-sdk");
  const integrity: Record<string, string> = {};
  for (const match of lock.matchAll(/"@anthropic-ai\/claude-agent-sdk-([a-z0-9-]+)": \["@anthropic-ai\/claude-agent-sdk-[a-z0-9-]+@([^"]+)".*?"(sha512-[^"]+)"\]/g)) {
    if (match[2] === version) integrity[match[1]!] = match[3]!;
  }
  return { version, integrity };
}

/** The download of Claude Code for this platform, or null when the manifest has none for it. */
export function claudeCodeDownload(manifest: ClaudeCodeManifest, platform = process.platform, arch = process.arch): Download | null {
  const key = `${platform}-${arch}`;
  const integrity = manifest.integrity[key];
  if (!integrity?.startsWith("sha512-")) return null;
  const name = PACKAGE(key);
  const program = platform === "win32" ? "claude.exe" : "claude";
  return {
    url: `https://registry.npmjs.org/@anthropic-ai/${name}/-/${name}-${manifest.version}.tgz`,
    digest: { algorithm: "sha512", base64: integrity.slice("sha512-".length) },
    archive: "tar.gz",
    entry: `package/${program}`,
    target: join(toolsFolder(), "claude-code", manifest.version, program),
  };
}

function readManifest(agentsFolder: string): ClaudeCodeManifest | null {
  try {
    return JSON.parse(readFileSync(join(agentsFolder, MANIFEST_NAME), "utf8")) as ClaudeCodeManifest;
  } catch {
    return null;
  }
}

/** The Claude Code fetched earlier, if there is one; null when it would have to be fetched first, or can't be. */
export function downloadedClaudeCode(agentsFolder: string): string | null {
  const manifest = readManifest(agentsFolder);
  const download = manifest && claudeCodeDownload(manifest);
  return download && existsSync(download.target) ? download.target : null;
}

/** Whether this build can fetch Claude Code for this machine. */
export function canDownloadClaudeCode(agentsFolder: string): boolean {
  const manifest = readManifest(agentsFolder);
  return manifest !== null && claudeCodeDownload(manifest) !== null;
}

/** Fetches Claude Code, unless it was fetched before; returns its path. */
export function downloadClaudeCode(agentsFolder: string, options: DownloadOptions = {}): Promise<string> {
  const manifest = readManifest(agentsFolder);
  const download = manifest && claudeCodeDownload(manifest);
  if (!download) return Promise.reject(new Error("This build of the app can't fetch Claude Code for this machine. Install it from claude.com/claude-code."));
  return downloadProgram(download, options);
}

/** Whether Claude Code has an account signed in, by `claude auth status`; null when it can't tell. */
export async function isSignedIn(program: string, env: Record<string, string>): Promise<boolean | null> {
  try {
    const child = Bun.spawn([program, "auth", "status"], { env, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 15_000 });
    const [output] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const status = JSON.parse(output) as { loggedIn?: unknown };
    return typeof status.loggedIn === "boolean" ? status.loggedIn : null;
  } catch {
    return null;
  }
}

/** Runs `claude auth login`, which opens the browser to sign in, and resolves when it ends; throws why it failed. */
export async function signIn(program: string, env: Record<string, string>, signal?: AbortSignal): Promise<void> {
  const child = Bun.spawn([program, "auth", "login"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10 * 60_000 });
  const stop = () => child.kill();
  signal?.addEventListener("abort", stop);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) {
      const said = `${stdout}\n${stderr}`.trim().split("\n").slice(-4).join("\n");
      throw new Error(`Signing in didn't finish${said ? `: ${said}` : "."}`);
    }
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}
