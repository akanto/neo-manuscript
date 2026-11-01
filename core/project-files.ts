/** A project's files on disk, for a host: what is in its folder, and which file is its main one. */
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { BUILD_FOLDER } from "./build.ts";
import { findMainFile, isHidden, kindOf, type ProjectEntry } from "./project.ts";

/** Where a host that can't tell its view the project's files any other way writes them, in the project's folder. */
export const PROJECT_LISTING = `${BUILD_FOLDER}/project.json`;

/**
 * The files and folders in a project's folder, however deep, but those it doesn't show (see isHidden), and its main
 * file. `textOf` gives a .tex file's text as the host has it, when that isn't the file's yet; `chosen` is the main file
 * the user chose, if any.
 */
export async function listProject(
  folder: string,
  { textOf = () => null, chosen = null }: { textOf?: (path: string) => string | null; chosen?: string | null } = {},
): Promise<{ entries: ProjectEntry[]; main: string | null }> {
  const entries: ProjectEntry[] = [];
  const walk = async (at: string, prefix: string) => {
    const children = await readdir(at, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (isHidden(child.name)) continue;
      const path = prefix + child.name;
      if (child.isDirectory()) {
        entries.push({ path, kind: "folder" });
        await walk(join(at, child.name), `${path}/`);
      } else if (child.isFile()) entries.push({ path, kind: "file" });
    }
  };
  await walk(folder, "");
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.kind === "file" && !entry.path.includes("/") && kindOf(entry.path) === "tex")
      .map(async ({ path }) => ({ path, text: textOf(path) ?? (await readFile(join(folder, path), "utf8").catch(() => "")) })),
  );
  return { entries, main: findMainFile(candidates, basename(folder), chosen) };
}
