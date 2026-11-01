/**
 * What the narrator says; the edit puts each line at a moment of the footage. `bun video/lib/narrate.ts` speaks them.
 * Written to be said: contractions, short sentences, and commas where a person would breathe. "Lay-tek" and "Neo
 * Manuscript" are spelled the way they're said, so the voice doesn't read "latex" or run the name together.
 */
export const VOICE = "af_heart";
export const SPEED = 1;

export const LINES = {
  intro: "Tired of formatting tables and hunting down build errors? This is Neo Manuscript, a Lay-tek editor for papers, theses and reports.",
  visual: "You write in Visual mode, so headings and math look the way they'll print. Click into a line, and the Lay-tek is right there when you need it.",
  live: "The PDF keeps up as you type.",
  synctex: "Double-click anywhere in it, and you land on the matching source.",
  synonyms: "Looking for a better word? Select one, and you get synonyms.",
  ask: "Now, this draft is pretty rough. Notes instead of equations, raw numbers instead of a table, and it doesn't even build. So let's hand that part to Claude.",
  agent: "It edits the files directly, and you watch every change land. Numbered equations, and a proper table.",
  clean: "Then it builds, and keeps going until the errors are gone.",
  pdf: "You do the thinking. It handles the tedious parts.",
  mirador: "And if you work in Mirador, it's there too, as a plugin.",
  end: "Neo Manuscript. Free, open source, and made for the Mac.",
} as const;

export type LineName = keyof typeof LINES;
