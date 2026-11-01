/**
 * Cuts the video from the takes: video/out/desktop (capture-desktop.ts), video/out/mirador (capture.ts --short), the
 * cards (cards.ts) and the narration (narrate.ts). Each shot is a stretch of a take between two of its moments, played
 * at the length the shot is given, with the camera easing between views of the window; shots cross-fade into each
 * other. render.py draws the frames; ffmpeg lays the narration under them. `bun video/lib/edit.ts` writes
 * video/out/neo-manuscript.mp4.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LINES, type LineName } from "./lines.ts";

const out = join(import.meta.dir, "..", "out");
const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
/** The takes' frames are the window's CSS pixels times this. */
const SCALE = 5 / 3;
const CSS = { width: 1536, height: 864 };

interface Take {
  dir: string;
  frames: { t: number; file: string }[];
  moments: { name: string; at: number }[];
}

function take(name: string): Take {
  const dir = join(out, name);
  return {
    dir,
    frames: JSON.parse(readFileSync(join(dir, "frames.json"), "utf8")),
    moments: JSON.parse(readFileSync(join(dir, "moments.json"), "utf8")),
  };
}

/** A moment of a take, in seconds; the nth of that name, or the last with nth -1. */
function moment(source: Take, name: string, nth = 0): number {
  const all = source.moments.filter((m) => m.name === name);
  const found = nth < 0 ? all.at(nth) : all[nth];
  if (!found) throw new Error(`no moment "${name}" in ${source.dir}`);
  return found.at;
}

/** Part of the window to show: its centre and width in CSS pixels; the height follows at 16:9. */
type View = { cx: number; cy: number; w: number };
const FULL: View = { cx: CSS.width / 2, cy: CSS.height / 2, w: CSS.width };

interface Shot {
  /** A take's stretch, or a card. */
  source: { take: Take; from: number; to: number } | { still: string };
  seconds: number;
  /** Views the camera eases to, at seconds into the shot. */
  camera?: { at: number; view: View; ease?: number }[];
  /** Narration lines, at seconds into the shot. */
  say?: { at: number; line: LineName }[];
}

const FADE = 0.6;

function viewAt(shot: Shot, at: number): View {
  let view = shot.camera?.[0]?.at === 0 ? shot.camera[0].view : FULL;
  for (const key of shot.camera ?? []) {
    if (at < key.at) break;
    const ease = key.ease ?? 1;
    const p = Math.min(1, (at - key.at) / ease);
    const s = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
    view = { cx: view.cx + (key.view.cx - view.cx) * s, cy: view.cy + (key.view.cy - view.cy) * s, w: view.w + (key.view.w - view.w) * s };
  }
  return view;
}

/** The view as a crop of the frame, in its pixels, kept inside the frame. */
function rect(view: View): [number, number, number, number] {
  const w = Math.min(CSS.width, view.w);
  const h = (w * 9) / 16;
  const x = Math.max(0, Math.min(CSS.width - w, view.cx - w / 2));
  const y = Math.max(0, Math.min(CSS.height - h, view.cy - h / 2));
  return [x * SCALE, y * SCALE, w * SCALE, h * SCALE];
}

function frameAt(shot: Shot, at: number): string {
  if ("still" in shot.source) return shot.source.still;
  const { take: source, from, to } = shot.source;
  const t = from + ((to - from) * at) / shot.seconds;
  let lo = 0;
  let hi = source.frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (source.frames[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  return join(source.dir, "frames", source.frames[lo]!.file);
}

// --- The cut -----------------------------------------------------------------------------------------------------------

const desktop = take("desktop");
const mirador = take("mirador");
const d = (name: string, nth = 0) => moment(desktop, name, nth);
const m = (name: string, nth = 0) => moment(mirador, name, nth);
const stretch = (source: Take, from: number, to: number) => ({ take: source, from, to });

// Where things are in the desktop window (CSS pixels), from its stills.
const EDITOR: View = { cx: 470, cy: 420, w: 1000 };
const EDITOR_LOW: View = { cx: 470, cy: 560, w: 1000 };
const SYNONYMS: View = { cx: 640, cy: 430, w: 1100 };
const WITH_CHAT: View = { cx: 1000, cy: 560, w: 1180 };

const shots: Shot[] = [
  { source: { still: join(out, "cards", "title.jpg") }, seconds: 6.5, say: [{ at: 0.4, line: "intro" }] },
  {
    // Visual mode: the heading shows its markup under the cursor.
    source: stretch(desktop, d("start") + 1.5, d("author typing")),
    seconds: d("author typing") - d("start") - 1.5,
    camera: [{ at: 0, view: FULL }, { at: d("visual") - d("start") - 1.5, view: EDITOR, ease: 1.2 }, { at: d("author typing") - d("start") - 3.2, view: EDITOR_LOW, ease: 1.2 }],
    say: [{ at: 3.5, line: "visual" }],
  },
  {
    // The author types; the PDF follows.
    source: stretch(desktop, d("author typing"), d("pdf updated")),
    seconds: (d("pdf updated") - d("author typing")) / 1.7,
    camera: [{ at: 0, view: EDITOR_LOW }, { at: (d("author done") - d("author typing")) / 1.7, view: FULL, ease: 1.2 }],
    say: [{ at: (d("author done") - d("author typing")) / 1.7 - 0.2, line: "live" }],
  },
  {
    // From the PDF to the source, and a synonym.
    source: stretch(desktop, d("pdf updated"), d("chat open") - 0.3),
    seconds: d("chat open") - 0.3 - d("pdf updated"),
    camera: [{ at: 0, view: FULL }, { at: d("synonyms") - d("pdf updated") - 0.8, view: SYNONYMS, ease: 1 }],
    say: [{ at: d("synctex") - d("pdf updated") - 1, line: "synctex" }, { at: d("synonyms") - d("pdf updated") - 0.2, line: "synonyms" }],
  },
  {
    // The chat opens and the author asks.
    source: stretch(desktop, d("chat open") - 0.3, d("ask sent") + 0.5),
    seconds: 1.2 + (d("ask sent") + 0.5 - d("chat open") - 0.9) / 1.6,
    camera: [{ at: 0, view: SYNONYMS }, { at: 1.4, view: WITH_CHAT, ease: 1.4 }],
    say: [{ at: 0.4, line: "ask" }],
  },
  {
    // The agent's turn, sped up.
    source: stretch(desktop, d("ask sent") + 0.5, d("agent done") + 1),
    seconds: 15,
    camera: [{ at: 0, view: WITH_CHAT }, { at: 0.6, view: FULL, ease: 1.5 }],
    say: [{ at: 1.2, line: "agent" }, { at: 11.2, line: "clean" }],
  },
  {
    // The result.
    source: stretch(desktop, d("pdf") - 0.6, d("end")),
    seconds: d("end") - d("pdf") + 0.6,
    camera: [{ at: 0, view: FULL }, { at: 1.6, view: { cx: 768, cy: 400, w: 1150 }, ease: 2.5 }],
    say: [{ at: 1.2, line: "pdf" }],
  },
  {
    // The same in Mirador.
    source: stretch(mirador, m("paper changed") - 3, m("end")),
    seconds: 7.5,
    say: [{ at: 0.7, line: "mirador" }],
  },
  { source: { still: join(out, "cards", "end.jpg") }, seconds: 5, say: [{ at: 0.6, line: "end" }] },
];

// --- Frames ------------------------------------------------------------------------------------------------------------

/** A shot cross-fades in from another take or a card; one going on in the same take cuts straight in. */
const fadeIn = (index: number) => {
  const shot = shots[index]!;
  const before = shots[index - 1];
  if (!before) return 0;
  const sameTake = "take" in shot.source && "take" in before.source && shot.source.take === before.source.take;
  return sameTake ? 0 : FADE;
};
const starts: number[] = [];
let clock = 0;
for (const [i, shot] of shots.entries()) {
  starts.push(clock);
  clock += shot.seconds - (i < shots.length - 1 ? fadeIn(i + 1) : 0);
}
const total = clock;

const frames = [];
for (let i = 0; i < Math.round(total * FPS); i++) {
  const t = i / FPS;
  const layers = [];
  for (const [index, shot] of shots.entries()) {
    const at = t - starts[index]!;
    if (at < 0 || at >= shot.seconds) continue;
    const fade = fadeIn(index);
    layers.push({ src: frameAt(shot, at), rect: "still" in shot.source ? [0, 0, CSS.width * SCALE, CSS.height * SCALE] : rect(viewAt(shot, at)), alpha: fade && at < fade ? at / fade : 1 });
  }
  const black = Math.max(0, 1 - t / 0.5, (t - (total - 0.8)) / 0.8);
  frames.push({ layers, black: Math.min(1, black) });
}
const plan = join(tmpdir(), `neo-manuscript-plan-${process.pid}.json`);
writeFileSync(plan, JSON.stringify({ fps: FPS, width: WIDTH, height: HEIGHT, frames }));

// --- Narration ---------------------------------------------------------------------------------------------------------

const lengths = JSON.parse(readFileSync(join(out, "narration", "manifest.json"), "utf8")).seconds as Record<LineName, number>;
const cues = shots
  .flatMap((shot, index) => (shot.say ?? []).map(({ at, line }) => ({ line, at: starts[index]! + at })))
  .sort((a, b) => a.at - b.at);
let free = 0;
for (const cue of cues) {
  if (cue.at < free + 0.2) {
    console.warn(`"${cue.line}" would start ${(free + 0.2 - cue.at).toFixed(2)} s into the line before; moved`);
    cue.at = free + 0.2;
  }
  free = cue.at + lengths[cue.line];
}
console.log(cues.map((cue) => `${cue.at.toFixed(1).padStart(5)}  ${cue.line}: ${LINES[cue.line]}`).join("\n"));
console.log(`total ${total.toFixed(1)} s; narration ends at ${free.toFixed(1)} s`);

// --- Render ------------------------------------------------------------------------------------------------------------

const silent = join(out, "picture.mp4");
const python = join(homedir(), ".cache", "mirador-video", "venv", "bin", "python");
const render = Bun.spawnSync([python, "-I", join(import.meta.dir, "render.py"), plan, silent], { stdout: "inherit", stderr: "inherit", cwd: tmpdir() });
if (render.exitCode !== 0) throw new Error("render failed");

const inputs = cues.flatMap((cue) => ["-i", join(out, "narration", `${cue.line}.wav`)]);
const delays = cues.map((cue, i) => `[${i + 1}:a]aresample=48000,adelay=${Math.round(cue.at * 1000)}:all=1[a${i}]`);
const mix = `${delays.join(";")};${cues.map((_, i) => `[a${i}]`).join("")}amix=inputs=${cues.length}:normalize=0,apad,atrim=0:${total.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11[voice]`;
const final = join(out, "neo-manuscript.mp4");
const mux = Bun.spawnSync(
  ["ffmpeg", "-y", "-loglevel", "error", "-i", silent, ...inputs, "-filter_complex", mix, "-map", "0:v", "-map", "[voice]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", final],
  { stdout: "inherit", stderr: "inherit" },
);
if (mux.exitCode !== 0) throw new Error("ffmpeg failed");
rmSync(silent);
rmSync(plan);
console.log("wrote", final);
