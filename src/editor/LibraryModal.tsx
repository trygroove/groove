import { For, type JSX, Show } from "@solidjs/web";
import { createEffect, createMemo, createSignal, onSettled } from "solid-js";
import { type Analytics, analytics as defaultAnalytics } from "../analytics/analytics";
import { loadEveryAsset } from "../library/allAssets";
import type { PreviewEngine } from "../library/audition";
import type { FavouriteMarks, SoundKey } from "../library/favourites";
import { type LibraryClient, sharedLibraryClient } from "../library/libraryClient";
import MyPackFiles from "../library/MyPackFiles";
import MyPacks from "../library/MyPacks";
import type {
  LibraryAsset,
  LibraryAssetType,
  LibraryPackSummary,
} from "../library/manifest";
import PackBanner from "../library/PackBanner";
import PacksView from "../library/PacksView";
import {
  type PackCatalogEntry,
  packCounts,
  watchPackCatalog,
} from "../library/packCatalog";
import {
  createRecentlyHeardStore,
  type RecentlyHeardStore,
} from "../library/recentlyHeard";
import SimilarSoundsView from "../library/SimilarSoundsView";
import SoundsView, {
  type SoundsAuditioner,
  type SoundsPlace,
} from "../library/SoundsView";
import { type SlotAudition, slotPreviewEngine } from "../library/slotAudition";
import type { SoundsKeyAction } from "../library/soundKeys";
import type { Favourites } from "../library/useFavourites";
import { MASK_CONTENT } from "../monitoring/replayPrivacy";
import { ariaBool } from "../shared/aria";
import type { ShortcutActionId } from "../shortcuts";
import type { UserLibrary } from "../userLibrary/useUserLibrary";
import LibraryHint, { type LibraryPlace } from "./LibraryHint";
import LibraryKeys from "./LibraryKeys";
import { ClearIcon, DiceIcon, GridIcon, SearchIcon } from "./libraryIcons";
import type { LibraryInsertOptions, LibraryInsertOutcome } from "./libraryInsert";
import ViewFrame from "./ViewFrame";
import "./LibraryModal.css";

/** What the rail can show. */
export type LibraryView = "packs" | "all" | "favourites" | "recent";

interface RailItem {
  readonly id: LibraryView;
  readonly label: string;
  /** The registry action whose key badges the item; unset means it has no key. */
  readonly action?: ShortcutActionId;
}

/** Browse packs stands apart from the places below it, as its own button. */
const BROWSE: RailItem = {
  id: "packs",
  label: "Browse packs",
  action: "library.browse_packs",
};

const PLACES: readonly RailItem[] = [
  { id: "all", label: "All sounds", action: "library.all_sounds" },
  { id: "favourites", label: "Favourites", action: "library.favourites" },
];

/** Recently heard sits below the project's packs, so it is not in `PLACES`. */
const RECENT: RailItem = { id: "recent", label: "Recently heard" };

/**
 * What the `library` shortcut context drives. The host (`EditorView`) holds
 * these and registers the registry's `library.*` actions against them, so the
 * modal never listens for a key itself.
 */
export interface LibraryActions {
  showView(view: LibraryView): void;
  /** Inserts the selected sound; resolves true when the insert committed. */
  insertSelected(): Promise<boolean>;
  /** Runs a `library.*` key on the visible view, which knows what it means. */
  press(action: ShortcutActionId): void;
  /** Open similar sounds for the selected sound; false when none is selected. */
  similar(): boolean;
  /** `L`: favourite the selected sound, or take it out; false when it cannot. */
  like(): boolean;
  /**
   * Back out of the innermost sub-view: similar sounds, then an opened pack,
   * then Browse packs. False when there was none to leave.
   */
  back(): boolean;
  /** `?`: open or close the sheet of the library's own keys. */
  toggleKeys(): void;
  /** Close that sheet; false when it was not open, so Escape leaves the view. */
  closeKeys(): boolean;
  /**
   * Close the Sounds view's genre menu, focus back on its button (#874); false
   * when it was not open.
   */
  closeMenu(): boolean;
  /**
   * Escape from the search field (#877): clear its query and keep focus there.
   * False when focus is elsewhere or the field is empty: there is nothing to
   * clear, and Escape does not leave the view (UI-002).
   */
  escapeSearch(): boolean;
}

export interface LibraryModalProps {
  readonly client?: LibraryClient;
  /** Built once per open by the host: a disposed engine stays disposed. */
  readonly previewEngine: PreviewEngine;
  /**
   * The slot's hot-swap (LIB-010): when given, every audition is heard in the
   * slot, in the beat, and closing the window puts the slot's own sound back.
   */
  readonly slotAudition?: SlotAudition;
  readonly analytics?: Analytics;
  /**
   * Insert the chosen sound. The host closes this on the way through when it
   * lands; a refusal, or an upgrade that needs the producer's say-so, comes
   * back for the footer to show (#892). Nothing returned means it landed.
   */
  onInsert(
    asset: LibraryAsset,
    options: LibraryInsertOptions,
  ): LibraryInsertOutcome | Promise<LibraryInsertOutcome> | undefined;
  readonly addedPackIds: readonly string[];
  /** Restrict to these asset types — the Loop button opens it on loops. */
  readonly assetTypes?: readonly LibraryAssetType[];
  readonly heading?: string;
  /** What inserting fills, as a path: "BD › Drum machine › BD" (`UI-002`). */
  readonly path?: string;
  /** The slot's own name, for the footer's hint: a pad's name. */
  readonly slot?: string;
  readonly trackColor?: string;
  /** What the library opens for, so the shelf can open on the slot's family. */
  readonly slotKind?: "drum-pad" | "sampler" | "loop-track";
  /** The storage ref of the sound a drum pad holds, to open on its role. */
  readonly currentRef?: string | null;
  /** The song's tempo, for the loop Tempo filter's "near". */
  readonly songBpm?: number;
  /** The sound the slot holds now. */
  readonly current?: string | null;
  /** Key badge text for a registry action, from the registry, never hard-coded. */
  keyLabel?(action: ShortcutActionId): string;
  onActions?(actions: LibraryActions | null): void;
  /** After the Insert button's insert commits: go back, as Enter does. */
  onInsertAndReturn?(): void;
  /**
   * The producer's own packs (#282), shown as **My packs** in the rail and
   * listed with every other sound. Unset leaves the rail without them.
   */
  readonly userLibrary?: UserLibrary;
  /** Whether the open project uses a sound, so deleting one warns first. */
  isInUse?(asset: LibraryAsset): boolean;
  /**
   * The producer's favourite sounds (#815): the hearts, `L`, and the
   * Favourites place. Unset (nobody signed in) leaves the hearts disabled.
   */
  readonly favourites?: Favourites;
  /**
   * Where this device keeps the sounds it has heard (#815). Defaults to the
   * browser's storage; injected in tests.
   */
  readonly recentlyHeard?: RecentlyHeardStore;
  /**
   * A pack to open on, by slug: the assistant's "Open in library" (GRV-23).
   * The library shows that pack's sounds, as opening it from Browse packs
   * does, then says so through `onPackOpened`.
   */
  readonly openPack?: string | null;
  onPackOpened?(): void;
}

/** How long a committed insert stays marked on the slot's readout. */
const INSERTED_MARK_MS = 1600;
/** How soon after a change of place a second click counts as a double-click's (#1011). */
const DOUBLE_CLICK_MS = 600;
/** What a press focuses itself, so holding focus elsewhere would be wrong. */
const PRESS_FOCUSES =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]";

/** A boxed key badge. `hidden` when its control already names its key. */
function Key(props: { label?: string; hidden?: boolean }): JSX.Element {
  return (
    <Show when={props.label}>
      <kbd class="library-modal-key" aria-hidden={props.hidden ? "true" : undefined}>
        {props.label}
      </kbd>
    </Show>
  );
}

/** Where a slot's auditions are heard, for the footer's hint. */
function slotPlace(kind: LibraryModalProps["slotKind"], slot?: string): string {
  if (kind === "drum-pad") return `the ${slot ?? "drum"} pad`;
  return kind === "loop-track" ? "the loop track" : "the sampler";
}

type PendingUpgrade = Extract<LibraryInsertOutcome, { upgrade: unknown }>["upgrade"];

/** What the footer says in place of its hint after an insert did not land. */
type InsertNotice =
  | {
      readonly kind: "refused";
      readonly asset: LibraryAsset;
      readonly text: string;
      /** Whether "Upgrade anyway" is still on offer, so the producer is never stuck. */
      readonly offerUpgrade: boolean;
    }
  | {
      readonly kind: "confirm";
      readonly asset: LibraryAsset;
      readonly text: string;
      readonly upgrade: PendingUpgrade;
    };

function sounds(count: number): string {
  return count === 1 ? "1 sound" : `${count} sounds`;
}

/** The question an unsafe upgrade asks before it does anything. */
function upgradeQuestion(upgrade: PendingUpgrade & { missing: number }): string {
  return `Inserting this moves the project to ${upgrade.packName} ${upgrade.version}, which leaves ${sounds(upgrade.missing)} in this project missing.`;
}

/** The refusal an upgrade the producer has not agreed to leaves behind. */
function couldNotUpgrade(asset: LibraryAsset, upgrade: PendingUpgrade): string {
  return upgrade.missing === null
    ? `Couldn't insert ${asset.name}: ${upgrade.packName} ${upgrade.version} didn't load, so this project's sounds couldn't be checked against it.`
    : `Couldn't insert ${asset.name}: it needs ${upgrade.packName} ${upgrade.version}, which leaves ${sounds(upgrade.missing)} in this project missing.`;
}

function noticeFor(
  asset: LibraryAsset,
  outcome: Exclude<LibraryInsertOutcome, { ok: true }>,
): InsertNotice {
  if ("reason" in outcome) {
    return { kind: "refused", asset, text: outcome.reason, offerUpgrade: false };
  }
  const { upgrade } = outcome;
  // Missing sounds that could not be counted cannot be asked about honestly,
  // so the footer says why it stopped and still offers the upgrade.
  if (upgrade.missing === null) {
    return {
      kind: "refused",
      asset,
      text: couldNotUpgrade(asset, upgrade),
      offerUpgrade: true,
    };
  }
  return {
    kind: "confirm",
    asset,
    text: upgradeQuestion({ ...upgrade, missing: upgrade.missing }),
    upgrade,
  };
}

/** The footer's sentence beside Insert, with the upgrade's choices when it has them. */
function InsertNoticeView(props: {
  notice: InsertNotice;
  onUpgrade(): void;
  onCancel(): void;
}): JSX.Element {
  return (
    <output class="library-modal-notice">
      <span class={["library-modal-notice-text", MASK_CONTENT]}>{props.notice.text}</span>
      <Show when={props.notice.kind === "confirm" || props.notice.offerUpgrade}>
        <button
          type="button"
          class="library-modal-ghost"
          onClick={() => props.onUpgrade()}
        >
          Upgrade anyway
        </button>
      </Show>
      <Show when={props.notice.kind === "confirm"}>
        <button
          type="button"
          class="library-modal-ghost"
          onClick={() => props.onCancel()}
        >
          Cancel
        </button>
      </Show>
    </output>
  );
}

/**
 * The library window (`UI-001`, `LIB-010`): a header naming what it inserts
 * into (`UI-002`) with **In the slot** and **Hearing** readouts, a rail of places to look, and a footer with
 * one large Insert button. Hearing a sound selects it and inserting is a second
 * step, so browsing never edits the project. All sounds, Favourites and
 * Recently heard (#815) are one sounds view over different lists of sounds.
 * It is the view on `4` (`UI-002`), not a
 * window: `EditorView` hands it the `library` shortcut context.
 */
export default function LibraryModal(props: LibraryModalProps): JSX.Element {
  const [view, setView] = createSignal<LibraryView>("all");
  const [query, setQuery] = createSignal("");
  const [keysOpen, setKeysOpen] = createSignal(false);
  const [selected, setSelectedSound] = createSignal<LibraryAsset | null>(null);
  // Why the last insert did not land, or the upgrade it is waiting on (#892).
  const [notice, setNotice] = createSignal<InsertNotice | null>(null);
  const [inserting, setInserting] = createSignal(false);
  // Recently heard (#815): every sound heard here goes on this device's list.
  // The place shows the list as it stood when it was chosen, so hearing one of
  // its sounds does not move the row under the pointer or the arrow keys.
  const recentStore = props.recentlyHeard ?? createRecentlyHeardStore();
  const [recentShown, setRecentShown] = createSignal<readonly SoundKey[]>(
    recentStore.load(),
  );
  /**
   * A new selection clears whatever the footer said about the last one. Every
   * view selects the sound it auditions, so this is also where hearing one is
   * remembered; Browse packs' Hear it plays a pack and selects nothing.
   */
  function setSelected(asset: LibraryAsset | null): void {
    if (asset !== selected()) setNotice(null);
    setSelectedSound(asset);
    if (asset) recentStore.record({ packId: asset.packId, assetId: asset.id });
  }
  // Every view auditions through this one engine, so each is heard in the slot.
  const previewEngine = props.slotAudition
    ? slotPreviewEngine(props.previewEngine, props.slotAudition, selected)
    : props.previewEngine;
  // The pack whose sounds the sounds view is scoped to (`null`: no scope). The
  // sounds view reads this; Browse packs and In this project set it.
  const [packScope, setPackScope] = createSignal<string | null>(null);
  // Shared, so a second visit opens on what the first loaded.
  const client = props.client ?? sharedLibraryClient();
  // Similar sounds swaps in over whichever place opened it.
  const [similarOf, setSimilarOf] = createSignal<LibraryAsset | null>(null);
  // What the sounds list in view is called, so similar sounds' way back names it.
  const [listLabel, setListLabel] = createSignal<string | undefined>(undefined);
  const [everyAsset, setEveryAsset] = createSignal<readonly LibraryAsset[]>([]);
  // The producer's own pack open in the main region (GRV-52), by ID; a pack
  // deleted while open is no longer found, and the place falls back.
  const [personalPackId, setPersonalPackId] = createSignal<string | null>(null);
  const personalPack = createMemo(() => {
    const id = personalPackId();
    if (id === null) return null;
    return props.userLibrary?.packs().find((pack) => pack.id === id) ?? null;
  });
  // A search lists the whole library, as it does from inside a factory pack's
  // place, so an open personal pack gives way to the results while there is one.
  const showsPersonal = createMemo(
    () => similarOf() === null && personalPack() !== null && query().trim() === "",
  );
  const showsPacks = createMemo(
    () =>
      similarOf() === null &&
      personalPack() === null &&
      view() === "packs" &&
      packScope() === null,
  );
  const showsSounds = createMemo(
    () =>
      similarOf() === null &&
      !showsPersonal() &&
      (view() === "all" ||
        view() === "favourites" ||
        view() === "recent" ||
        packScope() !== null),
  );
  // The rail's *In this project*: the project's pack dependencies and shelf.
  const [indexed, setIndexed] = createSignal<readonly LibraryPackSummary[]>([]);
  const [indexFailed, setIndexFailed] = createSignal(false);
  const projectPacks = createMemo(() =>
    indexed().filter((pack) => props.addedPackIds.includes(pack.id)),
  );
  // Each pack's manifest, so a rail row counts what its shelf shows (GRV-48).
  const [catalog, setCatalog] = createSignal<readonly PackCatalogEntry[]>([]);
  const railCount = (pack: LibraryPackSummary) =>
    packCounts(
      catalog().find((entry) => entry.pack.id === pack.id) ?? { pack, assets: null },
      props.assetTypes,
    ).sounds;

  // The header search outside any pack, put back when the pack is left (#875).
  let searchOutsidePack = "";

  /** Scope the sounds view to a pack, keeping every pack's search to come back to. */
  function openPack(slug: string): void {
    keepFocus(() => {
      setPersonalPackId(null);
      if (packScope() === null) searchOutsidePack = query();
      setPackScope(slug);
    });
  }

  /** Open one of the producer's own packs: its sounds fill the main region. */
  function openPersonalPack(packId: string): void {
    if (personalPackId() === packId && similarOf() === null) return;
    keepFocus(() => {
      setSimilarOf(null);
      closePack();
      setView("all");
      setPersonalPackId(packId);
    });
  }

  // Where focus goes when a change of place takes the focused control with it
  // (#1011): the opened pack's banner, or the rail item naming the new place.
  let main: HTMLDivElement | undefined;
  let banner: HTMLElement | undefined;
  const railButtons = new Map<LibraryView, HTMLButtonElement>();
  // Set when the banner the focus belongs on has not rendered yet.
  let bannerAwaitsFocus = false;
  // When the place last changed, so the second click of a double-click that
  // lands on the new place's bare surface does not blur focus to <body>.
  let placeChangedAt = Number.NEGATIVE_INFINITY;

  const adrift = (element: Element | null) =>
    element === null || element === document.body;

  /**
   * Runs a change of place. The grid of packs, a pack's banner, similar sounds
   * and the sounds list each go (or hide) with the place they belong to, and
   * focus on a control there would fall to <body>; it lands on what names the
   * new place instead. So does focus on the rail item naming the place Back
   * leaves, and focus already adrift on <body>. Focus on any other rail item
   * stays put.
   */
  function keepFocus(change: () => void): void {
    const active = document.activeElement;
    const inMain = active instanceof HTMLElement && main?.contains(active) === true;
    const leftView = view();
    const onLeftRail = active !== null && railButtons.get(leftView) === active;
    const wasAdrift = adrift(active);
    change();
    placeChangedAt = performance.now();
    if (!inMain && !onLeftRail && !wasAdrift) return;
    queueMicrotask(() => {
      const lost = inMain
        ? !active?.isConnected ||
          active.closest("[hidden]") !== null ||
          adrift(document.activeElement)
        : onLeftRail
          ? view() !== leftView && document.activeElement === active
          : adrift(document.activeElement);
      if (lost) focusPlace();
    });
  }

  function mainRendered(element: HTMLDivElement): void {
    main = element;
    // A guard on focus, not an interaction, so it is a listener and not a handler.
    element.addEventListener("mousedown", holdFocusOnDoubleClick);
  }

  /**
   * The second press of a double-click on the control that changed the place
   * lands on whatever the new place put under the pointer. On bare surface that
   * would blur focus to <body>, so it is held where the change put it.
   */
  function holdFocusOnDoubleClick(event: MouseEvent): void {
    if (event.detail < 2 || performance.now() - placeChangedAt > DOUBLE_CLICK_MS) return;
    const target = event.target;
    // Only a focusable control inside the library takes the press: the
    // editor's own focusable containers around it (#76's focus home) are
    // ancestors of everything, so matching them would never hold focus.
    const focusable = target instanceof Element ? target.closest(PRESS_FOCUSES) : null;
    if (focusable !== null && main?.contains(focusable)) return;
    event.preventDefault();
  }

  function focusPlace(): void {
    if (similarOf() === null && packScope() !== null) {
      if (banner?.isConnected) banner.focus();
      // The banner renders once the pack index has loaded.
      else bannerAwaitsFocus = true;
      return;
    }
    railButtons.get(view())?.focus();
  }

  function bannerRendered(element: HTMLElement): void {
    banner = element;
    if (!bannerAwaitsFocus) return;
    bannerAwaitsFocus = false;
    queueMicrotask(() => {
      // Unless the producer has put focus somewhere in the meantime.
      const active = document.activeElement;
      if (active === null || active === document.body) element.focus();
    });
  }

  /** Leave an opened pack, with the search it was opened over. */
  function closePack(): void {
    if (packScope() === null) return;
    setPackScope(null);
    setQuery(searchOutsidePack);
  }

  function showView(next: LibraryView): void {
    keepFocus(() => {
      setSimilarOf(null);
      closePack();
      setPersonalPackId(null);
      if (next === "recent") {
        setRecentShown(recentStore.load());
        (props.analytics ?? defaultAnalytics).logFeatureFirstUse(
          "library_recently_heard",
        );
      }
      setView(next);
    });
  }

  // The pack it is asked to open on (GRV-23): the slug is the one reactive
  // read; opening it is a write, so it is the apply half's.
  createEffect(
    () => props.openPack ?? null,
    (slug) => {
      if (!slug) return;
      showView("packs");
      openPack(slug);
      props.onPackOpened?.();
    },
  );

  /** Swap the main area to the similar-sounds view for `asset`. */
  function openSimilar(asset: LibraryAsset): void {
    setSimilarOf(asset);
    void loadEveryAsset(client).then(setEveryAsset, () => setEveryAsset([]));
  }

  // The hearts, as every list of sounds reads and toggles them.
  const marks = (): FavouriteMarks | undefined => {
    const favourites = props.favourites;
    if (!favourites) return undefined;
    return {
      isFavourite: (sound) => favourites.isFavourite(sound),
      toggle: (sound) => void favourites.toggle(sound),
    };
  };

  function like(): boolean {
    const asset = selected();
    if (!asset || !props.favourites) return false;
    void props.favourites.toggle({ packId: asset.packId, assetId: asset.id });
    return true;
  }

  // The place the sounds view lists, when it is not every sound.
  const soundsPlace = (): SoundsPlace | null => {
    if (packScope() !== null) return null;
    if (view() === "recent") {
      return {
        key: "recent",
        label: RECENT.label,
        sounds: recentShown(),
        showsMissing: false,
        empty:
          "Nothing heard yet. Sounds you audition on this device show up here, the last one heard first.",
      };
    }
    if (view() !== "favourites") return null;
    const favourites = props.favourites;
    const loading =
      favourites !== undefined && !favourites.loaded() && !favourites.failed();
    return {
      key: "favourites",
      label: "Favourites",
      sounds: favourites?.list() ?? [],
      showsMissing: favourites?.loaded() ?? false,
      empty: loading
        ? "Loading your favourites…"
        : `No favourites yet. Press the heart on a sound${
            keyOf("library.like")
              ? `, or ${keyOf("library.like")} on the one you're hearing,`
              : ""
          } to keep it here. Your favourites follow you to every project.`,
    };
  };

  function similar(): boolean {
    const asset = selected();
    if (!asset || similarOf()) return false;
    openSimilar(asset);
    return true;
  }

  /** Back: out of similar sounds, then an opened pack, then the grid of packs. */
  function back(): boolean {
    if (
      similarOf() === null &&
      packScope() === null &&
      personalPack() === null &&
      view() !== "packs"
    ) {
      return false;
    }
    keepFocus(() => {
      if (similarOf() !== null) setSimilarOf(null);
      else if (personalPack() !== null) setPersonalPackId(null);
      else if (packScope() !== null) closePack();
      else setView("all");
    });
    return true;
  }

  const keyOf = (action?: ShortcutActionId) =>
    action ? props.keyLabel?.(action) : undefined;

  let soundsKeys: ((action: SoundsKeyAction) => void) | null = null;
  let similarKeys: ((action: SoundsKeyAction) => void) | null = null;
  // An opened personal pack answers the list keys itself (GRV-76).
  let personalKeys: ((action: SoundsKeyAction) => void) | null = null;
  let closeSoundsMenu: (() => boolean) | null = null;
  // The sounds view's audition, which an opened personal pack's sounds play
  // through and whose play state and load errors their rows show.
  const [auditioner, setAuditioner] = createSignal<SoundsAuditioner | null>(null);

  // Looked up rather than held by `ref`: the dialog reads its header prop more
  // than once, so a ref can end up naming a copy that never mounted.
  const focusSearch = () =>
    document.querySelector<HTMLInputElement>(".library-modal-search")?.focus();

  function press(action: ShortcutActionId): void {
    if (action === "library.search") {
      focusSearch();
      return;
    }
    // Down is how a producer leaves the search field for the list.
    const active = document.activeElement;
    if (
      action === "library.select_next" &&
      active instanceof HTMLInputElement &&
      active.type === "search"
    ) {
      active.blur();
    }
    if (similarOf() !== null) similarKeys?.(action as SoundsKeyAction);
    else if (showsPersonal()) personalKeys?.(action as SoundsKeyAction);
    else if (showsSounds()) soundsKeys?.(action as SoundsKeyAction);
  }

  function toggleKeys(): void {
    setKeysOpen((open) => !open);
  }

  function closeKeys(): boolean {
    if (!keysOpen()) return false;
    setKeysOpen(false);
    return true;
  }

  /** Only a menu on screen is Escape's to close: a hidden view's waits. */
  function closeMenu(): boolean {
    return showsSounds() && (closeSoundsMenu?.() ?? false);
  }

  function clearSearch(): void {
    setQuery("");
    focusSearch();
  }

  function escapeSearch(): boolean {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !active.matches(".library-modal-search")) {
      return false;
    }
    if (query() === "") return false;
    clearSearch();
    return true;
  }

  // The sound an insert just put in the slot, marked on its readout for a
  // moment: an insert can stay here, so this is what shows it worked (UI-002).
  const [inserted, setInserted] = createSignal<string | null>(null);
  let insertedTimer: ReturnType<typeof setTimeout> | undefined;

  async function insertSelected(): Promise<boolean> {
    const asset = selected();
    if (!asset) return false;
    return insert(asset, false);
  }

  /**
   * Runs one insert: a committed one marks the slot's readout, and anything
   * else is kept for the footer to show (#892). True when it committed.
   */
  async function insert(asset: LibraryAsset, upgradeAnyway: boolean): Promise<boolean> {
    if (inserting()) return false;
    clearTimeout(insertedTimer);
    setInserted(null);
    setNotice(null);
    setInserting(true);
    let outcome: LibraryInsertOutcome | undefined;
    try {
      outcome = await props.onInsert(asset, { upgradeAnyway });
    } finally {
      setInserting(false);
    }
    if (!outcome || outcome.ok) {
      setInserted(asset.name);
      insertedTimer = setTimeout(() => setInserted(null), INSERTED_MARK_MS);
      return true;
    }
    // A selection made while it ran is what the footer is about now.
    if (selected() === asset) setNotice(noticeFor(asset, outcome));
    return false;
  }

  /** The Insert button: insert, and go back once it has committed, as Enter does. */
  async function insertAndReturn(): Promise<void> {
    if (await insertSelected()) props.onInsertAndReturn?.();
  }

  /** "Upgrade anyway" is the Insert it was asked from, so it goes back too. */
  async function upgradeAndReturn(asset: LibraryAsset): Promise<void> {
    if (await insert(asset, true)) props.onInsertAndReturn?.();
  }

  /** "Cancel" on the upgrade question: nothing changes, and the footer says so. */
  function cancelUpgrade(): void {
    const current = notice();
    if (current?.kind !== "confirm") return;
    setNotice({
      kind: "refused",
      asset: current.asset,
      text: couldNotUpgrade(current.asset, current.upgrade),
      offerUpgrade: true,
    });
  }

  onSettled(() => {
    void client.loadIndex().then(setIndexed, () => setIndexFailed(true));
    const stopCatalog = watchPackCatalog(client, setCatalog);
    props.onActions?.({
      showView,
      insertSelected,
      press,
      similar,
      like,
      back,
      toggleKeys,
      closeKeys,
      closeMenu,
      escapeSearch,
    });
    return () => {
      stopCatalog();
      clearTimeout(insertedTimer);
      props.onActions?.(null);
      // Leaving the view ends here: the slot plays its own sound again.
      props.slotAudition?.clear();
    };
  });

  // An opened pack is where you are, so the place that opened it is not.
  const isCurrent = (id: LibraryView) =>
    view() === id && packScope() === null && personalPack() === null;
  const place = (): LibraryPlace =>
    similarOf() ? "similar" : showsPacks() ? "packs" : showsSounds() ? "sounds" : "other";

  function RailButton(railProps: {
    item: RailItem;
    browse?: boolean;
    count?: number;
  }): JSX.Element {
    return (
      <button
        type="button"
        ref={(button) => railButtons.set(railProps.item.id, button)}
        class={railProps.browse ? "library-modal-browse" : "library-modal-rail-item"}
        aria-current={isCurrent(railProps.item.id) ? "true" : undefined}
        onClick={() => showView(railProps.item.id)}
      >
        <Show when={railProps.browse}>
          <GridIcon />
        </Show>
        <span>{railProps.item.label}</span>
        <Show when={railProps.count !== undefined}>
          {/* The space keeps the count a word of its own beside the key. */}
          <small>{railProps.count}</small>{" "}
        </Show>
        <Key label={keyOf(railProps.item.action)} />
      </button>
    );
  }

  return (
    <ViewFrame
      label="Library"
      class="library-view"
      header={
        <div class="library-modal-head">
          <span
            class="library-modal-bar"
            style={{ background: props.trackColor ?? "var(--color-accent)" }}
          />
          {/* A track's and a pad's names are the user's (ADR 0002). */}
          <h2 class={["library-modal-slot", MASK_CONTENT]}>
            <span class="library-modal-label">Inserting into </span>
            <b>{props.path ?? props.heading ?? "Library"}</b>
          </h2>
          <fieldset
            class={[
              "library-modal-readout",
              { "library-modal-readout-inserted": inserted() !== null },
            ]}
          >
            <legend class="library-modal-label">In the slot</legend>
            <b>{props.current ?? "Empty"}</b>
          </fieldset>
          <output class="library-modal-inserted">
            {inserted() ? `Inserted ${inserted()}` : ""}
          </output>
          <fieldset class="library-modal-readout">
            <legend class="library-modal-label">Hearing</legend>
            <b>{selected()?.name ?? "Nothing yet"}</b>
          </fieldset>
          <label class="library-modal-find">
            <SearchIcon />
            <input
              type="search"
              class={["library-modal-search", MASK_CONTENT]}
              placeholder="Search sounds, packs and categories"
              aria-label="Search sounds"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
            <Show when={query()}>
              <button
                type="button"
                class="library-modal-clear"
                aria-label="Clear search"
                onClick={clearSearch}
              >
                <ClearIcon />
              </button>
            </Show>
          </label>
        </div>
      }
      footer={
        <>
          <Show
            when={notice()}
            fallback={
              <LibraryHint
                place={place()}
                where={props.slotAudition && slotPlace(props.slotKind, props.slot)}
                current={props.current}
                selected={selected()?.name}
                keyLabel={props.keyLabel}
              />
            }
          >
            {(shown) => (
              <InsertNoticeView
                notice={shown()}
                onUpgrade={() => void upgradeAndReturn(shown().asset)}
                onCancel={cancelUpgrade}
              />
            )}
          </Show>
          <button
            type="button"
            class="library-modal-ghost"
            aria-label="Keyboard shortcuts"
            aria-expanded={ariaBool(keysOpen())}
            onClick={toggleKeys}
          >
            <Key label={keyOf("help.shortcut_guide")} />
          </button>
          <button
            type="button"
            class="library-modal-ghost"
            disabled={!showsSounds()}
            onClick={() => press("library.shuffle")}
          >
            <DiceIcon />
            Shuffle <Key label={keyOf("library.shuffle")} />
          </button>
          <button
            type="button"
            class="library-modal-insert"
            disabled={selected() === null || inserting()}
            aria-keyshortcuts="Enter"
            onClick={() => void insertAndReturn()}
          >
            <span>{selected() ? `Insert ${selected()?.name}` : "Insert"}</span>
            <Key label={keyOf("library.insert_and_return")} hidden />
          </button>
        </>
      }
    >
      <Show when={keysOpen()}>
        <LibraryKeys onClose={() => setKeysOpen(false)} />
      </Show>
      <div class="library-modal-body">
        <nav class="library-modal-rail" aria-label="Places">
          <RailButton item={BROWSE} browse />
          <For each={PLACES}>
            {(item) => (
              <RailButton
                item={item}
                count={
                  item.id === "favourites" && props.favourites?.loaded()
                    ? props.favourites.list().length
                    : undefined
                }
              />
            )}
          </For>
          <Show when={props.favourites?.failed()}>
            <output class="library-modal-rail-note">
              Favourites couldn't be saved or loaded. Try again.
            </output>
          </Show>
          <Show when={props.userLibrary}>
            {(userLibrary) => (
              <MyPacks
                library={userLibrary()}
                openId={personalPack()?.id ?? null}
                onOpen={openPersonalPack}
              />
            )}
          </Show>
          <fieldset class="library-modal-rail-group">
            <legend class="library-modal-label library-modal-rule">
              In this project
            </legend>
            <For each={projectPacks()}>
              {(pack) => (
                <button
                  type="button"
                  class="library-modal-rail-item"
                  aria-pressed={ariaBool(packScope() === pack.slug)}
                  onClick={() => openPack(pack.slug)}
                >
                  <span>{pack.name}</span>
                  <small>{railCount(pack)}</small>
                </button>
              )}
            </For>
            <Show when={indexFailed()}>
              <p class="library-modal-rail-note">Packs couldn't load.</p>
            </Show>
          </fieldset>
          <RailButton item={RECENT} />
        </nav>
        <div class="library-modal-main" ref={mainRendered}>
          <Show when={similarOf()}>
            {(reference) => (
              <SimilarSoundsView
                reference={reference()}
                library={everyAsset()}
                previewEngine={previewEngine}
                trackColor={props.trackColor}
                onSelect={setSelected}
                favourites={marks()}
                onBack={back}
                backLabel={listLabel()}
                onKeys={(handler) => {
                  similarKeys = handler;
                }}
              />
            )}
          </Show>
          <Show when={similarOf() === null && packScope()}>
            {(slug) => (
              <PackBanner
                client={client}
                slug={slug()}
                projectPackIds={props.addedPackIds}
                assetTypes={props.assetTypes}
                onClose={() => showView("all")}
                onBanner={bannerRendered}
              />
            )}
          </Show>
          <Show when={props.userLibrary}>
            {(userLibrary) => (
              <Show when={showsPersonal() && personalPack()}>
                {(pack) => (
                  <MyPackFiles
                    library={userLibrary()}
                    pack={pack()}
                    selectedId={selected()?.id ?? null}
                    playingId={auditioner()?.playingId() ?? null}
                    errorOf={(assetId) => auditioner()?.errorOf(assetId) ?? null}
                    trackColor={props.trackColor}
                    favourites={marks()}
                    onAudition={(asset) => auditioner()?.audition(asset)}
                    onSimilar={openSimilar}
                    isInUse={props.isInUse}
                    onClose={() => showView("all")}
                    onKeys={(handler) => {
                      personalKeys = handler;
                    }}
                  />
                )}
              </Show>
            )}
          </Show>
          <Show when={showsPacks()}>
            <PacksView
              client={client}
              previewEngine={previewEngine}
              analytics={props.analytics}
              projectPackIds={props.addedPackIds}
              assetTypes={props.assetTypes}
              keyLabel={props.keyLabel}
              onOpenPack={openPack}
            />
          </Show>
          {/* Stays mounted while another place shows, so leaving and coming back
              keeps its audition engine, which it disposes with the window. */}
          <div class="library-modal-sounds" hidden={!showsSounds()}>
            <SoundsView
              client={client}
              previewEngine={previewEngine}
              analytics={props.analytics}
              assetTypes={props.assetTypes}
              heading={props.heading}
              trackColor={props.trackColor}
              selected={selected()}
              onSelect={setSelected}
              onSimilar={openSimilar}
              onListLabel={setListLabel}
              query={query()}
              onQueryChange={setQuery}
              packSlug={packScope()}
              songBpm={props.songBpm}
              slot={props.slotKind && { kind: props.slotKind, ref: props.currentRef }}
              keyLabel={props.keyLabel}
              onKeys={(handler) => {
                soundsKeys = handler;
              }}
              onCloseMenu={(close) => {
                closeSoundsMenu = close;
              }}
              extraAssets={props.userLibrary?.assets()}
              extraPacks={props.userLibrary?.summaries()}
              onAuditioner={(handler) => {
                setAuditioner(handler);
              }}
              place={soundsPlace()}
              favourites={marks()}
            />
          </div>
        </div>
      </div>
    </ViewFrame>
  );
}
