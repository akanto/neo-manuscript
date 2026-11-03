/** The Tectonic the build downloads when the machine has no TeX: a pinned release from GitHub, checked against its hash. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Download, toolsFolder } from "./downloads.ts";

export const TECTONIC_VERSION = "0.17.0";

/** The sha256 of each release asset, as GitHub lists them for the release. */
const ASSETS: Record<string, { archive: "tar.gz" | "zip"; hex: string }> = {
  "aarch64-apple-darwin": { archive: "tar.gz", hex: "a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667" },
  "x86_64-apple-darwin": { archive: "tar.gz", hex: "7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80" },
  "x86_64-unknown-linux-musl": { archive: "tar.gz", hex: "8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7" },
  "aarch64-unknown-linux-musl": { archive: "tar.gz", hex: "b10954a95404f3ab2328d2fa59a5ebab8e657f893fab096f98be8db7c0c979b8" },
  "x86_64-pc-windows-msvc": { archive: "zip", hex: "f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f" },
};

function targetTriple(platform: string, arch: string): string | null {
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-musl";
  if (platform === "linux" && arch === "arm64") return "aarch64-unknown-linux-musl";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  return null;
}

function programPath(platform: string): string {
  return join(toolsFolder(), "tectonic", TECTONIC_VERSION, platform === "win32" ? "tectonic.exe" : "tectonic");
}

/** The release asset for this platform, or null when Tectonic publishes none. */
export function tectonicDownload(platform: string = process.platform, arch: string = process.arch): Download | null {
  const triple = targetTriple(platform, arch);
  const asset = triple ? ASSETS[triple] : undefined;
  if (!triple || !asset) return null;
  const entry = platform === "win32" ? "tectonic.exe" : "tectonic";
  return {
    url: `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-${triple}.${asset.archive}`,
    digest: { algorithm: "sha256", hex: asset.hex },
    archive: asset.archive,
    entry,
    target: programPath(platform),
  };
}

/** The Tectonic downloaded earlier, when it is still there. */
export function downloadedTectonic(): string | null {
  const path = programPath(process.platform);
  return existsSync(path) ? path : null;
}

/** Whether Tectonic has fetched TeX packages before: its cache holds them. Without it, the first build is slow. */
export function tectonicHasPackages(): boolean {
  const cache =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Caches", "Tectonic")
      : process.platform === "win32"
        ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "TectonicProject", "Tectonic")
        : join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "Tectonic");
  return existsSync(join(cache, "formats"));
}
