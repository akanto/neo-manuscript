/**
 * The app's updates, with Electrobun's Updater: it reads `<release.baseUrl>/stable-<platform>-<arch>-update.json` (see
 * electrobun.config.ts), downloads the new version (a binary patch from this one when the release has one), and puts it
 * in place of this one when the app restarts. Builds of the dev channel don't update.
 */
import { Updater, Utils } from "electrobun/bun";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** How often a running app looks for a new version, besides once soon after it starts. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_AFTER_MS = 15_000;

/**
 * Ends the launcher left over from the app's first start. On its first start, Electrobun's launcher (2.0.5) unpacks the
 * app, starts it with a launcher of its own, and then doesn't exit; macOS takes that one for the app running, so the
 * app doesn't start again after an update (or from the Dock, once quit). The app's own launcher is its parent; any
 * other launcher of the same bundle is the one left over.
 */
export function endLeftoverLauncher() {
  if (process.platform !== "darwin") return;
  let launcher: string;
  try {
    launcher = realpathSync(join(dirname(process.execPath), "launcher"));
  } catch {
    return;
  }
  const listed = Bun.spawnSync(["ps", "-ax", "-o", "pid=,ppid=,command="]).stdout.toString();
  for (const line of listed.split("\n")) {
    const match = /^\s*(\d+)\s+\d+\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2]!.trim();
    if (pid === process.ppid || pid === process.pid) continue;
    if (command === launcher || command === launcher.replace(/^\/private\//, "/")) process.kill(pid, "SIGTERM");
  }
}

export class AppUpdates {
  /** The version downloaded and ready, waiting for a restart; null while there is none. */
  ready: string | null = null;
  private checking = false;
  /** Called when what the menu shows changes: an update became ready. */
  onChange: () => void = () => {};

  /** Looks for updates now and then; `beforeRestart` runs before the app quits for one. */
  constructor(private beforeRestart: () => void) {
    setTimeout(() => {
      endLeftoverLauncher();
      void this.check(false);
    }, FIRST_CHECK_AFTER_MS);
    setInterval(() => void this.check(false), CHECK_EVERY_MS);
  }

  /**
   * Looks for a new version and downloads it, then asks whether to restart into it. `asked` is true when the user asked
   * from the menu: then the outcome is told either way, and an error is shown rather than kept quiet.
   */
  async check(asked: boolean) {
    if (this.ready) return asked ? this.offerRestart() : undefined;
    if (this.checking) return;
    this.checking = true;
    try {
      const local = await Updater.getLocalInfo();
      if (local.channel === "dev") {
        if (asked) await this.tell("info", "Updates are off in development builds", `This is ${local.version} of the dev channel.`);
        return;
      }
      const found = await Updater.checkForUpdate();
      if (found.error) {
        if (asked) await this.tell("error", "Couldn't look for updates", found.error);
        return;
      }
      if (!found.updateAvailable) {
        if (asked) await this.tell("info", "NeoManuscript is up to date", `You have ${local.version}, the latest version.`);
        return;
      }
      await Updater.downloadUpdate();
      const info = Updater.updateInfo();
      if (!info.updateReady) {
        if (asked) await this.tell("error", "Couldn't download the update", info.error || "The download didn't finish.");
        return;
      }
      this.ready = info.version || found.version;
      this.onChange();
      await this.offerRestart();
    } catch (error) {
      if (asked) await this.tell("error", "Couldn't update NeoManuscript", (error as Error).message);
    } finally {
      this.checking = false;
    }
  }

  /** Asks whether to restart into the version downloaded; "Later" leaves it for the next start, or the menu. */
  async offerRestart() {
    const { response } = await Utils.showMessageBox({
      type: "info",
      title: "Update ready",
      message: `NeoManuscript ${this.ready ?? ""} is ready.`,
      detail: "Restart now to use it? Your files are saved as you type, and your chat comes back after the restart.",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
    this.beforeRestart();
    await Updater.applyUpdate();
  }

  private async tell(type: "info" | "error", message: string, detail: string) {
    await Utils.showMessageBox({ type, title: "NeoManuscript", message, detail, buttons: ["OK"] });
  }
}
