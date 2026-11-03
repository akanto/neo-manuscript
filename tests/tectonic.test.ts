import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadProgram } from "../core/downloads.ts";
import { downloadedTectonic, TECTONIC_VERSION, tectonicDownload } from "../core/tectonic.ts";

describe("tectonicDownload", () => {
  test("picks the release asset for each supported platform", () => {
    const base = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}`;
    const cases: [string, string, string, string, string][] = [
      ["darwin", "arm64", "aarch64-apple-darwin.tar.gz", "tar.gz", "tectonic"],
      ["darwin", "x64", "x86_64-apple-darwin.tar.gz", "tar.gz", "tectonic"],
      ["linux", "x64", "x86_64-unknown-linux-musl.tar.gz", "tar.gz", "tectonic"],
      ["linux", "arm64", "aarch64-unknown-linux-musl.tar.gz", "tar.gz", "tectonic"],
      ["win32", "x64", "x86_64-pc-windows-msvc.zip", "zip", "tectonic.exe"],
    ];
    for (const [platform, arch, asset, archive, entry] of cases) {
      const download = tectonicDownload(platform, arch)!;
      expect(download.url).toBe(`${base}-${asset}`);
      expect(download.archive).toBe(archive as "tar.gz" | "zip");
      expect(download.entry).toBe(entry);
      expect(download.target.endsWith(join("tectonic", TECTONIC_VERSION, entry))).toBe(true);
      expect(download.digest).toMatchObject({ algorithm: "sha256" });
      expect((download.digest as { hex: string }).hex).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("has none for other platforms", () => {
    expect(tectonicDownload("win32", "arm64")).toBeNull();
    expect(tectonicDownload("freebsd", "x64")).toBeNull();
    expect(tectonicDownload("linux", "ia32")).toBeNull();
  });
});

describe("downloadProgram", () => {
  let tools: string;
  let work: string;
  let server: ReturnType<typeof Bun.serve>;
  let archive: Buffer;
  const previous = process.env.NEO_TOOLS_DIR;

  beforeAll(async () => {
    tools = await mkdtemp(join(tmpdir(), "neo-tools-"));
    work = await mkdtemp(join(tmpdir(), "neo-archive-"));
    process.env.NEO_TOOLS_DIR = tools;
    await writeFile(join(work, "tectonic"), "#!/bin/sh\necho 0.0.1\n");
    const made = Bun.spawnSync(["tar", "-czf", join(work, "t.tar.gz"), "-C", work, "tectonic"]);
    expect(made.exitCode).toBe(0);
    archive = Buffer.from(await Bun.file(join(work, "t.tar.gz")).arrayBuffer());
    server = Bun.serve({ port: 0, fetch: () => new Response(new Uint8Array(archive), { headers: { "content-length": String(archive.length) } }) });
  });

  afterAll(async () => {
    server.stop(true);
    if (previous === undefined) delete process.env.NEO_TOOLS_DIR;
    else process.env.NEO_TOOLS_DIR = previous;
    await rm(tools, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("unpacks an archive with the right hash, executable, and reports progress", async () => {
    const target = join(tools, "good", "tectonic");
    const shares: (number | null)[] = [];
    const path = await downloadProgram(
      { url: `http://127.0.0.1:${server.port}/t.tar.gz`, digest: { algorithm: "sha256", hex: createHash("sha256").update(archive).digest("hex") }, archive: "tar.gz", entry: "tectonic", target },
      { progress: (share) => shares.push(share) },
    );
    expect(path).toBe(target);
    expect(statSync(target).mode & 0o111).not.toBe(0);
    expect(shares.at(-1)).toBe(1);
    const run = Bun.spawnSync([target]);
    expect(run.stdout.toString().trim()).toBe("0.0.1");
  });

  test("rejects an archive with a wrong hash and leaves nothing at the target", async () => {
    const target = join(tools, "bad", "tectonic");
    const attempt = downloadProgram({ url: `http://127.0.0.1:${server.port}/t.tar.gz`, digest: { algorithm: "sha256", hex: "0".repeat(64) }, archive: "tar.gz", entry: "tectonic", target });
    await expect(attempt).rejects.toThrow(/isn't the expected file/);
    expect(existsSync(target)).toBe(false);
    expect(await readdir(join(tools, "bad")).catch(() => [])).toEqual([]);
  });

  test("finds a Tectonic downloaded earlier", async () => {
    expect(downloadedTectonic()).toBeNull();
    const download = tectonicDownload()!;
    await Bun.write(download.target, "x");
    expect(downloadedTectonic()).toBe(download.target);
  });
});
