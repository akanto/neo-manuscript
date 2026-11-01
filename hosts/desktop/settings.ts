import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What the app keeps between runs, in settings.json in its data folder. */
interface SettingsFile {
  /** The project folders opened last, the latest first. */
  recent: string[];
  /** What each project remembers: its main file, if the user chose it, and the file open last. */
  projects: Record<string, { main: string | null; open: string | null }>;
  /** Each project's last conversation with each agent, by its session's id, to take up again. */
  chats: Record<string, Record<string, string>>;
  /** The view's settings (its mode, layout and so on). */
  view: Record<string, string>;
}

const RECENT_KEPT = 10;

export class Settings {
  private data: SettingsFile;
  private readonly path: string;

  constructor(folder: string) {
    this.path = join(folder, "settings.json");
    try {
      const read = JSON.parse(readFileSync(this.path, "utf8")) as Partial<SettingsFile>;
      this.data = { recent: Array.isArray(read.recent) ? read.recent : [], projects: read.projects ?? {}, chats: read.chats ?? {}, view: read.view ?? {} };
    } catch {
      this.data = { recent: [], projects: {}, chats: {}, view: {} };
    }
  }

  get recent(): readonly string[] {
    return this.data.recent;
  }

  opened(folder: string) {
    this.data.recent = [folder, ...this.data.recent.filter((other) => other !== folder)].slice(0, RECENT_KEPT);
    this.save();
  }

  forget(folder: string) {
    this.data.recent = this.data.recent.filter((other) => other !== folder);
    delete this.data.projects[folder];
    delete this.data.chats[folder];
    this.save();
  }

  project(folder: string): { main: string | null; open: string | null } {
    return this.data.projects[folder] ?? { main: null, open: null };
  }

  remember(folder: string, memory: { main: string | null; open: string | null }) {
    const known = this.data.projects[folder];
    if (known?.main === memory.main && known.open === memory.open) return;
    this.data.projects[folder] = memory;
    // Only the recent projects' are kept.
    for (const other of Object.keys(this.data.projects)) if (!this.data.recent.includes(other) && other !== folder) delete this.data.projects[other];
    this.save();
  }

  readonly chats = {
    last: (folder: string, agent: string): string | null => this.data.chats[folder]?.[agent] ?? null,
    remember: (folder: string, agent: string, sessionId: string) => {
      if (this.data.chats[folder]?.[agent] === sessionId) return;
      this.data.chats[folder] = { ...this.data.chats[folder], [agent]: sessionId };
      this.save();
    },
  };

  readonly view = {
    all: () => ({ ...this.data.view }),
    set: (key: string, value: string | null) => {
      if (value === null) delete this.data.view[key];
      else this.data.view[key] = value;
      this.save();
    },
  };

  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.new`, JSON.stringify(this.data, null, 2));
    renameSync(`${this.path}.new`, this.path);
  }
}
