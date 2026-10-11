/**
 * The answer to a question the assistant asks (GRV-42) as the producer puts
 * it together: the options picked in a multi-select and the "something else"
 * text, and what the options do in the editor along the way. Hovering an
 * option shows what it is about and plays what it sounds like; picking one
 * selects what it is about; making the change an option describes, in the
 * editor, answers the question as that option. Only the producer's own edit
 * does that: not a preview, not a drag that has not let go, not a proposal
 * the assistant applied, and not a change made elsewhere.
 */
import { type Accessor, createEffect, createSignal, onCleanup, untrack } from "solid-js";
import type { AskOption } from "../../assistant/ask";
import { optionDoneByEdit, predicateHolds } from "../../assistant/askPredicates";
import type { Project } from "../../domain/entities";
import type { SessionEdit } from "../EditorSession";
import { type AskEditorLink, barsLabel } from "./askReferences";
import type { AssistantConversation } from "./useAssistantConversation";

/**
 * The answer to the pending question as it is put together. It belongs to
 * one question, so a new one starts empty.
 */
export interface AskDraft {
  /** The options picked so far, by index; only a multi-select keeps any. */
  readonly picked: Accessor<readonly number[]>;
  readonly text: Accessor<string>;
  setText(text: string): void;
  /**
   * Picks option `index`: a single choice answers at once, and one of
   * several toggles. Either way, picking selects what the option is about.
   * Returns whether anything happened.
   */
  pick(index: number): boolean;
  /** Whether {@link finish} would send now. */
  canFinish(): boolean;
  /** Sends what is picked and typed. */
  finish(): boolean;
  dismiss(): void;
  /**
   * The pointer is over option `index`, or over none: its part of the song is
   * shown and its sound plays, until the pointer leaves.
   */
  hover(index: number | null): void;
  /**
   * Option `index` has gone from under the pointer, or from the page: what it
   * showed is put away if it is still the hovered one.
   */
  unhover(index: number): void;
  /**
   * Option `index` has focus, or none does: its part of the song is shown
   * while nothing is hovered, unless `show` is false (focus a click gave it,
   * which should not outlast the pointer).
   */
  focus(index: number | null, show?: boolean): void;
  /** Option `index` has lost focus, or left the page, if it had it. */
  unfocus(index: number): void;
  /** The option with focus, if one has it. */
  focused(): number | null;
  /** Whether option `index` has a sound that can be heard now. */
  canHear(index: number): boolean;
  /** Plays option `index`'s sound: the keyboard's way to hear it (Space). */
  hear(index: number): boolean;
  /** What option `index` is about, as its chip says it, or null. */
  about(index: number): string | null;
}

export interface UseAskDraftOptions {
  readonly conversation: AssistantConversation;
  readonly project: Accessor<Project | null>;
  /** The committed project, never a preview of it: where an edit left the song. */
  readonly committedProject?: () => Project | null;
  /**
   * Hears every change the editor session commits (`EditorSession`'s
   * `subscribeEdits`): a dispatch, a finished drag, an undo or a redo, never
   * a preview or a remote change. Without it nothing is answered by doing.
   */
  readonly onEdit?: (listener: (edit: SessionEdit) => void) => () => void;
  readonly link?: AskEditorLink;
}

export function useAskDraft(options: UseAskDraftOptions): AskDraft {
  const { conversation, link } = options;
  // Kept against the question it was made for, so a new question starts
  // empty without an effect, as the scope chip's choice does.
  const [draft, setDraft] = createSignal<{
    askId: string;
    picked: readonly number[];
    text: string;
  } | null>(null);
  const current = () => {
    const pending = conversation.pendingAsk();
    const value = draft();
    if (!pending) return null;
    return value?.askId === pending.ask.id
      ? value
      : { askId: pending.ask.id, picked: [] as readonly number[], text: "" };
  };
  const answerable = () =>
    conversation.pendingAsk() !== null && !conversation.streaming();
  const option = (index: number): AskOption | undefined =>
    conversation.pendingAsk()?.ask.options[index];
  /** Plain, not a signal: only the keys ask which option has focus. */
  let focusedIndex: number | null = null;
  /** Whether the focused option shows its part of the song: not when a click gave it focus. */
  let focusShown = false;
  /** The option under the pointer. */
  let hoveredIndex: number | null = null;
  /** Which of the two last moved to an option, so it wins while both hold one. */
  let latest: "hover" | "focus" = "hover";

  /**
   * Shows the one option's part of the song that should be showing: the
   * option the pointer or focus last went to, else the one the other still
   * holds. Hover and focus are kept apart so one ending never leaves the
   * other's highlight behind, or takes away a highlight the other still holds
   * (GRV-42 QA).
   */
  function showHighlight(): void {
    const shownFocus = focusShown ? focusedIndex : null;
    const index =
      latest === "focus" ? (shownFocus ?? hoveredIndex) : (hoveredIndex ?? shownFocus);
    link?.highlight((index === null ? undefined : option(index))?.ref ?? null);
  }

  /** Puts away whatever an option is showing or playing. */
  function release(): void {
    hoveredIndex = null;
    link?.highlight(null);
    link?.stopHearing();
  }

  // A question answered, dismissed or replaced takes its highlight, its sound
  // and its focused option with it: the new question's chip at that index is
  // not the one that had focus. The question's ID is the one reactive read;
  // the editor calls are the apply half's.
  createEffect(
    () => conversation.pendingAsk()?.ask.id ?? null,
    () => {
      focusedIndex = null;
      focusShown = false;
      untrack(release);
    },
  );
  onCleanup(release);

  // Answering by doing: the option a producer's own edit has made true, held
  // against its question until it can be sent. Only an edit the producer
  // made counts (`actor` "user"): a proposal the assistant applied, or its
  // undo, is the assistant's, and a change made elsewhere is no edit here.
  // The session reports a drag once, when it lets go, and a preview never,
  // so a fader passing through the range, then let go outside it or
  // cancelled, has answered nothing.
  const [doneBy, setDoneBy] = createSignal<{ askId: string; index: number } | null>(null);
  if (options.onEdit) {
    const stopListening = options.onEdit((edit) => {
      const pending = conversation.pendingAsk();
      const now = options.committedProject?.() ?? null;
      if (edit.actor !== "user" || !pending?.asked || !now) return;
      const index = optionDoneByEdit(pending.ask, pending.asked, edit.before, now);
      if (index !== null) {
        setDoneBy({ askId: pending.ask.id, index });
        return;
      }
      // An edit that takes the change back again, before the answer could
      // go, takes the answer with it.
      const held = doneBy();
      const predicate =
        held?.askId === pending.ask.id
          ? pending.ask.options[held.index]?.doneWhen
          : undefined;
      if (held && (!predicate || !predicateHolds(predicate, pending.asked, now))) {
        setDoneBy(null);
      }
    });
    onCleanup(stopListening);
  }

  // Sent once nothing streams: an edit made while a reply is on its way
  // answers once the reply is done, if the change still stands then. Only
  // the producer's edits are heard above, so a change taken back by anything
  // else is only seen here: the option is checked again before it goes.
  createEffect(
    () => ({
      pending: conversation.pendingAsk(),
      done: doneBy(),
      streaming: conversation.streaming(),
    }),
    ({ pending, done, streaming }) => {
      if (!pending || !done || done.askId !== pending.ask.id || streaming) return;
      setDoneBy(null);
      // Answering reads the conversation it adds to: read once, knowingly,
      // since the compute half above already follows everything that should
      // bring this back.
      untrack(() => {
        const predicate = pending.ask.options[done.index]?.doneWhen;
        const now = options.committedProject?.() ?? null;
        if (!predicate || !pending.asked || !now) return;
        if (!predicateHolds(predicate, pending.asked, now)) return;
        if (conversation.answerAsk({ picked: [done.index], text: "", byDoing: true })) {
          setDraft(null);
        }
      });
    },
  );

  function finish(): boolean {
    const value = current();
    if (!value || !answerable()) return false;
    link?.stopHearing();
    const sent = conversation.answerAsk({ picked: value.picked, text: value.text });
    if (sent) setDraft(null);
    return sent;
  }

  function hover(index: number | null): void {
    hoveredIndex = index;
    if (index !== null) latest = "hover";
    showHighlight();
    const hovered = index === null ? undefined : option(index);
    if (hovered?.sound && link?.canHear(hovered.sound)) link.hear(hovered.sound);
    else link?.stopHearing();
  }

  function focus(index: number | null, show = true): void {
    focusedIndex = index;
    focusShown = index !== null && show;
    if (focusShown) latest = "focus";
    showHighlight();
    // A blur stops what Space started, unless the pointer is playing something.
    if (index === null && hoveredIndex === null) link?.stopHearing();
  }

  return {
    picked: () => current()?.picked ?? [],
    text: () => current()?.text ?? "",
    setText(text) {
      const value = current();
      if (value) setDraft({ ...value, text });
    },
    pick(index) {
      const pending = conversation.pendingAsk();
      const value = current();
      const chosen = option(index);
      if (!pending || !value || !chosen || !answerable()) return false;
      if (!pending.ask.multiSelect) {
        link?.stopHearing();
        if (chosen.ref) link?.select(chosen.ref);
        const sent = conversation.answerAsk({ picked: [index], text: value.text });
        if (sent) setDraft(null);
        return sent;
      }
      const adding = !value.picked.includes(index);
      if (adding && chosen.ref) link?.select(chosen.ref);
      const picked = adding
        ? [...value.picked, index].sort((a, b) => a - b)
        : value.picked.filter((other) => other !== index);
      setDraft({ ...value, picked });
      return true;
    },
    canFinish() {
      const value = current();
      return (
        value !== null &&
        answerable() &&
        (value.picked.length > 0 || value.text.trim().length > 0)
      );
    },
    finish,
    dismiss() {
      conversation.dismissAsk();
      setDraft(null);
    },
    hover,
    unhover(index) {
      if (hoveredIndex === index) hover(null);
    },
    focused: () => (conversation.pendingAsk() ? focusedIndex : null),
    focus,
    unfocus(index) {
      if (focusedIndex === index) focus(null);
    },
    canHear(index) {
      const sound = option(index)?.sound;
      return sound !== undefined && (link?.canHear(sound) ?? false);
    },
    about(index) {
      const ref = option(index)?.ref;
      if (!ref) return null;
      if (link) return link.describe(ref);
      return ref.kind === "bars" ? barsLabel(ref) : null;
    },
    hear(index) {
      const sound = option(index)?.sound;
      if (!sound || !link?.canHear(sound)) return false;
      link.hear(sound, true);
      return true;
    },
  };
}
