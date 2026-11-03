/** What the compile task leaves for the view, in the document's folder. */

export const BUILD_FOLDER = ".latex-build";

export interface Problem {
  severity: "error" | "warning";
  /** The file the log names, relative to the document's folder; null when the log doesn't say. */
  file: string | null;
  line: number | null;
  message: string;
}

export interface BuildReport {
  /** The .tex file built, relative to the document's folder. */
  source: string;
  /** The PDF, relative to the document's folder; null when no build made one yet. */
  pdf: string | null;
  /** Whether this build wrote the PDF; false when it failed and the PDF is an earlier build's. */
  fresh: boolean;
  engine: string;
  pages: number | null;
  problems: Problem[];
  /** What each citation key was typeset as, from the .aux ("1", or natbib's label); absent in reports of older builds. */
  citations?: Record<string, string>;
  at: number;
}

export const reportPath = (job: string) => `${BUILD_FOLDER}/${job}.report.json`;

/** The report a compile task's summary or problem names, as the view finds it. */
export function reportNamedIn(text: string | null | undefined): string | null {
  return text ? (/Report: (\S+\.report\.json)/.exec(text)?.[1] ?? null) : null;
}

/** What a build says while it downloads Tectonic, before its percentage; the view shows it over the PDF. */
export const DOWNLOADING_TECTONIC = "Downloading Tectonic for the first build";
/** What a build says while Tectonic fetches the TeX packages for its first build; the view shows it over the PDF. */
export const FIRST_TECTONIC_BUILD = "Tectonic is fetching TeX packages for its first build; this takes a minute or two…";
