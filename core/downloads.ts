/**
 * Programs the app fetches the first time it needs them, when the user has none installed: Tectonic for builds, and
 * Claude Code for the desktop chat. Each is pinned to a version and checked against a known hash before it's kept.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where downloaded programs are kept, one folder per program and version. NEO_TOOLS_DIR overrides it (tests). */
export function toolsFolder(): string {
  if (process.env.NEO_TOOLS_DIR) return process.env.NEO_TOOLS_DIR;
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "NeoManuscript", "tools");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "NeoManuscript", "tools");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "neo-manuscript", "tools");
}

/** The hash a download must have: sha256 as hex (GitHub's), or sha512 as base64 (npm's `integrity` without `sha512-`). */
export type Digest = { algorithm: "sha256"; hex: string } | { algorithm: "sha512"; base64: string };

export interface Download {
  url: string;
  digest: Digest;
  /** The archive's kind: a .tar.gz or a .zip (both unpacked with `tar`). */
  archive: "tar.gz" | "zip";
  /** The program's path inside the archive, e.g. "tectonic" or "package/claude". */
  entry: string;
  /** Where the program goes; its folder is made. */
  target: string;
}

export interface DownloadOptions {
  /** Called with the share received, 0 to 1, when the size is known, else null. */
  progress?: (share: number | null) => void;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}

const inFlight = new Map<string, Promise<string>>();

/**
 * Fetches the archive, checks its hash, unpacks the program to `target` and makes it executable. Returns `target`.
 * A program already at `target` is returned as it is. Two calls for one target share the download.
 */
export function downloadProgram(download: Download, options: DownloadOptions = {}): Promise<string> {
  if (existsSync(download.target)) return Promise.resolve(download.target);
  let running = inFlight.get(download.target);
  if (!running) {
    running = fetchAndUnpack(download, options).finally(() => inFlight.delete(download.target));
    inFlight.set(download.target, running);
  }
  return running;
}

async function fetchAndUnpack({ url, digest, archive, entry, target }: Download, { progress, signal, fetcher = fetch }: DownloadOptions): Promise<string> {
  const response = await fetcher(url, { signal, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Couldn't download ${url}: ${response.status} ${response.statusText}`);
  const size = Number(response.headers.get("content-length")) || null;
  const hash = createHash(digest.algorithm);
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
    chunks.push(chunk);
    received += chunk.byteLength;
    progress?.(size ? Math.min(1, received / size) : null);
  }
  const actual = digest.algorithm === "sha256" ? hash.digest("hex") : hash.digest("base64");
  const expected = digest.algorithm === "sha256" ? digest.hex.toLowerCase() : digest.base64;
  if (actual !== expected) throw new Error(`The download from ${url} isn't the expected file (its ${digest.algorithm} doesn't match), so it wasn't used.`);

  const folder = join(target, "..");
  await mkdir(folder, { recursive: true });
  const work = await mkdtemp(join(folder, ".download-"));
  try {
    const file = join(work, `archive.${archive}`);
    await writeFile(file, Buffer.concat(chunks));
    const tar = Bun.spawn(["tar", "-xf", file, "-C", work, entry], { stdout: "ignore", stderr: "pipe" });
    const [error, code] = await Promise.all([new Response(tar.stderr).text(), tar.exited]);
    if (code !== 0) throw new Error(`Couldn't unpack ${entry} from ${url}: ${error.trim()}`);
    await chmod(join(work, entry), 0o755);
    await rename(join(work, entry), target);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return target;
}
