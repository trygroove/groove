import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import type { Analytics } from "../analytics/analytics";
import { getAudioRuntime } from "../audio/AudioRuntime";
import type { Project } from "../domain/entities";
import type { PreviewEngine } from "../library/audition";
import type { LibraryClient } from "../library/libraryClient";
import type { LibraryAsset } from "../library/manifest";
import { ToneAuditionEngine } from "../library/toneAuditionEngine";
import type { Favourites } from "../library/useFavourites";
import type { ShortcutActionId } from "../shortcuts";
import type { UserLibrary } from "../userLibrary/useUserLibrary";
import type { EmptyViewFix } from "./EmptyView";
import type { EditorViewName } from "./editorViews";
import LibraryEmpty from "./LibraryEmpty";
import LibraryModal from "./LibraryModal";
import {
  type LibraryTarget,
  targetAssetTypes,
  targetPath,
  targetSound,
} from "./libraryTarget";
import type { LibraryTargeting } from "./useLibraryTarget";
import type { TrackSelection } from "./useTrackSelection";

export interface LibraryPaneProps {
  readonly project: Project;
  readonly library: LibraryTargeting;
  readonly selection: Pick<TrackSelection, "track">;
  readonly client: LibraryClient;
  /**
   * Builds the audition engine each time the Library panel mounts. Defaults to
   * a Tone-backed engine on the shared runtime; injected in tests.
   */
  readonly createAuditionEngine?: () => PreviewEngine;
  readonly analytics?: Analytics;
  keyHint(action: ShortcutActionId): string;
  readonly songBpm: number;
  /** An empty screen's way out, named and keyed as the dock names it. */
  fix(view: EditorViewName): EmptyViewFix;
  onFix(view: EditorViewName): void;
  /** The producer's own packs (#282), held by the editor so an import keeps
   * going after you leave the Library view. */
  readonly userLibrary: UserLibrary;
  /** The producer's favourite sounds (#815), held by the editor. */
  readonly favourites?: Favourites;
}

/** What the sounds view opens on, for each Library target (LIB-010). */
const SLOT_KINDS: Record<LibraryTarget["kind"], "drum-pad" | "sampler" | "loop-track"> = {
  pad: "drum-pad",
  sampler: "sampler",
  loop: "loop-track",
  "new-track": "loop-track",
  "new-pad": "drum-pad",
};

/**
 * The Library view (`UI-002`): the sounds that could go where it is aimed, or
 * why it is aimed nowhere.
 */
export default function LibraryPane(props: LibraryPaneProps): JSX.Element {
  const { library } = props;
  // A fresh audition engine per panel mount, built off the shared runtime the
  // first time each opening browses. `LibraryBrowser`'s `useLibraryBrowser`
  // disposes the engine on unmount (its `AuditionController.dispose()` calls
  // `engine.dispose()`), and a disposed `ToneAuditionEngine` stays disposed —
  // so the engine must be owned per mount, never cached across panel opens, or
  // the second open would reuse a dead engine and every audition would fail
  // with `asset_missing` (LOOP-013). Auditions play through the same
  // destination the project does — never an export/offline context (LIB-01).
  const createAuditionEngine = () =>
    (
      props.createAuditionEngine ??
      (() =>
        new ToneAuditionEngine(getAudioRuntime(), { songTempo: () => props.songBpm }))
    )();
  /** Whether the open project uses a sound: its stored audio is one of the song's. */
  const projectUses = (asset: LibraryAsset): boolean =>
    asset.storageRef !== undefined &&
    props.project.song.assets.some((used) => used.storageRef === asset.storageRef);
  return (
    // A fresh audition engine per visit: leaving disposes it (LOOP-013), so a
    // cached one would be dead.
    <Show
      when={library.target()}
      fallback={
        <LibraryEmpty
          kind={library.aimed().kind as "synth" | "no-slot" | "no-track"}
          fix={props.fix}
          onFix={(view) => props.onFix(view)}
        />
      }
    >
      {(target) => (
        <LibraryModal
          client={props.client}
          previewEngine={createAuditionEngine()}
          slotAudition={library.slotAudition()}
          analytics={props.analytics}
          onInsert={(asset, options) => library.insert(target(), asset, options)}
          addedPackIds={library.addedPackIds()}
          assetTypes={targetAssetTypes(target())}
          heading={SLOT_KINDS[target().kind] === "loop-track" ? "Loops" : "Library"}
          path={targetPath(props.project, target())}
          slot={targetPath(props.project, target()).split(" › ").at(-1)}
          trackColor={props.selection.track()?.color}
          keyLabel={props.keyHint}
          current={targetSound(props.project, target())?.name ?? null}
          slotKind={SLOT_KINDS[target().kind]}
          songBpm={props.songBpm}
          currentRef={targetSound(props.project, target())?.storageRef ?? null}
          onActions={(actions) => library.registerActions(actions)}
          onInsertAndReturn={() => library.returnFromInsert("library_insert")}
          openPack={library.requestedPack()}
          onPackOpened={() => library.packOpened()}
          userLibrary={props.userLibrary}
          isInUse={projectUses}
          favourites={props.favourites}
        />
      )}
    </Show>
  );
}
