/**
 * The assistant's recommended packs (GRV-23): one card per recommendation a
 * reply makes, and what Try, Keep, Put back, Undo, Pack demo and Open in
 * library do to it. A recommendation is a proposal like any other (GRV-5):
 *
 * - **Try on ‹slot›** plays the first suggested sound through the slot, the
 *   library's hot-swap: an audio-only override with no command, no undo entry
 *   and no save. The editor goes to the view that shows the slot, which gets
 *   the dashed outline, and focus stays on the card.
 * - **Keep** inserts that sound through the library's own insertion, so a pack
 *   the project did not use becomes one of its packs exactly as an Insert in
 *   the library makes it: one transaction, one undo entry. The slot is
 *   outlined as changed until the next edit, and the card offers Undo.
 * - **Put back** drops the override and goes back to where the editor was.
 *   Going to the Library puts the sound back too: the Library plays its own
 *   sounds through the slot.
 * - Editing the slot while a sound is being tried, or a change made
 *   elsewhere, puts the sound back and makes the card **stale**: it can ask
 *   again (Refresh) or be dismissed.
 *
 * A recommendation naming a pack or a sound the library does not hold is
 * refused and shown as a failed reply, never as a card.
 *
 * Analytics: `assistant_recommendation_*`, with whether the pack was the
 * project's already and, for a decision, how long it took. Never a pack's or a
 * sound's name, nor what the producer asked.
 */
import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import type { Analytics } from "../../analytics/analytics";
import { bucketOf } from "../../analytics/buckets";
import type {
  AssistantLibraryContext,
  AssistantToolCall,
} from "../../assistant/protocol";
import {
  type RecommendationIssueCode,
  validateRecommendation,
} from "../../assistant/recommendation";
import {
  type ControlAddress,
  controlKey,
  uniqueControls,
} from "../../commands/controlAddress";
import { controlsTouchedBy } from "../../commands/controls";
import type { ControlMark } from "../../controls/registry";
import type { Project } from "../../domain/entities";
import { AuditionController, type PreviewEngine } from "../../library/audition";
import type { LibraryAsset } from "../../library/manifest";
import { HEAR_STEP_MS } from "../../library/PacksView";
import { heardSounds } from "../../library/packCatalog";
import type { PreviewSlot } from "../../projection/previewOverride";
import { type Clock, systemClock } from "../../shared/clock";
import type { SessionEdit } from "../EditorSession";
import type { EditorControls, EditorLocation } from "../editorControls";
import type { EditorViewName } from "../editorViews";
import type { LibraryInsertOutcome } from "../libraryInsert";
import { type AssistantLibrary, projectHasPack } from "./assistantLibrary";
import {
  type RecommendationSlot,
  type ResolvedRecommendation,
  resolveRecommendation,
  slotExists,
  soundToTry,
} from "./recommendationCardModel";
import type { TurnOrigin } from "./useAssistantConversation";
import type { ProposalSessionPort } from "./useAssistantProposals";

/**
 * - `ready`: shown, nothing tried or changed.
 * - `trying`: a sound plays through the slot, unsaved.
 * - `kept`: the sound is in the slot, as one undo step.
 * - `undone`: kept, then undone.
 * - `put-back`: tried, then put back; nothing changed.
 * - `stale`: the slot changed while a sound was tried, so it was put back.
 * - `dismissed`: stale, and turned down.
 * - `invalid`: it named something the library does not hold.
 */
export type RecommendationStatus =
  | "ready"
  | "trying"
  | "kept"
  | "undone"
  | "put-back"
  | "stale"
  | "dismissed"
  | "invalid";

/** Everything one card shows. */
export interface RecommendationCard {
  readonly status: RecommendationStatus;
  /** What the producer asked for. */
  readonly title: string;
  readonly scopeLabel: string;
  /** The pack and sounds, as the library holds them; null when it was refused. */
  readonly recommendation: ResolvedRecommendation | null;
  /**
   * Where Try plays a sound, or null when there is no slot to try one in. A
   * recommendation that arrived with none follows the editor: selecting a
   * drum pad or a sampler afterwards gives it one.
   */
  readonly slot: RecommendationSlot | null;
  /** The sound Try plays: the first suggested one-shot. */
  readonly sound: LibraryAsset | null;
  /** While trying, the view Put back returns to. */
  readonly returnView: EditorViewName | null;
  /** Whether Refresh has already asked again for this one. */
  readonly refreshed: boolean;
  /** Keep is on its way: the library is checking the pack. */
  readonly keeping: boolean;
  /** A one-off note after an action could not be done. */
  readonly notice: string | null;
  /**
   * Why a stale card is out of date: the slot changed while a sound was tried
   * (`edited`), or Try found the slot gone before anything was tried
   * (`missing`). Null for a card that is not stale.
   */
  readonly staleBecause: "edited" | "missing" | null;
}

/** What the cards need from the editor around them. */
export interface RecommendationEditorPort {
  /** The slot a recommendation for `trackId` (and `padId`) tries its sound in. */
  slotFor(trackId: string | null, padId: string | null): RecommendationSlot | null;
  /** The library's hot-swap: an audio-only override of the slot's sound. */
  previewInSlot(slot: PreviewSlot, sound: LibraryAsset): boolean;
  clearPreview(): void;
  /** The library's Insert into the slot, through its pack-upgrade check. */
  keep(
    target: RecommendationSlot["target"],
    sound: LibraryAsset,
  ): Promise<LibraryInsertOutcome>;
  /** Goes to the Library, scoped to the pack, aimed at the slot when there is one. */
  openLibrary(packSlug: string, slot: RecommendationSlot | null): void;
  /** An engine for hearing a sound on its own and the pack demo. */
  createAuditionEngine(): PreviewEngine;
}

export interface UseAssistantRecommendationsOptions {
  readonly session: Pick<
    ProposalSessionPort,
    "proposalTarget" | "onEdit" | "onRemoteChange"
  >;
  readonly controls: Pick<EditorControls, "registry" | "revealControl" | "restoreView">;
  readonly project: Accessor<Project | null>;
  /**
   * The editor's view. Going to the Library by hand ends a try: the Library
   * plays its own sounds through the slot, which replaces the override.
   */
  readonly view?: Accessor<EditorViewName>;
  /** The library each turn was sent with, as the app holds it. */
  readonly library: AssistantLibrary;
  readonly editor: RecommendationEditorPort;
  readonly analytics: () => Analytics;
  /** Asks again, in the same scope, for the recommendation in this entry. */
  refresh(entryId: string): boolean;
  readonly clock?: Clock;
}

export interface AssistantRecommendations {
  /** The card for a conversation entry. Reactive. */
  card(entryId: string): RecommendationCard | undefined;
  /** Whether a sound is being tried, for the panel's status. Reactive. */
  readonly trying: Accessor<boolean>;
  /** Whether a card's pack is one of the project's now. Reactive. */
  packInProject(entryId: string): boolean;
  /** A recommendation arrived in a reply: check it against `library` and show it. */
  receive(
    entryId: string,
    call: AssistantToolCall,
    library: AssistantLibraryContext | null,
    origin: TurnOrigin,
  ): void;
  tryOn(entryId: string): void;
  keep(entryId: string): Promise<void>;
  putBack(entryId: string): void;
  undo(entryId: string): void;
  refresh(entryId: string): void;
  dismiss(entryId: string): void;
  /** Plays one suggested sound on its own. */
  hear(entryId: string, soundId: string): void;
  /** Plays a run of the pack's sounds, or stops it. */
  toggleDemo(entryId: string): void;
  /** Which card's pack demo is playing, if any. Reactive. */
  readonly demoing: Accessor<string | null>;
  openInLibrary(entryId: string): void;
}

/** What a card keeps beside what it shows. */
interface Entry {
  /** Where the editor was when the try began. */
  location: EditorLocation | null;
  /** The keep's history entry, so its undo and redo can be followed. */
  keptId: string | null;
  /** Keep is on its way: the insert's own edit is not an edit to the slot. */
  keeping: boolean;
  mark: ControlMark;
  /** When the try began, for how long the decision took. */
  triedAt: number;
}

const CANNOT_UNDO =
  "Something else changed after it, so undo it from the header's Undo instead.";
const BUSY = "Finish the change you're making first, then try again.";

/** What Keep says when the library would not insert the sound. */
function keepNotice(outcome: LibraryInsertOutcome, slot: string): string | null {
  if (outcome.ok) return null;
  if ("reason" in outcome) return outcome.reason;
  return `Keeping it moves ${outcome.upgrade.packName} to version ${outcome.upgrade.version}, which would leave sounds in your song missing. Open it in the library to decide, or put ${slot}'s own sound back.`;
}

export function useAssistantRecommendations(
  options: UseAssistantRecommendationsOptions,
): AssistantRecommendations {
  const { session, controls, editor } = options;
  const clock = options.clock ?? systemClock;
  const [cards, setCards] = createSignal<ReadonlyMap<string, RecommendationCard>>(
    new Map(),
  );
  const [demoing, setDemoing] = createSignal<string | null>(null);
  const entries = new Map<string, Entry>();

  const update = (entryId: string, change: Partial<RecommendationCard>) =>
    setCards((current) => {
      const card = current.get(entryId);
      if (!card) return current;
      const next = new Map(current);
      next.set(entryId, { ...card, notice: null, ...change });
      return next;
    });
  const show = (entryId: string, card: RecommendationCard) =>
    setCards((current) => new Map(current).set(entryId, card));

  /**
   * The card's slot: the one it was given, or, when it arrived with none,
   * wherever the editor would aim it now. Reactive through `editor.slotFor`.
   */
  function slotOf(card: RecommendationCard): RecommendationSlot | null {
    if (card.slot || !card.recommendation) return card.slot;
    return editor.slotFor(card.recommendation.trackId, card.recommendation.padId);
  }
  /** The card as shown: with the slot it would try on now. */
  function asShown(card: RecommendationCard | undefined): RecommendationCard | undefined {
    if (!card || card.slot || !card.recommendation) return card;
    const slot = slotOf(card);
    return slot ? { ...card, slot } : card;
  }

  // Hearing a sound and the pack demo share one engine, made on first use.
  // The controller disposes the engine with itself.
  let audition: AuditionController | null = null;
  let demoTimer: ReturnType<typeof setTimeout> | undefined;
  const auditioner = (): AuditionController => {
    audition ??= new AuditionController(editor.createAuditionEngine());
    return audition;
  };

  function packInProjectNow(card: RecommendationCard | undefined): boolean {
    const project = options.project();
    const packId = card?.recommendation?.pack.id;
    return project !== null && packId !== undefined && projectHasPack(project, packId);
  }

  function setMark(entryId: string, mark: ControlMark): void {
    const entry = entries.get(entryId);
    const slot = cards().get(entryId)?.slot;
    if (!entry || !slot) return;
    entry.mark = mark;
    controls.registry.setMark(slot.address, mark);
  }

  function refuse(
    entryId: string,
    base: Omit<RecommendationCard, "status">,
    reason: RecommendationIssueCode,
  ): void {
    entries.set(entryId, blankEntry(clock.now()));
    show(entryId, { ...base, status: "invalid" });
    options.analytics().log("assistant_recommendation_refused", { reason });
  }

  function receive(
    entryId: string,
    call: AssistantToolCall,
    library: AssistantLibraryContext | null,
    origin: TurnOrigin,
  ): void {
    const base: Omit<RecommendationCard, "status"> = {
      title: origin.text,
      scopeLabel: origin.scope.label,
      recommendation: null,
      slot: null,
      sound: null,
      returnView: null,
      refreshed: false,
      keeping: false,
      notice: null,
      staleBecause: null,
    };
    // Only a turn that carried the library is offered the tool at all.
    if (!library) {
      refuse(entryId, base, "malformed");
      return;
    }
    const validation = validateRecommendation(call.input, library);
    if (!validation.ok) {
      refuse(entryId, base, validation.code);
      return;
    }
    const catalog = options.library.current();
    const resolved = catalog
      ? resolveRecommendation(validation.recommendation, catalog)
      : null;
    if (!resolved) {
      refuse(entryId, base, "unknown_sound");
      return;
    }
    entries.set(entryId, blankEntry(clock.now()));
    const card: RecommendationCard = {
      ...base,
      status: "ready",
      recommendation: resolved,
      slot: editor.slotFor(resolved.trackId, resolved.padId),
      sound: soundToTry(resolved.sounds),
    };
    show(entryId, card);
    options.analytics().log("assistant_recommendation_shown", {
      pack_in_project: packInProjectNow(card),
      sound_count: resolved.sounds.length,
    });
  }

  /** Ends a card's try: the slot's own sound comes back and its outline goes. */
  function endTry(entryId: string): void {
    const entry = entries.get(entryId);
    if (!entry) return;
    editor.clearPreview();
    setMark(entryId, "none");
  }

  function decisionSeconds(entry: Entry) {
    return bucketOf("elapsed_seconds", (clock.now() - entry.triedAt) / 1000);
  }

  function tryOn(entryId: string): void {
    const card = cards().get(entryId);
    const entry = entries.get(entryId);
    if (!card || !entry || !card.sound) return;
    if (
      card.status !== "ready" &&
      card.status !== "put-back" &&
      card.status !== "undone"
    ) {
      return;
    }
    const slot = slotOf(card);
    if (!slot) return;
    const project = options.project();
    if (!project || !slotExists(project, slot)) {
      update(entryId, { status: "stale", staleBecause: "missing" });
      return;
    }
    // A card that arrived with no slot keeps the one it was first tried on.
    if (!card.slot) update(entryId, { slot });
    stopDemo();
    // One try at a time: another card's ends, and the place it came from is
    // where this one's Put back returns to.
    let location: EditorLocation | null = null;
    for (const [otherId, other] of entries) {
      if (otherId === entryId || cards().get(otherId)?.status !== "trying") continue;
      location = other.location;
      other.location = null;
      endTry(otherId);
      update(otherId, { status: "put-back", returnView: null });
    }
    if (!editor.previewInSlot(slot.preview, card.sound)) {
      update(entryId, {
        notice: `${card.sound.name} can't play through ${slot.label}.`,
      });
      return;
    }
    setMark(entryId, "previewed");
    const from = controls.revealControl(slot.address, { focus: false });
    entry.location = location ?? from;
    entry.triedAt = clock.now();
    update(entryId, { status: "trying", returnView: entry.location?.view ?? null });
    const analytics = options.analytics();
    analytics.log("assistant_recommendation_tried", {
      pack_in_project: packInProjectNow(card),
    });
    analytics.logFeatureFirstUse("assistant_recommendation");
  }

  function putBack(entryId: string): void {
    const card = cards().get(entryId);
    const entry = entries.get(entryId);
    if (!card || !entry || card.status !== "trying" || card.keeping) return;
    const location = entry.location;
    entry.location = null;
    endTry(entryId);
    if (location) controls.restoreView(location);
    update(entryId, { status: "put-back", returnView: null });
    options.analytics().log("assistant_recommendation_put_back", {
      pack_in_project: packInProjectNow(card),
      seconds_to_decision_bucket: decisionSeconds(entry),
    });
  }

  async function keep(entryId: string): Promise<void> {
    const card = cards().get(entryId);
    const entry = entries.get(entryId);
    if (!card || !entry || card.status !== "trying" || card.keeping) return;
    if (!card.slot || !card.sound) return;
    // Read before the insert makes it one of the project's.
    const packInProject = packInProjectNow(card);
    entry.keeping = true;
    update(entryId, { keeping: true });
    let outcome: LibraryInsertOutcome;
    try {
      outcome = await editor.keep(card.slot.target, card.sound);
    } catch {
      outcome = { ok: false, reason: `Couldn't keep ${card.sound.name}.` };
    }
    entry.keeping = false;
    if (!outcome.ok) {
      update(entryId, {
        keeping: false,
        notice: keepNotice(outcome, card.slot.label),
      });
      return;
    }
    editor.clearPreview();
    entry.keptId = session.proposalTarget()?.latestCorrelationId ?? null;
    entry.location = null;
    setMark(entryId, "changed");
    update(entryId, { status: "kept", keeping: false, returnView: null });
    options.analytics().log("assistant_recommendation_kept", {
      pack_in_project: packInProject,
      seconds_to_decision_bucket: decisionSeconds(entry),
    });
  }

  function undo(entryId: string): void {
    const entry = entries.get(entryId);
    if (!entry || cards().get(entryId)?.status !== "kept") return;
    const target = session.proposalTarget();
    if (!target || !entry.keptId || target.latestCorrelationId !== entry.keptId) {
      update(entryId, { notice: CANNOT_UNDO });
      return;
    }
    if (target.gestureActive) {
      update(entryId, { notice: BUSY });
      return;
    }
    // The session reports the undo, and that is what turns the card (below).
    target.undo();
  }

  function refresh(entryId: string): void {
    const card = cards().get(entryId);
    if (card?.status !== "stale" || card.refreshed) return;
    if (options.refresh(entryId)) update(entryId, { refreshed: true });
  }

  function dismiss(entryId: string): void {
    if (cards().get(entryId)?.status !== "stale") return;
    update(entryId, { status: "dismissed" });
  }

  function stopDemo(): void {
    clearTimeout(demoTimer);
    if (demoing() !== null) {
      audition?.stop();
      setDemoing(null);
    }
  }

  function hear(entryId: string, soundId: string): void {
    const sound = cards()
      .get(entryId)
      ?.recommendation?.sounds.find((candidate) => candidate.id === soundId);
    if (!sound) return;
    stopDemo();
    void auditioner().play(sound);
  }

  function toggleDemo(entryId: string): void {
    const recommendation = cards().get(entryId)?.recommendation;
    const wasPlaying = demoing() === entryId;
    stopDemo();
    if (wasPlaying || !recommendation) return;
    const run = heardSounds(recommendation.packSounds);
    if (run.length === 0) return;
    setDemoing(entryId);
    const step = (index: number): void => {
      const sound = run[index];
      if (!sound) {
        stopDemo();
        return;
      }
      void auditioner().play(sound);
      demoTimer = setTimeout(() => step(index + 1), HEAR_STEP_MS);
    };
    step(0);
  }

  function openInLibrary(entryId: string): void {
    const card = cards().get(entryId);
    if (!card?.recommendation) return;
    stopDemo();
    audition?.stop();
    // The library plays its own sounds through the slot: a try ends first.
    if (card.status === "trying" && !card.keeping) {
      const entry = entries.get(entryId);
      if (entry) entry.location = null;
      endTry(entryId);
      update(entryId, { status: "put-back", returnView: null });
    }
    editor.openLibrary(card.recommendation.pack.slug, slotOf(card));
  }

  /** Whether an edit changed what a slot holds, or took the slot away. */
  function editHitsSlot(edit: SessionEdit, slot: RecommendationSlot): boolean {
    const after = session.proposalTarget()?.project;
    if (after && !slotExists(after, slot)) return true;
    const key = controlKey(slot.address);
    return touchedBy(edit).some((address) => controlKey(address) === key);
  }

  function onEdit(edit: SessionEdit): void {
    for (const [entryId, entry] of entries) {
      const card = cards().get(entryId);
      if (!card || entry.keeping) continue;
      const ownHistory =
        entry.keptId !== null &&
        edit.correlationId === entry.keptId &&
        (edit.kind === "undo" || edit.kind === "redo");
      // Any edit after the keep ends its solid outline, its own undo included.
      if (entry.mark === "changed") setMark(entryId, "none");
      if (ownHistory) {
        // A redo of the keep while the sound is tried again: the keep is back
        // in the song, so the try ends rather than playing over it.
        if (card.status === "trying") {
          entry.location = null;
          endTry(entryId);
        }
        update(entryId, {
          status: edit.kind === "undo" ? "undone" : "kept",
          returnView: null,
        });
        continue;
      }
      if (card.status === "trying" && card.slot && editHitsSlot(edit, card.slot)) {
        goStale(entryId);
      }
    }
  }

  /** The song moved under a try: the sound goes back and the card goes stale. */
  function goStale(entryId: string): void {
    const entry = entries.get(entryId);
    if (entry) entry.location = null;
    endTry(entryId);
    update(entryId, { status: "stale", staleBecause: "edited", returnView: null });
  }

  /**
   * The editor went to the Library while a sound was tried: the Library's own
   * auditions play through the slot and its close clears the override, so the
   * try is put back here rather than left claiming a sound the slot no longer
   * plays. Its Open in library does the same before it goes.
   */
  function leaveForLibrary(): void {
    for (const [entryId, entry] of entries) {
      if (cards().get(entryId)?.status !== "trying" || entry.keeping) continue;
      entry.location = null;
      endTry(entryId);
      update(entryId, { status: "put-back", returnView: null });
    }
  }

  function onRemoteChange(): void {
    for (const [entryId, entry] of entries) {
      if (cards().get(entryId)?.status === "trying" && !entry.keeping) goStale(entryId);
    }
  }

  const view = options.view;
  if (view) {
    createEffect(
      () => view(),
      (current) => {
        if (current === "library") leaveForLibrary();
      },
    );
  }
  onCleanup(session.onEdit(onEdit));
  onCleanup(session.onRemoteChange(onRemoteChange));
  onCleanup(() => {
    stopDemo();
    if ([...cards().values()].some((card) => card.status === "trying")) {
      editor.clearPreview();
    }
    void audition?.dispose();
  });

  return {
    card: (entryId) => asShown(cards().get(entryId)),
    trying: () => [...cards().values()].some((card) => card.status === "trying"),
    packInProject: (entryId) => packInProjectNow(cards().get(entryId)),
    receive,
    tryOn,
    keep,
    putBack,
    undo,
    refresh,
    dismiss,
    hear,
    toggleDemo,
    demoing,
    openInLibrary,
  };
}

function blankEntry(now: number): Entry {
  return {
    location: null,
    keptId: null,
    keeping: false,
    mark: "none",
    triedAt: now,
  };
}

/**
 * The controls a committed edit changed, read against the project it applied
 * to. Its commands were committed, so every one is registered and valid.
 */
function touchedBy(edit: SessionEdit): ControlAddress[] {
  return uniqueControls(
    edit.commands.flatMap((command) => controlsTouchedBy(command, edit.before)),
  );
}
