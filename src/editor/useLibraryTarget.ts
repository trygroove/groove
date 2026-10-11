import { type Accessor, createMemo, createSignal } from "solid-js";
import type { Analytics } from "../analytics/analytics";
import type { Project } from "../domain/entities";
import { createFactoryContext } from "../domain/factories";
import type { PadId, TrackId } from "../domain/ids";
import type { SampleSlotId } from "../instrument/sampleSlotTargeting";
import type { LibrarySample } from "../library/assetDrag";
import {
  addPadWithSampleCommands,
  insertLoopCommands,
  loadPadSampleCommands,
  loadSampleCommands,
  replaceLoopCommands,
} from "../library/insertion";
import type { LibraryClient } from "../library/libraryClient";
import type { LibraryAsset } from "../library/manifest";
import type { HeldPackRefs } from "../library/packUpgrade";
import type { SlotAudition } from "../library/slotAudition";
import * as model from "./editorViewModel";
import type { EditorViewName, ViewChangeSource } from "./editorViews";
import type { LibraryActions } from "./LibraryModal";
import {
  dropFromLibrary,
  insertFromLibrary,
  type LibraryInsertHost,
  type LibraryInsertOptions,
  type LibraryInsertOutcome,
} from "./libraryInsert";
import { type LibraryAim, type LibraryTarget, libraryAim } from "./libraryTarget";
import { selectedPadOf } from "./padSelection";
import type { EditorNavigation } from "./useEditorNavigation";
import type { UseEditorSessionResult } from "./useEditorSession";
import type { ProjectAudioControls } from "./useProjectAudio";
import type { TrackSelection } from "./useTrackSelection";

export interface UseLibraryTargetOptions {
  readonly project: Accessor<Project | null>;
  /** The view on screen, which comes from the URL (`UI-001`). */
  readonly view: Accessor<EditorViewName>;
  readonly session: Pick<UseEditorSessionResult, "dispatch">;
  readonly analytics: Accessor<Analytics>;
  readonly selection: Pick<
    TrackSelection,
    "track" | "drumTrack" | "padSelection" | "selectTrack" | "selectPad"
  >;
  readonly navigation: EditorNavigation;
  readonly audio: Pick<
    ProjectAudioControls,
    "previewInSlot" | "clearPreview" | "isPlaying"
  >;
  /** The one shared library client, so the Library view and the pack-upgrade
   * check (#892) share its cached index and manifests. */
  readonly client: LibraryClient;
  /** The producer's own packs as held (#282): a newer version of one's own
   * pack is checked against the pack itself. */
  readonly heldPacks?: HeldPackRefs;
}

/** What `aim` can aim the Library at besides the selected track's slot. */
export type NewLibraryAim = "new-track" | "new-pad";

export interface LibraryTargeting {
  /** Where the Library is aimed, or why it is aimed nowhere. */
  readonly aimed: Accessor<LibraryAim>;
  /** Where an insert goes, or null when there is nowhere. */
  readonly target: Accessor<LibraryTarget | null>;
  /** The Library view is on screen with somewhere to insert. */
  isOpen(): boolean;
  /** Whether the Library is aimed at a sample slot (`UI-002`). */
  isTarget(slot: SampleSlotId): boolean;
  /**
   * Aims the Library and goes to `4`: at the selected track's slot, or at a
   * new track or a new pad when one was asked for.
   */
  aim(via: ViewChangeSource, aim?: NewLibraryAim): void;
  /**
   * Ends an aim at a new track or a new pad, so the selected track's slot is
   * aimed again.
   */
  endNewAim(): void;
  /** Goes back from a committed insert to where it belongs. */
  returnFromInsert(via: ViewChangeSource): void;
  /**
   * Goes to the Library scoped to one pack, by slug: the assistant's "Open in
   * library" (GRV-23). The selected track's slot stays the target.
   */
  openPack(slug: string, via: ViewChangeSource): void;
  /** The pack the Library is asked to open on, until it has. */
  readonly requestedPack: Accessor<string | null>;
  /** The Library opened the requested pack. */
  packOpened(): void;
  /** The slot the Library auditions through, if its target has one. */
  slotAudition(): SlotAudition | undefined;
  /** The Library's Insert into `target`, through the pack-upgrade check. */
  insert(
    target: LibraryTarget,
    asset: LibraryAsset,
    options: LibraryInsertOptions,
  ): Promise<LibraryInsertOutcome>;
  /** A drop on the instrument panel, which always loads the selected sampler. */
  drop(sample: LibrarySample): Promise<boolean>;
  /** The project's packs: its derived dependencies and its shelf. */
  readonly addedPackIds: Accessor<readonly string[]>;
  /** The open library modal's actions (`LIB-010`), or null while it is closed. */
  readonly actions: Accessor<LibraryActions | null>;
  /** Registered by the open library modal; the `library` shortcuts run them. */
  registerActions(actions: LibraryActions | null): void;
}

/**
 * Where the Library is aimed and what inserting from it does (`UI-002`,
 * LIB-010): the selected track's slot (its selected pad, on a drum machine),
 * or a new track, and the one transaction each insert dispatches.
 */
export function useLibraryTarget(options: UseLibraryTargetOptions): LibraryTargeting {
  const { project, session, selection, navigation, audio } = options;

  // The arrangement's "add a loop" aims the Library at a new track (`UI-002`).
  // Every other aim is the selected track's own slot (`libraryTarget`), so
  // choosing a track or touching a slot ends this one.
  const [newTrackAim, setNewTrackAim] = createSignal(false);
  // The Sequence view's [+ Pad] row aims it at a pad the drum machine does not
  // have yet (#947); inserting adds it, which selects it and ends this aim.
  const [newPadAim, setNewPadAim] = createSignal(false);
  /**
   * Where a committed insert goes back to (`UI-002`): the instrument, where the
   * slot just filled shows its new sound. A loop inserted on a new track goes
   * back to where it was asked for instead, the arrangement it now sits in,
   * and so does a new pad, to the Sequence view whose [+ Pad] row asked (#947).
   * That reads the target the insert was aimed at: the insert itself selects
   * the new track, which re-aims the Library before going back runs.
   */
  let insertedInto: LibraryTarget | null = null;
  const returnFromInsert = (via: ViewChangeSource) =>
    navigation.selectView(
      AIMS_BACK.has((insertedInto ?? libraryTargetOf())?.kind)
        ? navigation.libraryReturn()
        : "instrument",
      via,
    );
  // Registered by the open library modal; the `library` shortcuts run them.
  const [libraryActions, setLibraryActions] = createSignal<LibraryActions | null>(null);
  // A pack the Library is asked to open on (GRV-23), until it has.
  const [requestedPack, setRequestedPack] = createSignal<string | null>(null);

  // The project's packs: its derived dependencies and its shelf. Nothing in the
  // library window adds a pack for the session any more; inserting does.
  const addedPackIds = createMemo(() => model.addedPackIds(project(), []));

  // Where the Library is aimed (`UI-002`): the selected track's slot (its
  // selected pad, on a drum machine), or a new track, or why there is none.
  const libraryAimed = createMemo(() =>
    libraryAim(
      selection.track() ?? null,
      selectedPadOf(selection.padSelection(), selection.drumTrack() ?? null),
      newTrackAim(),
      newPadAim(),
    ),
  );
  const libraryTargetOf = createMemo(() => {
    const aim = libraryAimed();
    return aim.kind === "target" ? aim.target : null;
  });

  /**
   * Aims the Library and goes to `4` (`UI-002`): at the selected track's slot,
   * or at a new track or a new pad when one was asked for.
   */
  function aimLibrary(via: ViewChangeSource, aim?: NewLibraryAim): void {
    setNewTrackAim(aim === "new-track");
    setNewPadAim(aim === "new-pad");
    navigation.selectView("library", via);
  }

  /**
   * The slot the Library auditions through (LIB-010 hot-swap): its target's
   * pad or sampler. A loop or a new track fills no instrument, so loops
   * audition standalone, on the bar.
   */
  function slotAudition(): SlotAudition | undefined {
    const target = libraryTargetOf();
    const slot =
      target?.kind === "pad"
        ? { trackId: target.trackId, padId: target.padId }
        : target?.kind === "sampler"
          ? { trackId: target.trackId }
          : null;
    if (!slot) return undefined;
    return {
      preview: (asset) => audio.previewInSlot(slot, asset, LIBRARY_PREVIEW),
      // Only the Library's own override: leaving the Library for an
      // assistant's Try (GRV-23) must not clear the sound that Try put there.
      clear: () => audio.clearPreview(LIBRARY_PREVIEW),
      isPlaying: () => audio.isPlaying(),
    };
  }

  /**
   * Inserts into the Library's target (`UI-002`): one transaction, so one
   * revision and one undo. A loop inserted on a new track selects that track,
   * so the next loop tried replaces it rather than adding another.
   */
  function insertIntoTarget(sample: LibrarySample, target: LibraryTarget): string | null {
    if (target.kind === "pad") return loadPadSample(sample, target);
    if (target.kind === "new-pad") return addPadWithSample(sample, target.trackId);
    if (target.kind === "loop") return replaceLoop(sample, target.trackId);
    if (target.kind === "new-track" && sample.kind !== "loop") {
      return `Couldn't insert ${sample.name}: only a loop can start a new loop track.`;
    }
    if (target.kind === "sampler" && sample.kind === "loop") {
      return `Couldn't insert ${sample.name}: a loop can't go on a sampler.`;
    }
    // A loop's insert selects the track it created (#879). Reading
    // `project()` here for "the last track" would see the project from before
    // the insert, not yet flushed, and select the wrong track.
    return loadLibrarySample(sample);
  }

  /**
   * Puts a library sound into the project — the one path the drag onto the
   * instrument panel and the browser's "Insert" button both take, so the
   * pointer gesture and its keyboard equivalent produce the same transaction
   * (PRD 9.3) and log the same event once (#225).
   *
   * **The asset's kind chooses what inserting means.** A one-shot loads onto
   * the sampler of the track the editor is pointed at; a loop has no
   * instrument to load onto, so it arrives as its own audio track carrying an
   * `audioLoop` clip at bar 1 (`LOOP-019`), and that new track is selected.
   * Either way it is one transaction, so it is one revision and one undo.
   *
   * Both paths can decline, and a decline has to be visible: the Loop button
   * used to reach a sampler-only path that returned silently, so inserting a
   * loop closed the window and did nothing at all. Each of these returns
   * `null` when it landed, else the sentence the library's footer shows
   * (#892), and only a committed insert goes back on Enter.
   */
  function loadLibrarySample(sample: LibrarySample): string | null {
    const currentProject = project();
    if (!currentProject) return notOpen(sample);
    const analytics = options.analytics();

    if (sample.kind === "loop") {
      const insert = insertLoopCommands(currentProject, sample, createFactoryContext(), {
        order: currentProject.song.tracks.length,
        existingNames: currentProject.song.tracks.map((entry) => entry.name),
        songTempo: currentProject.song.tempo,
      });
      const result = session.dispatch(insert.commands);
      if (!result?.ok) return refusedBy(sample);
      // A track you just added is the one you want to see, as with every other
      // added track (#879). Selection is UI state, so the insert stays one
      // transaction; the view does not change.
      selection.selectTrack(insert.trackId);
      // No `instrument_type`: an audio track carries no instrument, which is
      // the case the catalog leaves that param optional for.
      analytics.log("track_added", { track_type: "audio" });
      analytics.logFeatureFirstUse("audio_loop");
      return null;
    }

    // The track the editor is pointed at (#228), not the project's first —
    // so a drop lands on whichever track the user selected.
    const trackId = model.samplerTrackId(selection.track());
    if (!trackId) {
      return `Couldn't insert ${sample.name}: the selected track has no sampler to load it on.`;
    }
    const result = session.dispatch(
      loadSampleCommands(currentProject, trackId, sample, createFactoryContext()),
    );
    if (!result?.ok) return refusedBy(sample);
    analytics.log("instrument_changed", { instrument_type: "sampler" });
    analytics.logFeatureFirstUse("sampler");
    return null;
  }

  /**
   * Changes the loop a loop track plays, from the loop slot that opened the
   * library: one transaction, so one revision and one undo. It is the same
   * use of an audio loop the Loop button's insertion is, so it logs the same
   * first use.
   */
  function replaceLoop(sample: LibrarySample, trackId: TrackId): string | null {
    const currentProject = project();
    if (!currentProject) return notOpen(sample);
    if (sample.kind !== "loop") {
      return `Couldn't insert ${sample.name}: only a loop can replace a loop track's loop.`;
    }
    const commands = replaceLoopCommands(
      currentProject,
      trackId,
      sample,
      createFactoryContext(),
      { songTempo: currentProject.song.tempo },
    );
    if (commands.length === 0) {
      return `Couldn't insert ${sample.name}: this track doesn't play a loop.`;
    }
    const result = session.dispatch(commands);
    if (!result?.ok) return refusedBy(sample);
    options.analytics().logFeatureFirstUse("audio_loop");
    return null;
  }

  /**
   * Loads a library one-shot onto the drum pad whose slot opened the library
   * (#447), as one transaction: the asset if the project lacks it, then the
   * pad. Only the library's Insert reaches this; a drop still lands on the
   * sampler, whatever the library was last opened for.
   */
  function loadPadSample(
    sample: LibrarySample,
    pad: { trackId: TrackId; padId: PadId },
  ): string | null {
    const currentProject = project();
    if (!currentProject) return notOpen(sample);
    if (sample.kind === "loop") {
      return `Couldn't insert ${sample.name}: a loop can't go on a drum pad.`;
    }
    const result = session.dispatch(
      loadPadSampleCommands(
        currentProject,
        pad.trackId,
        pad.padId,
        sample,
        createFactoryContext(),
      ),
    );
    if (!result?.ok) return refusedBy(sample);
    const analytics = options.analytics();
    // A pad sample replacement is an instrument change (PRD OPS-02).
    analytics.log("instrument_changed", { instrument_type: "drum_machine" });
    analytics.logFeatureFirstUse("drum_machine");
    return null;
  }

  /**
   * Adds a pad playing a library one-shot to the drum track whose Sequence
   * view [+ Pad] row opened the library (#947): one transaction, so one undo
   * takes the pad away. The new pad's lane is selected, which the step grid
   * and the instrument view's pad editor share.
   */
  function addPadWithSample(sample: LibrarySample, trackId: TrackId): string | null {
    const currentProject = project();
    if (!currentProject) return notOpen(sample);
    if (sample.kind === "loop") {
      return `Couldn't insert ${sample.name}: a loop can't go on a drum pad.`;
    }
    const insert = addPadWithSampleCommands(
      currentProject,
      trackId,
      sample,
      createFactoryContext(),
    );
    const result = session.dispatch(insert.commands);
    if (!result?.ok) return refusedBy(sample);
    selection.selectPad(trackId, insert.padId);
    const analytics = options.analytics();
    // What a pad given a sound logs on the instrument view (PRD OPS-02).
    analytics.log("instrument_changed", { instrument_type: "drum_machine" });
    analytics.logFeatureFirstUse("drum_machine");
    analytics.logFeatureFirstUse("sequence_add_pad");
    return null;
  }

  /**
   * The Library's insert into `target`, through the pack-upgrade check (#892).
   */
  function targetHost(target: LibraryTarget): LibraryInsertHost {
    return libraryHost((sample) => insertIntoTarget(sample, target));
  }

  /** A drop on the instrument panel always loads the selected sampler. */
  const dropHost = libraryHost(loadLibrarySample);

  function libraryHost(insert: LibraryInsertHost["insert"]): LibraryInsertHost {
    return {
      project,
      client: options.client,
      get analytics() {
        return options.analytics();
      },
      // A newer version of one's own pack is checked against the pack itself.
      heldPacks: options.heldPacks,
      insert,
    };
  }

  return {
    aimed: libraryAimed,
    target: libraryTargetOf,
    isOpen: () => options.view() === "library" && libraryTargetOf() !== null,
    isTarget: (slot) => {
      const target = libraryTargetOf();
      if (target?.kind !== slot.kind) return false;
      return (
        target.kind !== "pad" || (slot.kind === "pad" && slot.padId === target.padId)
      );
    },
    aim: aimLibrary,
    endNewAim: () => {
      setNewTrackAim(false);
      setNewPadAim(false);
    },
    returnFromInsert,
    openPack(slug, via) {
      setNewTrackAim(false);
      setNewPadAim(false);
      setRequestedPack(slug);
      navigation.selectView("library", via);
    },
    requestedPack,
    packOpened: () => setRequestedPack(null),
    slotAudition,
    insert(target, asset, insertOptions) {
      insertedInto = target;
      return insertFromLibrary(targetHost(insertedInto), asset, insertOptions);
    },
    drop: (sample) => dropFromLibrary(dropHost, sample),
    addedPackIds,
    actions: libraryActions,
    registerActions: (actions) => setLibraryActions(() => actions),
  };
}

/**
 * The targets a committed insert goes back from to where the Library was
 * reached, rather than to the instrument: the new track goes back to the
 * arrangement, the new pad to the Sequence view's [+ Pad] row (#947).
 */
const AIMS_BACK: ReadonlySet<LibraryTarget["kind"] | undefined> = new Set([
  "new-track",
  "new-pad",
]);

/** Marks a slot override as the Library's own, for its close to clear. */
const LIBRARY_PREVIEW = Object.freeze({ owner: "library" });

/** The footer's sentence when there is no project to insert into. */
function notOpen(sample: LibrarySample): string {
  return `Couldn't insert ${sample.name}: the project isn't open.`;
}

/** The footer's sentence when the project's own checks refused the change. */
function refusedBy(sample: LibrarySample): string {
  return `Couldn't insert ${sample.name}: the project can't take it, so nothing changed.`;
}
