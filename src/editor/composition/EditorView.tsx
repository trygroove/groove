// The project route's top-level editor component.

import { Title } from "@solidjs/meta";
import type { JSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  onCleanup,
  onSettled,
  Show,
  Switch,
  snapshot,
  untrack,
} from "solid-js";
import { pageTitle } from "../../../site.config.mjs";
import { type Analytics, analytics as defaultAnalytics } from "../../analytics/analytics";
import type { AssistantClient } from "../../assistant/assistantClient";
import type { AssistantRetentionClient } from "../../assistant/retentionClient";
import {
  getAssistantClient,
  getAssistantRetentionClient,
} from "../../assistantClientProvider";
import { getAudioRuntime } from "../../audio/AudioRuntime";
import { provideStoredAudio } from "../../audio/storedAudio";
import { ToneAuditionEngine } from "../../audio/toneAuditionEngine";
import { type CapabilityReport, FULLY_CAPABLE } from "../../browser/capabilities";
import { reportMissingCapabilities } from "../../browser/reportCapabilities";
import { renameProject } from "../../commands/definitions/project";
import { ControlRegistryContext } from "../../controls/control";
import { createControlRegistry } from "../../controls/registry";
import type { Project } from "../../domain/entities";
import { createFactoryContext } from "../../domain/factories";
import type { PlacementId } from "../../domain/ids";
import type { PreviewEngine } from "../../library/audition";
import { withdrawnFactoryPacks } from "../../library/factoryAvailability";
import { type LibraryClient, sharedLibraryClient } from "../../library/libraryClient";
import type { LibraryPackSummary } from "../../library/manifest";
import { useFavourites } from "../../library/useFavourites";
import { useProducerProfile } from "../../memory/useProducerProfile";
import type { FavouritesRepository } from "../../persistence/favouritesRepository";
import type { ProfileRepository } from "../../persistence/profileRepository";
import { getProjectRepository } from "../../projectRepositoryClient";
import type { ArrangementSelection } from "../../selection";
import { isInternalTraffic } from "../../shared/internalTraffic";
import ShortcutGuide from "../../shortcuts/ShortcutGuide";
import { getUserLibraryRepository } from "../../userLibrary/userLibraryClient";
import type { UserLibraryRepository } from "../../userLibrary/userLibraryRepository";
import { userPackAvailability } from "../../userLibrary/userPacks";
import {
  type UserLibraryAccount,
  useUserLibrary,
} from "../../userLibrary/useUserLibrary";
import AssistantPanel from "../assistant/AssistantPanel";
import { createAssistantLibrary } from "../assistant/assistantLibrary";
import type { ScopeSelection, ScopeSources } from "../assistant/assistantScope";
import { conversationStorageKey } from "../assistant/conversationStore";
import { recommendationSlot } from "../assistant/recommendationCardModel";
import { useAskEditorLink } from "../assistant/useAskEditorLink";
import { useAssistantChat } from "../assistant/useAssistantChat";
import { useAssistantPanel } from "../assistant/useAssistantPanel";
import {
  DeviceSpectrumContext,
  type DeviceSpectrumSource,
} from "../devices/deviceSpectrum";
import InstrumentPane from "../instrument/InstrumentPane";
import LibraryPane from "../library/LibraryPane";
import MissingSounds, {
  type MissingSoundsReport,
  missingAssetIds,
  missingSoundCount,
} from "../library/MissingSounds";
import { useLibraryTarget } from "../library/useLibraryTarget";
import { DeviceMeterContext } from "../mixer/deviceMeters";
import Mixer from "../mixer/Mixer";
import SequencePane from "../sequence/SequencePane";
import { noteEventsOf } from "../sequence/stepEditorModel";
import {
  type AddTrackHost,
  addTrackOfKind,
  type NewTrackKindSpec,
} from "../tracks/trackCreation";
import { useTrackSelection } from "../tracks/useTrackSelection";
import { useSongControls } from "../transport/useSongControls";
import ArrangementPane from "./ArrangementPane";
import CompatibilityNotice from "./CompatibilityNotice";
import { compatibilityNoticeItems } from "./compatibilityNoticeItems";
import { controlHome } from "./controlReveal";
import EditorHeader from "./EditorHeader";
import { type EditorControls, EditorControlsContext } from "./editorControls";
import { type EditorViewName, editorViewSpec } from "./editorViews";
import { installFocusRescue } from "./focusRescue";
import LoadRecoveryNotice from "./LoadRecoveryNotice";
import ProjectLoadStates from "./ProjectLoadStates";
import { SessionToast } from "./SessionToast";
import { useEditingSurfaces } from "./useEditingSurfaces";
import { useEditorNavigation } from "./useEditorNavigation";
import { useEditorReveal } from "./useEditorReveal";
import { useEditorSession } from "./useEditorSession";
import { useEditorShortcuts } from "./useEditorShortcuts";
import { useProjectAudio } from "./useProjectAudio";
import ViewDock from "./ViewDock";
import "./EditorView.css";

export interface EditorViewProps {
  readonly projectId: string;
  /**
   * Which view is on screen (`UI-001`, `UI-002`). It comes from the URL —
   * the route decides, this component only renders — so a deep link opens that
   * view, the back button moves between them, and a reload returns to it.
   */
  readonly view: EditorViewName;
  /** Where each view lives, so the dock's entries are real addresses. */
  viewHref(view: EditorViewName): string;
  /** Navigates to a view. The editor asks; the route is what actually moves. */
  onSelectView(view: EditorViewName): void;
  /**
   * Builds the audition engine each time the Library panel mounts. Defaults to
   * a Tone-backed engine on the shared runtime; injected in tests so the
   * per-mount lifecycle can be exercised without Web Audio.
   */
  readonly createAuditionEngine?: () => PreviewEngine;
  /** Injected in tests; the browser fetches the delivered manifests otherwise. */
  readonly libraryClient?: LibraryClient;
  /** Injected in tests; the shared catalog-backed instance otherwise. */
  readonly analytics?: Analytics;
  /** The header's account control (#951), supplied by the route. */
  readonly account?: JSX.Element;
  /**
   * What this browser can do (#75). The route passes the live detection;
   * omitted, the browser is taken as fully capable and nothing is explained.
   */
  readonly capabilities?: CapabilityReport;
  /**
   * Hands over the editor's controls (`UI-004`) once, for a surface that is
   * not under the editor and so cannot `useEditorControls()` — and for tests.
   */
  onControlsReady?(controls: EditorControls): void;
  /**
   * Who is signed in, for the personal library (#282). A guest, or no one,
   * sees My packs but is offered an account when they try to use it.
   */
  readonly libraryAccount?: UserLibraryAccount | null;
  /** Injected in tests; Firestore and Cloud Storage (or memory) otherwise. */
  readonly userLibraryRepository?: () => Promise<UserLibraryRepository>;
  /** Injected in tests; Firestore (or memory) otherwise. */
  readonly favouritesRepository?: () => Promise<FavouritesRepository>;
  /**
   * Where the producer's profile is, for what Coproducer remembers (GRV-25).
   * Injected in tests; Firestore (or memory) otherwise.
   */
  readonly profileRepository?: () => Promise<ProfileRepository>;
  /**
   * The assistant's way to the gateway (GRV-26). Injected in tests; the
   * app's composition root (`src/assistantClientProvider.ts`) otherwise.
   */
  readonly assistantClient?: () => Promise<AssistantClient>;
  /**
   * Reads and stores the account's answer about keeping its assistant
   * conversations (GRV-8); the composition root's by default.
   */
  readonly assistantRetentionClient?: () => Promise<AssistantRetentionClient>;
  /**
   * Starts a sign-in, for the assistant's prompt to someone who is not
   * signed in (ADR 0006 decision 4). Supplied by the route.
   */
  onSignIn?(): void;
}

/** Mints IDs for tracks the arrangement creates. A module singleton. */
const factoryContext = createFactoryContext();

/**
 * The project editor: open a schema-v1 project, program its clip — on the
 * CLP-02 step editor for a sampler or drum machine, on the CLP-03 piano roll
 * for a synth's note clip — hear it, undo it, and let autosave save it. The
 * `FND-009` slice's minimal 16-step grid was replaced by `LOOP-010`'s full step
 * editor (`StepEditor`) and `LOOP-011`'s `PianoRoll`; the surrounding transport,
 * instrument panels, and save/undo wiring are the same path it established.
 */
export default function EditorView(props: EditorViewProps): JSX.Element {
  // An async computation, not a resource: `createResource` is gone in Solid 2,
  // and reading this memo before `getProjectRepository()` settles reports "not
  // ready" rather than a value. Only `useEditorSession`'s effect consumes it —
  // nothing renders from it — so the not-ready read suspends that effect and
  // never reaches a `Loading` boundary. That is the point: the editor's own
  // not-ready UI is the richer three-way `ProjectLoadStates` below (loading /
  // not found / load error) driven by `session.state`, and the previous
  // `repositoryResource() ?? null` was flattening "still loading" into "there
  // is no repository", which the hook could not tell from a real absence.
  const repository = createMemo(() => getProjectRepository());
  const session = useEditorSession(() => props.projectId, repository);

  // The open project as the plain, immutable `Project` the command layer
  // produced, not the session store's proxy over it (#844). A `Project` is
  // never edited in place: every change is a whole new revision written to
  // `state.project`, so this memo re-runs on every change and nothing gains
  // from the store's per-property tracking. Handing out the proxy instead made
  // every effect that reacts to the project (audio wiring, selection
  // reconciliation) read store properties in its untracked apply half, and
  // Solid's dev build logged STRICT_READ_UNTRACKED for each one, hundreds per
  // edit. `snapshot` is identity-preserving here (the store never writes into a
  // `Project`), so structural sharing between revisions survives intact.
  const project = createMemo(() => {
    const current = session.state.project;
    return current ? snapshot(current) : null;
  });
  const audio = useProjectAudio(project);
  const capabilities = () => props.capabilities ?? FULLY_CAPABLE;
  // Once per capability per browser (`logOnce`), so re-running on a
  // different report or analytics instance costs nothing (#75).
  createEffect(
    () => ({ report: capabilities(), analytics: props.analytics ?? defaultAnalytics }),
    ({ report, analytics }) => reportMissingCapabilities(report, analytics),
  );
  const spectrumSource: DeviceSpectrumSource = {
    isPlaying: () => audio.isPlaying(),
    read: (deviceId) => audio.readDeviceSpectrum(deviceId),
  };
  const [guideOpen, setGuideOpen] = createSignal(false);
  // The editor's controls by address, and their marks (`UI-004`): every part
  // under the editor registers here when it mounts. UI-only, like selection.
  const controls = createControlRegistry();

  const analytics = () => props.analytics ?? defaultAnalytics;
  // The views (UI-001): switching is a navigation, logged as `view_changed`.
  const navigation = useEditorNavigation({
    view: () => props.view,
    onSelectView: (view) => props.onSelectView(view),
    analytics,
  });
  const { selectView } = navigation;

  // The Export dialog is a modal over the editor, so the editor's keys stand down.
  const [exportOpen, setExportOpen] = createSignal(false);

  // The one shared library client, so the Library view and the
  // pack-upgrade check (#892) share its cached index and manifests.
  const libraryClient = props.libraryClient ?? sharedLibraryClient();
  // The producer's own packs (#282). Held by the editor, not the library
  // view, so an import keeps going after you leave the Library view.
  const loadUserLibrary = props.userLibraryRepository ?? getUserLibraryRepository;
  const userLibrary = useUserLibrary({
    account: () => props.libraryAccount ?? null,
    analytics: props.analytics,
    repository: loadUserLibrary,
  });
  // The producer's favourite sounds (#815), held here like their packs so the
  // Library view opens with them already loaded. Favourites are per user, a
  // guest's included: an anonymous uid owns its favourites as it owns projects.
  const favourites = useFavourites({
    uid: () => props.libraryAccount?.uid ?? null,
    repository: props.favouritesRepository,
    analytics: props.analytics,
  });
  // A personal sound has no URL: playback and audition read its bytes from
  // where it is stored, as the signed-in user, through the same repository.
  onCleanup(
    provideStoredAudio(async (storageRef) =>
      (await loadUserLibrary()).readAudio(storageRef),
    ),
  );
  // The published library's pack index, for judging which factory packs the
  // project uses have been withdrawn (#78). Read once, through the shared
  // client's cache; an index that will not load leaves it unknown, and an
  // unknown index reports nothing rather than everything.
  const [libraryIndex, setLibraryIndex] = createSignal<
    readonly LibraryPackSummary[] | null
  >(null);
  createEffect(
    () => undefined,
    () => {
      let open = true;
      libraryClient.loadIndex().then(
        (index) => {
          if (open) setLibraryIndex(index);
        },
        () => {},
      );
      return () => {
        open = false;
      };
    },
  );
  // Focus is never stranded (#76): when the element holding it leaves the page
  // — a view swapped out, a track deleted from its own header — it goes to the
  // view on screen, not to the top of the document. A view marks its own home
  // (`data-focus-home`, the arrangement); the others are the body itself.
  let editorMain: HTMLElement | undefined;
  onSettled(() => {
    if (!editorMain) return;
    const main = editorMain;
    return installFocusRescue(main, () => {
      const body = main.querySelector<HTMLElement>(".editor-body");
      return body?.querySelector<HTMLElement>("[data-focus-home]") ?? body ?? null;
    });
  });
  // The sounds this project uses that are gone: personal sounds gone from the
  // producer's packs (#282) and factory packs the library has withdrawn (#78),
  // named with the tracks and clips they leave silent. Each half is judged
  // only once what it reads has loaded, so nothing reads as missing while it
  // is on its way, and again whenever the project, the packs or the index
  // change.
  const missingSounds = createMemo((): MissingSoundsReport | null => {
    const current = project();
    if (!current) return null;
    const owner = props.libraryAccount?.uid;
    const personal =
      owner && userLibrary.status() === "ready"
        ? userPackAvailability(current, userLibrary.packs(), owner)
        : { missingAssets: [], missingPacks: [] };
    const index = libraryIndex();
    const report = {
      ...personal,
      withdrawnPacks: index ? withdrawnFactoryPacks(current, index) : [],
    };
    return missingSoundCount(report) > 0 ? report : null;
  });
  const userPackName = (packId: string): string | null =>
    userLibrary.packs().find((pack) => pack.id === packId)?.name ?? null;

  // Tempo, swing and the loop: song state the header and the transport keys
  // write through commands.
  const song = useSongControls({ project, session, analytics });

  // Which track, pad and clip the editor is pointed at (#228, #643), and the
  // return the mixer pointed it at (#386): UI-only state with one owner for
  // every write to it. Pointing at a track or a pad ends a new-track or
  // new-pad aim.
  const trackSelection = useTrackSelection({
    project,
    // `library` is declared below: this runs on a user's selection, never
    // during setup.
    onPoint: () => library.endNewAim(),
  });
  const {
    selectTrack,
    selectTrackFrom,
    opened,
    selectPlacement,
    track,
    selectedReturn,
    selectReturn,
    selectMaster,
  } = trackSelection;

  // What the editing surfaces hand up so the shortcut layer can act on them.
  const surfaces = useEditingSurfaces({ opened, audio, session });

  // The arrangement's own selection, kept while another view is on screen:
  // the arrangement is rebuilt on the way back and starts from it, so the
  // clip you selected is still highlighted (`UI-002`). Read only on mount, so
  // a plain variable rather than a signal.
  let arrangementSelection: ArrangementSelection | null = null;
  // The same selection as a signal, for the assistant's scope chip (GRV-26).
  const [arrangementPick, setArrangementPick] = createSignal<ArrangementSelection | null>(
    null,
  );
  /** Selects a placement's clip and goes to `2` with it (`UI-002`). */
  function openPlacement(placementId: PlacementId): void {
    selectPlacement(placementId);
    selectView("sequence", "arrangement");
  }

  // Where the Library is aimed and what inserting from it does (`UI-002`).
  const library = useLibraryTarget({
    project,
    view: () => props.view,
    session,
    analytics,
    selection: trackSelection,
    navigation,
    audio,
    client: libraryClient,
    heldPacks: userLibrary.heldPack,
  });

  /** What a dock tile's tip says its view will open (`UI-002`). */
  function dockOpens(view: EditorViewName): string | undefined {
    if (view === "sequence") return opened()?.clip.name;
    if (view === "instrument") return track()?.name;
    if (view !== "library") return undefined;
    const target = library.target();
    if (target?.kind === "new-track") return "loops for a new track";
    return target ? `sounds for ${track()?.name ?? "the track"}` : undefined;
  }

  // Finding and showing a control by its address (`UI-004`): UI state only.
  const editorControls = useEditorReveal({
    registry: controls,
    project,
    view: () => props.view,
    navigation,
    selection: trackSelection,
  });
  props.onControlsReady?.(editorControls);
  // The assistant's panel (#849): where it is and how big, remembered on this
  // device. One per editor, shared by the panel, the header's button and the
  // shortcut layer.
  const assistant = useAssistantPanel({ analytics: () => props.analytics });
  // What the assistant's scope chip follows (GRV-26): the selection on the
  // view that shows it (clips in the arrangement, notes in the open clip),
  // and the selected track.
  const assistantSources = createMemo((): ScopeSources => {
    let picked: ScopeSelection | null = null;
    if (props.view === "arrangement") {
      const selected = arrangementPick();
      if (selected?.kind === "clips" && selected.placementIds.length > 0) {
        picked = { kind: "clips", placementIds: selected.placementIds };
      }
    } else if (props.view === "sequence") {
      const clip = surfaces.clip();
      if (clip) {
        const ids = surfaces.showPianoRoll()
          ? (surfaces.pianoRollActions()?.selectedIds() ?? [])
          : surfaces.selectedNoteIds();
        const inClip = new Set(noteEventsOf(clip).map((note) => note.id));
        const eventIds = ids.filter((id) => inClip.has(id));
        if (eventIds.length > 0) picked = { kind: "notes", eventIds };
      }
    }
    return { selection: picked, track: track() };
  });
  // The published library the assistant may recommend from (GRV-23), read
  // through the shared client's cache the first time a turn is sent.
  const assistantLibrary = createAssistantLibrary(libraryClient);
  // What a question's options do in the editor (GRV-42): a hovered option's
  // part of the song drawn on the arrangement, a picked one selected, and its
  // sound auditioned or previewed.
  const askLink = useAskEditorLink({
    project,
    session,
    audio,
    selectTrack: (trackId) => selectTrack(trackId),
    selectArrangement(selected) {
      const actions = surfaces.arrangementEditingActions();
      if (actions) {
        // The arrangement reports it back through `onSelectionChange`.
        actions.setSelection(selected);
        return;
      }
      // Off the arrangement: kept for its next visit, and one clip is what
      // the sequence view edits.
      arrangementSelection = selected;
      setArrangementPick(selected);
      if (selected.kind === "clips" && selected.placementIds.length === 1) {
        selectPlacement(selected.placementIds[0]);
      }
    },
  });
  // What Coproducer remembers about a signed-in producer (GRV-25), read once per
  // editor and sent with every turn.
  const producerProfile = useProducerProfile({
    uid: () =>
      props.libraryAccount?.registered ? (props.libraryAccount.uid ?? null) : null,
    repository: props.profileRepository,
  });
  // The conversation (GRV-26): one per editor, kept while the panel is
  // closed, and across a reload of the same project in this tab (GRV-42).
  const chat = useAssistantChat({
    profile: producerProfile,
    project,
    // A lesson's "Hear it" waits for the song to play, and its Show me works
    // through the editor as the assistant (GRV-43).
    playing: () => audio.isPlaying(),
    lessonEditor: {
      apply(commands) {
        const target = session.proposalTarget();
        if (!target || target.gestureActive) return false;
        return target.execute(commands, {
          actor: "assistant",
          baseRevision: target.project.metadata.revision,
        }).ok;
      },
      goTo: (view) => selectView(view, "reveal"),
      point(address) {
        // Called from an effect's apply half: the project is read as it is,
        // not tracked.
        const current = untrack(project);
        if (!current) return;
        const home = controlHome(current, address);
        if (home.trackId) {
          trackSelection.selectTrack(home.trackId);
          if (home.padId) trackSelection.selectPad(home.trackId, home.padId);
        }
        if (home.placementId !== undefined)
          trackSelection.selectPlacement(home.placementId);
      },
      play: () => audio.play(),
      async putSound(role, trackId, padId) {
        const catalog = await assistantLibrary.load();
        const current = project();
        const kit = current?.song.tracks.find((each) => each.id === trackId)?.instrument;
        const pad =
          kit?.kind === "drumMachine"
            ? kit.pads.find((each) => each.id === padId)
            : undefined;
        const playingNow = current?.song.assets.find(
          (asset) => asset.id === pad?.assetId,
        )?.name;
        const sound = catalog?.packs
          .flatMap((entry) => entry.sounds)
          .find(
            (candidate) =>
              candidate.type === "one-shot" &&
              candidate.role.includes(role) &&
              candidate.name !== playingNow,
          );
        if (!sound) return false;
        const outcome = await library.insert({ kind: "pad", trackId, padId }, sound, {
          upgradeAnyway: false,
        });
        return outcome.ok;
      },
    },
    conversationKey: () => {
      const uid = props.libraryAccount?.uid;
      return uid ? conversationStorageKey(uid, props.projectId) : null;
    },
    view: () => props.view,
    sources: assistantSources,
    account: () => ({
      registered: props.libraryAccount?.registered ?? false,
      signIn: props.onSignIn && (() => props.onSignIn?.()),
    }),
    expanded: () => {
      const mode = assistant.layout().mode;
      return mode === "floating" || mode === "docked";
    },
    client: props.assistantClient ?? getAssistantClient,
    analytics,
    committedProject: () => session.committedProject(),
    link: askLink,
    // The disclosure comes before the first message, and every turn says
    // where its transcript is filed, if the account keeps any (GRV-8).
    retention: {
      client: props.assistantRetentionClient ?? getAssistantRetentionClient,
      internal: () => isInternalTraffic(),
    },
    // A proposal previews and applies through the session, and shows its
    // controls through the editor's (GRV-5).
    editor: {
      session: {
        proposalTarget: () => session.proposalTarget(),
        beginPreview: (commands) => session.beginPreview(commands),
        onEdit: (listener) => session.onEdit(listener),
        onRemoteChange: (listener) => session.onRemoteChange(listener),
        previewing: () => session.state.previewing,
      },
      controls: editorControls,
      // A recommended sound is tried through the library's hot-swap and kept
      // through its Insert (GRV-23).
      recommendations: {
        library: assistantLibrary,
        port: {
          slotFor: (trackId, padId) => {
            const current = project();
            return current
              ? recommendationSlot(
                  current,
                  trackId,
                  padId,
                  track(),
                  trackSelection.padSelection(),
                )
              : null;
          },
          previewInSlot: (slot, sound) => audio.previewInSlot(slot, sound),
          clearPreview: () => audio.clearPreview(),
          keep: (target, sound) =>
            library.insert(target, sound, { upgradeAnyway: false }),
          openLibrary: (slug, slot) => {
            // Aimed at the slot the card tries its sounds in.
            if (slot) {
              selectTrack(slot.target.trackId);
              if (slot.target.kind === "pad") {
                trackSelection.selectPad(slot.target.trackId, slot.target.padId);
              }
            }
            library.openPack(slug, "reveal");
          },
          createAuditionEngine:
            props.createAuditionEngine ??
            (() =>
              new ToneAuditionEngine(getAudioRuntime(), {
                songTempo: () => project()?.song.tempo ?? 120,
              })),
        },
      },
    },
  });
  // Docked, the editor's views leave the panel's column free (EditorView.css).
  const assistantDockSpace = () =>
    assistant.layout().mode === "docked" ? `${assistant.layout().width}px` : "0px";

  const { shortcuts, editorContexts, keyHint } = useEditorShortcuts({
    view: () => props.view,
    project,
    audio,
    session,
    analytics,
    navigation,
    selection: trackSelection,
    library,
    song,
    surfaces,
    openPlacement,
    setGuideOpen,
    assistant,
    sendAssistantDraft: () => chat.sendDraft(),
    assistantAsk: {
      pending: () => chat.conversation.pendingAsk() !== null,
      optionCount: () => chat.conversation.pendingAsk()?.ask.options.length ?? 0,
      multiSelect: () => chat.conversation.pendingAsk()?.ask.multiSelect === true,
      pick: (index) => chat.ask.pick(index),
      canFinish: () => chat.ask.canFinish(),
      finish: () => chat.ask.finish(),
      focused: () => chat.ask.focused(),
      canHear: (index) => chat.ask.canHear(index),
      hear: (index) => chat.ask.hear(index),
    },
  });

  /** An empty screen's way out: a view, named and keyed as the dock names it. */
  const viewFix = (view: EditorViewName) => ({
    view,
    label: editorViewSpec(view).label,
    keyLabel: keyHint(editorViewSpec(view).actionId),
  });

  /** Adds a track of the chosen kind, through the route the arrangement's
   * buttons take, and selects it (#495). */
  function addTrack(
    current: Project,
    spec: NewTrackKindSpec,
    feature: AddTrackHost["feature"] = "arrangement",
  ): void {
    addTrackOfKind(spec.kind, {
      project: current,
      context: factoryContext,
      dispatch: session.dispatch,
      analytics: props.analytics ?? defaultAnalytics,
      feature,
      onSelect: selectTrack,
    });
  }

  return (
    <ControlRegistryContext value={controls}>
      <EditorControlsContext value={editorControls}>
        <main
          ref={editorMain}
          class={["editor", `editor-${props.view}`]}
          style={{ "--assistant-dock-space": assistantDockSpace() }}
        >
          <Switch>
            <Match
              when={
                session.state.loading || session.state.notFound || session.state.error
              }
            >
              <ProjectLoadStates
                loading={session.state.loading}
                notFound={session.state.notFound}
                error={session.state.error}
              />
            </Match>
            <Match when={project()}>
              {(currentProject) => (
                <>
                  <Title>{pageTitle(currentProject().metadata.name)}</Title>
                  <EditorHeader
                    projectName={currentProject().metadata.name}
                    onRename={(name) => session.dispatch(renameProject(name))}
                    missingAssetIds={() => missingAssetIds(missingSounds())}
                    session={session}
                    audio={audio}
                    onToggleLoop={song.toggleLoop}
                    tempo={song.tempo}
                    onTempoChange={song.applyTempo}
                    swing={song.swing}
                    onSwingInput={song.swingInput}
                    onSwingCommit={song.commitSwing}
                    onOpenGuide={() => setGuideOpen(true)}
                    onExportOpenChange={setExportOpen}
                    keyHint={keyHint}
                    account={props.account}
                    assistant={{
                      open: () => assistant.layout().mode !== "closed",
                      ariaKeys: shortcuts.platform === "mac" ? "Meta+K" : "Control+K",
                      toggle: (opener) => assistant.toggle(opener),
                      bindLauncher: (element) => assistant.bindLauncher(element),
                    }}
                  />
                  <CompatibilityNotice
                    items={compatibilityNoticeItems(
                      capabilities(),
                      audio.startFailure(),
                      audio.loadFailure(),
                    )}
                  />
                  <LoadRecoveryNotice
                    droppedPlacements={session.state.droppedPlacements}
                  />
                  <Show when={missingSounds()}>
                    {(report) => (
                      <MissingSounds report={report()} packName={userPackName} />
                    )}
                  </Show>
                  {/* The views' device panels draw live spectra from playback (LOOP-022),
                      and the Limiter its meters (#937). */}
                  <DeviceSpectrumContext value={spectrumSource}>
                    <DeviceMeterContext value={audio.deviceMeter}>
                      {/* Where focus goes when the element holding it is gone (#76). */}
                      <div class="editor-body" tabindex={-1}>
                        {/*
                         * One view at a time (`UI-001`). A view you are not on is not
                         * on the page at all rather than hidden behind the one you
                         * are — the bet this change exists to test.
                         */}
                        <Switch>
                          <Match when={props.view === "arrangement"}>
                            <ArrangementPane
                              project={currentProject()}
                              audio={audio}
                              session={session}
                              selection={trackSelection}
                              surfaces={surfaces}
                              onOpenPlacement={openPlacement}
                              initialSelection={arrangementSelection}
                              onSelectionChange={(selected) => {
                                arrangementSelection = selected;
                                setArrangementPick(selected);
                              }}
                              onAddTrack={(spec) => addTrack(currentProject(), spec)}
                              onAddLoop={() => library.aim("arrangement", "new-track")}
                              highlight={askLink.bands}
                            />
                          </Match>
                          <Match when={props.view === "sequence"}>
                            <SequencePane
                              project={currentProject()}
                              audio={audio}
                              session={session}
                              selection={trackSelection}
                              surfaces={surfaces}
                              songTempo={song.tempo()}
                              onAddPad={() => library.aim("slot", "new-pad")}
                              fix={viewFix}
                              onFix={(view) => selectView(view, "empty_screen")}
                            />
                          </Match>
                          <Match when={props.view === "instrument"}>
                            <InstrumentPane
                              project={currentProject()}
                              audio={audio}
                              session={session}
                              selection={trackSelection}
                              library={library}
                              keyHint={keyHint}
                              onAddTrack={(spec) =>
                                addTrack(currentProject(), spec, "instrument_add_track")
                              }
                            />
                          </Match>
                          <Match when={props.view === "library"}>
                            <LibraryPane
                              project={currentProject()}
                              library={library}
                              selection={trackSelection}
                              client={libraryClient}
                              createAuditionEngine={props.createAuditionEngine}
                              analytics={props.analytics}
                              keyHint={keyHint}
                              songBpm={song.tempo()}
                              fix={viewFix}
                              onFix={(view) => selectView(view, "empty_screen")}
                              userLibrary={userLibrary}
                              favourites={favourites}
                            />
                          </Match>
                          <Match when={props.view === "mixer"}>
                            <div class="mixer-view">
                              <Mixer
                                project={currentProject()}
                                analytics={props.analytics}
                                dispatch={session.dispatch}
                                beginGesture={session.beginGesture}
                                trackLevel={audio.trackLevel}
                                masterLevel={audio.masterLevel}
                                selectedTrackId={track()?.id ?? null}
                                onSelectTrack={selectTrackFrom}
                                selectedReturnId={selectedReturn()?.id ?? null}
                                onSelectReturn={selectReturn}
                                onSelectMaster={selectMaster}
                              />
                            </div>
                          </Match>
                        </Switch>
                      </div>
                    </DeviceMeterContext>
                  </DeviceSpectrumContext>
                  <ViewDock
                    view={props.view}
                    href={props.viewHref}
                    onSelect={(view) => selectView(view, "dock")}
                    keyHint={(view) => keyHint(editorViewSpec(view).actionId)}
                    opens={dockOpens}
                    dimmed={(view) => view === "sequence" && opened() === null}
                    marked={(view) => view === "library" && library.target() !== null}
                  />
                  {/*
                   * The assistant's slot (#849): its panel mounts here, once per
                   * editor, floating over the views or docked beside them. Docking
                   * moves `--assistant-dock-space` (EditorView.css), the editor's
                   * own layout, and no view learns the panel exists. A modal
                   * dialog (the same three that make `dialog` the only shortcut
                   * context) puts it under the dialog and out of reach.
                   */}
                  <AssistantPanel
                    panel={assistant}
                    chat={chat}
                    underModal={() => guideOpen() || exportOpen()}
                  />
                  <Show when={guideOpen()}>
                    <ShortcutGuide
                      contexts={editorContexts()}
                      platform={shortcuts.platform}
                      isEnabled={(id) => shortcuts.isEnabled(id)}
                      onClose={() => setGuideOpen(false)}
                    />
                  </Show>
                </>
              )}
            </Match>
          </Switch>
          <SessionToast onNotice={session.onNotice} />
        </main>
      </EditorControlsContext>
    </ControlRegistryContext>
  );
}
