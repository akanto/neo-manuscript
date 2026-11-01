import { Annotation, ChangeSet, Transaction, type ChangeSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { ANCHOR_LENGTH, type TextChange } from "../core/ops.ts";
import type { Author, DocumentState } from "../core/host-api.ts";
import { hunksBetween } from "../core/diff.ts";
import type { TexDocument } from "../core/document.ts";

/** Marks the editor's transactions that bring in a change made elsewhere, so they aren't sent back. */
export const fromHost = Annotation.define<boolean>();

/** How long typing waits before it is sent, and how long a sent edit waits for the host to show it back. */
const SEND_AFTER_MS = 350;
const ANSWER_WITHIN_MS = 4000;

const changeSetBetween = (before: string, after: string) =>
  ChangeSet.of(hunksBetween(before, after).map(({ from, to, insert }): ChangeSpec => ({ from, to, insert })), before.length);

/**
 * Keeps the editor and the host's document the same text. The user's typing goes out as `edit` operations, a few at a
 * time and one in flight at once; a change from the agent (or from outside, or the host's undo) comes in as a new state,
 * and is merged into the editor around whatever the user typed meanwhile, so no keystroke and no change is lost.
 *
 * `shadow` is the text the host has once the edit in flight lands: what the user's next edit is made on, and what a new
 * state is compared with to find what changed elsewhere.
 */
export class DocumentSync {
  private shadow: string;
  private inFlight: { target: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private latest: DocumentState<TexDocument> | null = null;
  onRemote: (ranges: { from: number; to: number }[], author: Author | null) => void = () => {};
  /** Called whenever the editor and the host come to hold the same text. */
  onSettled: () => void = () => {};

  constructor(private view: EditorView, private apply: (operation: unknown) => void, initial: string) {
    this.shadow = initial;
  }

  get settled() {
    return this.inFlight === null && this.sendTimer === null && this.view.state.doc.toString() === this.shadow;
  }

  /** The user changed the text in the editor. */
  typed() {
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      this.send();
    }, SEND_AFTER_MS);
  }

  /** Sends what the user typed now, as before a build. */
  flush() {
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = null;
    this.send();
  }

  private send() {
    if (this.inFlight) return;
    const text = this.view.state.doc.toString();
    if (text === this.shadow) {
      this.onSettled();
      return;
    }
    const base = this.shadow;
    const changes: TextChange[] = hunksBetween(base, text).map(({ from, to, insert }) => ({
      from,
      to,
      insert,
      expect: base.slice(from, to),
      prefix: base.slice(Math.max(0, from - ANCHOR_LENGTH), from),
      suffix: base.slice(to, to + ANCHOR_LENGTH),
    }));
    this.apply({ op: "edit", changes });
    this.shadow = text;
    this.inFlight = { target: text, timer: setTimeout(() => this.answered(), ANSWER_WITHIN_MS) };
  }

  /** A new state from the host. */
  received(state: DocumentState<TexDocument>) {
    this.latest = state;
    if (this.inFlight) {
      // The user's edit lands as a change by "you"; a change by someone else before it is merged once it lands.
      if (state.lastChange?.author.kind === "you" || state.document.text === this.inFlight.target) this.answered();
      return;
    }
    this.merge(state);
  }

  /** The edit in flight landed, or failed, or its state came merged with another one: catch up with the latest state. */
  private answered() {
    if (this.inFlight) clearTimeout(this.inFlight.timer);
    this.inFlight = null;
    if (this.latest) this.merge(this.latest);
    if (this.view.state.doc.toString() !== this.shadow && !this.sendTimer) this.send();
    else if (this.settled) this.onSettled();
  }

  private merge(state: DocumentState<TexDocument>) {
    const next = state.document.text;
    if (next === this.shadow) {
      if (this.settled) this.onSettled();
      return;
    }
    const remote = changeSetBetween(this.shadow, next);
    const local = changeSetBetween(this.shadow, this.view.state.doc.toString());
    const mapped = remote.map(local);
    this.shadow = next;
    const ranges: { from: number; to: number }[] = [];
    mapped.iterChanges((_fromA, _toA, fromB, toB) => ranges.push({ from: fromB, to: toB }));
    this.view.dispatch({ changes: mapped, annotations: [fromHost.of(true), Transaction.addToHistory.of(false)] });
    this.onRemote(ranges, state.lastChange?.author ?? null);
    if (this.settled) this.onSettled();
    else if (!this.sendTimer) this.send();
  }
}
