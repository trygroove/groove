import { For, type JSX, Show } from "@solidjs/web";
import {
  HiOutlineArrowUpTray,
  HiOutlinePencil,
  HiOutlinePlus,
  HiOutlineTrash,
} from "solid-icons/hi";
import { createEffect, createMemo, createSignal } from "solid-js";
import UpgradeAccountPrompt from "../components/UpgradeAccountPrompt";
import { MASK_CONTENT } from "../monitoring/replayPrivacy";
import { ariaBool } from "../shared/aria";
import { formatStorageSize } from "../userData/userData";
import {
  DROP_PACK_NAME,
  MAX_PACK_NAME_LENGTH,
  type UserPack,
} from "../userLibrary/userPacks";
import type { ImportMethod, UserLibrary } from "../userLibrary/useUserLibrary";
import { useFileDrop } from "./fileDrop";
import NameForm from "./NameForm";
import SoundPicker from "./SoundPicker";
import "./MyPacks.css";

/**
 * **My packs** (#282): the producer's own packs, in the library's rail above
 * the factory packs.
 *
 * "Add pack" makes one and puts its name in an input; Return keeps what was
 * typed, and clicking away keeps the name it already has. Choosing a pack
 * opens it: its sounds are listed in the library's main region
 * (`MyPackFiles`, GRV-52), as a factory pack's are, so the rail stays a list
 * of packs. Audio files dragged from the desktop import into the pack they
 * are dropped on, which opens, or into "My Sounds" when dropped on the space
 * around the packs. The file picker ("Add sounds") is the same import for
 * anyone who cannot drag.
 *
 * A guest sees the same controls, and using any of them offers the
 * upgrade-account path, since sounds are stored under an account.
 */
export interface MyPacksProps {
  readonly library: UserLibrary;
  /** The pack open in the main region, which its row shows pressed. */
  readonly openId: string | null;
  /** Open a pack: list its sounds in the main region. */
  onOpen(packId: string): void;
}

function PackItem(props: {
  pack: UserPack;
  open: boolean;
  editing: boolean;
  library: UserLibrary;
  onOpen(): void;
  onEdit(editing: boolean): void;
  onFiles(files: File[]): void;
  /** Open the file picker for this pack. */
  onPick(): void;
}): JSX.Element {
  const drop = useFileDrop((files) => props.onFiles(files));
  const [confirming, setConfirming] = createSignal(false);
  function commit(name: string): void {
    void props.library.renamePack(props.pack.id, name);
    props.onEdit(false);
  }

  return (
    <li
      class="my-packs-pack"
      data-drop={drop.state()}
      onDragEnter={drop.handlers.onDragEnter}
      onDragOver={drop.handlers.onDragOver}
      onDragLeave={drop.handlers.onDragLeave}
      onDrop={drop.handlers.onDrop}
    >
      <div class="my-packs-pack-head">
        <Show
          when={props.editing}
          fallback={
            <button
              type="button"
              class="library-modal-rail-item my-packs-pack-name"
              aria-pressed={ariaBool(props.open)}
              onClick={() => props.onOpen()}
            >
              <span class={MASK_CONTENT}>{props.pack.name}</span>
              <small>{props.pack.assets.length}</small>
            </button>
          }
        >
          <NameForm
            label="Pack name"
            value={props.pack.name}
            maxLength={MAX_PACK_NAME_LENGTH}
            onCommit={commit}
            onCancel={() => props.onEdit(false)}
          />
        </Show>
        <Show when={!props.editing}>
          <span class="my-packs-pack-tools">
            <button
              type="button"
              class="my-packs-icon"
              aria-label="Add sounds"
              title="Add sounds from your computer"
              onClick={() => props.onPick()}
            >
              <HiOutlineArrowUpTray size={13} />
            </button>
            <button
              type="button"
              class="my-packs-icon"
              aria-label="Rename pack"
              title="Rename pack"
              onClick={() => props.onEdit(true)}
            >
              <HiOutlinePencil size={13} />
            </button>
            <button
              type="button"
              class="my-packs-icon"
              aria-label="Delete pack"
              title="Delete pack"
              onClick={() => setConfirming(true)}
            >
              <HiOutlineTrash size={13} />
            </button>
          </span>
        </Show>
      </div>
      <Show when={confirming()}>
        <div class="my-packs-confirm" role="alert">
          <p>
            {props.pack.assets.length === 0
              ? "Delete this empty pack?"
              : `Delete this pack and its ${props.pack.assets.length === 1 ? "sound" : `${props.pack.assets.length} sounds`}? Any project that uses them will report them missing.`}
          </p>
          <div class="my-packs-confirm-actions">
            <button
              type="button"
              class="my-packs-danger"
              onClick={() => void props.library.deletePack(props.pack.id)}
            >
              Delete
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </div>
        </div>
      </Show>
      <Show when={drop.state() === "refused"}>
        <output class="my-packs-hint">Only audio files can go in a pack.</output>
      </Show>
    </li>
  );
}

export default function MyPacks(props: MyPacksProps): JSX.Element {
  const library = () => props.library;
  const [editing, setEditing] = createSignal<string | null>(null);
  // Set by a drop on the space around the packs: "My Sounds" opens once it
  // is listed, so the files' rows are on screen while they upload.
  const [awaitingDropPack, setAwaitingDropPack] = createSignal(false);

  function addPack(): void {
    const id = library().createPack("button");
    if (id) setEditing(id);
  }

  function importInto(packId: string | null, files: File[], method: ImportMethod): void {
    if (packId) props.onOpen(packId);
    else setAwaitingDropPack(true);
    void library().importFiles(packId, files, method);
  }

  createEffect(
    () =>
      awaitingDropPack()
        ? (library()
            .packs()
            .find((pack) => pack.name === DROP_PACK_NAME)?.id ?? null)
        : null,
    (packId) => {
      if (packId === null) return;
      setAwaitingDropPack(false);
      props.onOpen(packId);
    },
  );

  // "Add sounds" on a pack opens the one file picker for that pack: the same
  // import as a drop, for anyone who cannot drag, and reported as the picker.
  let openPicker: (() => void) | undefined;
  let pickingFor: string | null = null;
  function pick(packId: string): void {
    pickingFor = packId;
    openPicker?.();
  }
  function picked(files: File[]): void {
    const packId = pickingFor;
    pickingFor = null;
    if (packId) importInto(packId, files, "picker");
  }

  // Files dropped beside the packs, not on one, make "My Sounds".
  const emptySpace = useFileDrop((files) => importInto(null, files, "drop"));
  const usageLine = createMemo(() => {
    const usage = library().usage();
    // An internal or admin account has no allowance to measure against (GRV-112).
    if (!Number.isFinite(usage.capBytes))
      return `${formatStorageSize(usage.usedBytes)} used`;
    return `${formatStorageSize(usage.usedBytes)} of ${formatStorageSize(usage.capBytes)} used`;
  });

  return (
    <section
      class="my-packs"
      aria-label="My packs"
      data-drop={emptySpace.state()}
      onDragEnter={emptySpace.handlers.onDragEnter}
      onDragOver={emptySpace.handlers.onDragOver}
      onDragLeave={emptySpace.handlers.onDragLeave}
      onDrop={emptySpace.handlers.onDrop}
    >
      <h3 class="library-modal-label library-modal-rule">My packs</h3>
      <SoundPicker
        onOpener={(open) => {
          openPicker = open;
        }}
        onFiles={picked}
      />
      <button
        type="button"
        class="library-modal-rail-item my-packs-add"
        // Until the packs have loaded there is nowhere to put a new one.
        disabled={library().status() === "loading"}
        onClick={addPack}
      >
        <HiOutlinePlus size={14} />
        <span>Add pack</span>
      </button>
      <Show when={library().upgradeAsked()}>
        <div class="my-packs-upgrade">
          <p>Your own sounds are kept in your account.</p>
          <UpgradeAccountPrompt />
        </div>
      </Show>
      <ul class="my-packs-list">
        {/* Keyed by ID: every snapshot brings new pack objects, and remounting
            a pack would drop a name half typed into it. */}
        <For each={library().packs()} keyed={(pack) => pack.id}>
          {(pack) => (
            <PackItem
              pack={pack()}
              open={props.openId === pack().id}
              editing={editing() === pack().id}
              library={library()}
              onOpen={() => props.onOpen(pack().id)}
              onEdit={(value) => setEditing(value ? pack().id : null)}
              onFiles={(files) => importInto(pack().id, files, "drop")}
              onPick={() => pick(pack().id)}
            />
          )}
        </For>
      </ul>
      <Show when={library().status() === "ready" || library().status() === "guest"}>
        <p class="my-packs-hint">
          {emptySpace.state() === "refused"
            ? "Only audio files can go in a pack."
            : "Drop audio files here to make a pack."}
        </p>
      </Show>
      <Show when={library().status() === "error"}>
        <p class="my-packs-hint" role="alert">
          Your packs couldn't load.
        </p>
      </Show>
      <Show when={library().status() === "ready" && library().packs().length > 0}>
        <p class="my-packs-usage">{usageLine()}</p>
      </Show>
      <Show when={library().notice()}>
        <output class="my-packs-notice">{library().notice()}</output>
      </Show>
    </section>
  );
}
