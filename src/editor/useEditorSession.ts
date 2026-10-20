import { type Accessor, createEffect, createStore, onCleanup } from "solid-js";
import type { ProposalTarget } from "../assistant/proposalExecutor";
import type {
  Gesture,
  GestureOptions,
  RawCommandInput,
  TransactionResult,
} from "../commands";
import type { Project } from "../domain/entities";
import type { ProjectId } from "../domain/ids";
import type { SaveStatus } from "../persistence/autosave";
import type { ProjectRepository } from "../persistence/projectRepository";
import { holdPendingWrites } from "../shared/pendingWrites";
import { assistantProposalTarget } from "./assistantProposalTarget";
import {
  EditorSession,
  type EditorSessionSnapshot,
  type PreviewResult,
  type SessionEditListener,
  type SessionNoticeListener,
} from "./EditorSession";
import { reportProjectLoad } from "./projectLoadReport";

/**
 * Attaches the PRD `PRJ-03` navigation-flush behavior for one session: a
 * queued-but-not-yet-written edit is flushed as soon as the browser signals
 * the page might not get another chance to run, not only when this Solid
 * effect tears down (in-app route changes already get that from `onCleanup`
 * below).
 *
 * `visibilitychange` to `"hidden"` is the reliable signal across desktop and
 * mobile browsers (a background tab, an app switch, a real close all fire
 * it); `pagehide` covers the same-tab navigation/close cases some browsers
 * fire without a visibility change first. Neither can guarantee the write
 * completes before the page actually goes away — that is what "where the
 * browser permits a flush" in the PRD acknowledges — but both start it as
 * early as this code can detect the moment.
 *
 * `beforeunload` comes first and is the one chance to ask the user to stay
 * (GRV-60): while an edit is still unsaved it shows the browser's "leave
 * site?" prompt and starts the write, which can finish while the prompt is up.
 *
 * `online` retries a save the connection dropped (GRV-55).
 */
function watchNavigationFlush(getSession: () => EditorSession | null): void {
  if (typeof window === "undefined") return;

  function flush(): void {
    getSession()
      ?.autosave.flush()
      .catch(() => {
        // `flush()` only rejects if the repository call itself throws
        // synchronously into the promise chain; a failed write already
        // surfaces through `SaveStatus.state === "failed"`, so there is
        // nothing further to do with the rejection here.
      });
  }

  function handleVisibilityChange(): void {
    if (document.visibilityState === "hidden") flush();
  }

  function handleBeforeUnload(event: BeforeUnloadEvent): void {
    if (!getSession()?.warnBeforeExit()) return;
    event.preventDefault();
    // Older Chrome and Edge show the prompt only when `returnValue` is set.
    event.returnValue = "";
  }

  // Back online (GRV-55): a save that failed for want of a connection is
  // written now, without waiting for Retry.
  function handleOnline(): void {
    getSession()?.reconnected();
  }

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", handleBeforeUnload);
  window.addEventListener("online", handleOnline);
  onCleanup(() => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("pagehide", flush);
    window.removeEventListener("beforeunload", handleBeforeUnload);
    window.removeEventListener("online", handleOnline);
  });
}

/**
 * How many of an autosave's queued edits another write could still land
 * (GRV-55): none once its failure is one no retry clears (a document too
 * large, a refused permission, a conflict GRV-88 settles), so neither the
 * connection coming back nor the crash screen keeps trying them.
 */
function writablePending(autosave: EditorSession["autosave"]): number {
  const { pending, state, failure } = autosave.status;
  if (state === "failed" && !failure?.retryable) return 0;
  return pending;
}

/**
 * Holds a session's queued edits where the crash screen can write them
 * (GRV-55). Returns the release.
 */
function holdSessionWrites(session: EditorSession): () => void {
  return holdPendingWrites({
    pending: () => writablePending(session.autosave),
    flush: () => session.autosave.flush(),
  });
}

/**
 * Disposes a closing session once its last write has settled (GRV-55). If
 * that write left edits unwritten (the connection dropped), the session goes
 * but its autosave and their queue stay held: written when the browser is back
 * online, or by the crash screen's Reload, and only then let go. A queued
 * edit is never dropped because its project closed.
 */
function retireSession(session: EditorSession, release: () => void): void {
  release();
  if (writablePending(session.autosave) === 0) {
    session.dispose();
    return;
  }
  session.dispose({ keepUnsavedWrites: true });
  const { autosave } = session;
  const flush = async () => {
    await autosave.flush();
    // Landed, or failed in a way no further write can clear: let go.
    if (writablePending(autosave) === 0) {
      releaseRetired();
      autosave.dispose();
    }
  };
  const onOnline = () => void flush();
  const releaseHeld = holdPendingWrites({
    pending: () => writablePending(autosave),
    flush,
  });
  const releaseRetired = () => {
    releaseHeld();
    if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
  };
  if (typeof window !== "undefined") window.addEventListener("online", onOnline);
}

export interface EditorSessionState {
  readonly loading: boolean;
  readonly notFound: boolean;
  readonly error: string | null;
  /** What the editor shows: the previewed project while a preview is open. */
  readonly project: Project | null;
  /** True while an uncommitted preview is open (UI-005). */
  readonly previewing: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoSummary: string | null;
  readonly redoSummary: string | null;
  readonly saveStatus: SaveStatus | null;
  /**
   * How many placements opening this project dropped because their clips were
   * never stored (#965). Zero for a clean open; the editor tells the user
   * when it is not.
   */
  readonly droppedPlacements: number;
}

export interface UseEditorSessionResult {
  readonly state: EditorSessionState;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  /**
   * Opens a continuous edit gesture — a piano-roll note drag, a step-editor
   * paint/erase stroke, a fader/pan drag — or `undefined` before a session has
   * loaded. Every step applies live; the whole gesture commits as one history
   * entry, one revision, and one autosave (PRD `CLP-02`, `CLP-03`, `TRK-02`).
   */
  beginGesture(options?: GestureOptions): Gesture | undefined;
  /**
   * Shows commands applied without committing them (UI-005), or `undefined`
   * before a session has loaded. See `EditorSession.beginPreview`.
   */
  beginPreview(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): PreviewResult | undefined;
  /**
   * The committed project, never a preview of it, or `null` before a session
   * has loaded. Not reactive: `state.project` is what changes.
   */
  committedProject(): Project | null;
  /**
   * Whether a preview is open right now. Not reactive, unlike
   * `state.previewing`, so it is current straight after one ends.
   */
  previewOpen(): boolean;
  undo(): TransactionResult | null | undefined;
  redo(): TransactionResult | null | undefined;
  /** The explicit retry affordance PRD `PRJ-03` requires for a failed save. */
  retry(): Promise<SaveStatus> | undefined;
  /**
   * The session as the assistant's proposal target (GRV-4), or `undefined`
   * before a session has loaded.
   */
  proposalTarget(): ProposalTarget | undefined;
  /**
   * Hears every edit, undo and redo the open session commits
   * (`EditorSession.subscribeEdits`), whichever session is open. Returns the
   * call that stops it.
   */
  onEdit(listener: SessionEditListener): () => void;
  /** Hears every change adopted from elsewhere (`subscribeRemoteChanges`). */
  onRemoteChange(listener: () => void): () => void;
  /** Hears every notice the open session raises (`subscribeNotices`, GRV-88). */
  onNotice(listener: SessionNoticeListener): () => void;
}

/**
 * The store's own value type: a writable twin of the public, readonly
 * {@link EditorSessionState}. A Solid 2 store setter hands its callback a
 * mutable *draft* of the stored value, so the store has to be declared over a
 * type whose properties can be assigned; consumers still only ever see the
 * readonly view `createStore` returns, which is `EditorSessionState` exactly.
 */
type EditorSessionStateDraft = {
  -readonly [K in keyof EditorSessionState]: EditorSessionState[K];
};

const INITIAL_STATE: EditorSessionState = {
  loading: true,
  notFound: false,
  error: null,
  project: null,
  previewing: false,
  canUndo: false,
  canRedo: false,
  undoSummary: null,
  redoSummary: null,
  saveStatus: null,
  droppedPlacements: 0,
};

/**
 * Loads a schema-v1 project and adapts an `EditorSession` into Solid state
 * (`FND-009`).
 *
 * Re-runs whenever `projectId()` or `repository()` changes, tearing down the
 * previous session first: any debounced autosave write in flight is flushed
 * before disposal, exactly like the prototype `useProject`'s
 * `flushPendingWrite` did, so a coalesced edit made just before navigating
 * away is never dropped.
 *
 * `repository()` may be an async computation that is not ready yet (it is:
 * `EditorView` hands over an async `createMemo` around
 * `getProjectRepository()`). Reading it in the compute half below is what
 * makes that legible — the effect simply does not run until the repository
 * resolves, and the state stays at its `loading: true` initial value in the
 * meantime, rather than the hook being handed a `null` it cannot tell apart
 * from "there is genuinely no repository".
 */
export function useEditorSession(
  projectId: Accessor<string>,
  repository: Accessor<ProjectRepository>,
): UseEditorSessionResult {
  // Shallow (#856): each key is tracked, but its value is held raw and replaced
  // by reference. A `Project` is one immutable value per revision (the command
  // layer never edits one in place), so a deep store only multiplied it into a
  // store node per field: a memo deriving from the project then tracked every
  // note and placement it read, thousands of sources for a 7-track, 4-bar song,
  // and still re-ran on every revision because the `project` key changed. Held
  // raw, a derivation tracks the one `project` key and reads plain data.
  const [state, setState] = createStore<EditorSessionStateDraft>(
    { ...INITIAL_STATE },
    { shallow: true },
  );
  let session: EditorSession | null = null;
  watchNavigationFlush(() => session);
  // Held here rather than on a session, so a listener added before the
  // project has loaded hears the session that opens.
  const editListeners = new Set<SessionEditListener>();
  const remoteListeners = new Set<() => void>();
  const noticeListeners = new Set<SessionNoticeListener>();

  // Split effect. The compute half holds *both* reactive reads — `projectId()`
  // and `repository()` — and nothing else in the body below reads a signal or
  // a store, so that is the complete dependency set. Solid 2 only tracks the
  // compute function, so either read moved down into the apply half would
  // silently stop the session reloading when it changed.
  //
  // Everything else is in the apply half because it writes: `setState` throws
  // if it runs inside a tracking scope, and the apply phase is where a write
  // is sanctioned. The teardown is the value the apply half *returns* rather
  // than a nested `onCleanup`, which is no longer the idiom (and no longer
  // works from here).
  //
  // The `setState` calls made from the `loadProject` continuation and from the
  // two subscription callbacks below are deliberately left where they are:
  // they run later, on a microtask or a subscriber notification, outside any
  // tracking scope, so they need no special handling.
  createEffect(() => ({ id: projectId(), repository: repository() }), {
    effect: ({ id, repository: repo }) => {
      // The one genuine whole-state reset, so it uses the setter's
      // return-a-replacement form (every key is present, which is what that
      // form requires — a returned object's missing keys are deleted). Every
      // other write below is a partial update and mutates the draft instead.
      setState(() => ({ ...INITIAL_STATE, loading: true }));
      session = null;

      let cancelled = false;
      let localSession: EditorSession | null = null;
      let unsubscribeHistory: (() => void) | null = null;
      let unsubscribeSave: (() => void) | null = null;
      let unsubscribeEdits: (() => void) | null = null;
      let unsubscribeRemote: (() => void) | null = null;
      let unsubscribeNotices: (() => void) | null = null;
      let releaseWrites: () => void = () => {};

      function applySnapshot(snapshot: EditorSessionSnapshot): void {
        setState((draft) => {
          draft.loading = false;
          draft.notFound = false;
          draft.error = null;
          draft.project = snapshot.project;
          draft.previewing = snapshot.previewing;
          draft.canUndo = snapshot.canUndo;
          draft.canRedo = snapshot.canRedo;
          draft.undoSummary = snapshot.undoSummary;
          draft.redoSummary = snapshot.redoSummary;
        });
      }

      repo.loadProject(id as ProjectId).then((result) => {
        reportProjectLoad(result);
        if (cancelled) return;
        if (!result.ok) {
          setState((draft) => {
            draft.loading = false;
            draft.notFound = result.reason === "not_found";
            draft.error =
              result.reason === "not_found"
                ? null
                : "Something went wrong while loading this project.";
          });
          return;
        }
        localSession = new EditorSession({
          repository: repo,
          project: result.value,
          dropped: result.dropped,
        });
        const droppedPlacements = result.dropped?.placements ?? 0;
        setState((draft) => {
          draft.droppedPlacements = droppedPlacements;
        });
        session = localSession;
        releaseWrites = holdSessionWrites(localSession);
        unsubscribeHistory = localSession.subscribe(applySnapshot);
        unsubscribeEdits = localSession.subscribeEdits((edit) => {
          for (const listener of [...editListeners]) listener(edit);
        });
        unsubscribeRemote = localSession.subscribeRemoteChanges(() => {
          for (const listener of [...remoteListeners]) listener();
        });
        unsubscribeNotices = localSession.subscribeNotices((notice) => {
          for (const listener of [...noticeListeners]) listener(notice);
        });
        unsubscribeSave = localSession.autosave.subscribe((status) =>
          setState((draft) => {
            draft.saveStatus = status;
          }),
        );
        applySnapshot(localSession.snapshot());
      });

      return () => {
        cancelled = true;
        unsubscribeHistory?.();
        unsubscribeSave?.();
        unsubscribeEdits?.();
        unsubscribeRemote?.();
        unsubscribeNotices?.();
        if (localSession) {
          const disposing = localSession;
          const release = releaseWrites;
          void disposing.autosave
            .flush()
            .catch(() => undefined)
            .then(() => retireSession(disposing, release));
        }
        if (session === localSession) {
          session = null;
        }
      };
    },
    // The compute half reads `repository()`, an async memo -- so it can
    // *reject*, not just be not-ready. Without this arm that rejection is
    // silent: the compute throws, the effect body never runs, `loading` stays
    // true, and the editor sits on its spinner for ever with no error surface
    // and nothing reported. Solid 1's `createResource` propagated a rejected
    // read to the app's error boundary, so the user at least saw the error
    // page; keeping that failure visible is what this restores.
    //
    // It reuses the load-failure copy rather than inventing a second message:
    // from the user's side "the repository would not load" and "the project
    // would not load" are the same event, and `ProjectLoadStates` already
    // renders this one. `error` runs in the same writable scope as `effect`,
    // so setting state here is legal.
    //
    // Reachable in production via `getProjectRepository()`'s dynamic imports
    // -- a chunk that 404s after a redeploy is the realistic trigger.
    error: () => {
      setState((draft) => {
        draft.loading = false;
        draft.notFound = false;
        draft.error = "Something went wrong while loading this project.";
      });
    },
  });

  return {
    state,
    dispatch: (commands) => session?.dispatch(commands),
    beginGesture: (options) => session?.beginGesture(options),
    beginPreview: (commands) => session?.beginPreview(commands),
    committedProject: () => session?.committedProject ?? null,
    previewOpen: () => (session?.activePreview ?? null) !== null,
    undo: () => session?.undo(),
    redo: () => session?.redo(),
    retry: () => session?.autosave.retry(),
    proposalTarget: () => (session ? assistantProposalTarget(session) : undefined),
    onEdit(listener) {
      editListeners.add(listener);
      return () => {
        editListeners.delete(listener);
      };
    },
    onRemoteChange(listener) {
      remoteListeners.add(listener);
      return () => {
        remoteListeners.delete(listener);
      };
    },
    onNotice(listener) {
      noticeListeners.add(listener);
      return () => {
        noticeListeners.delete(listener);
      };
    },
  };
}
