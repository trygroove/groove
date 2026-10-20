// The one place a keyboard event becomes an action (PRD `KEY-01`).
//
// Framework-free on purpose, like `EditorSession`: the whole dispatch rule set
// — context resolution, text-entry suppression, disabled actions, default
// suppression, and analytics — is testable against plain event objects, and
// `useShortcutScope.ts` is the thin Solid adapter over it.
//
// The app runs ONE controller (GRV-186). Surfaces do not get a controller of
// their own; each registers a *scope* on it: handlers plus the contexts they
// act in. A press runs in the most recently registered scope that has an
// enabled handler for the matched action, and only there, so two surfaces that
// both claim Escape can never both close. A `modal` scope hides every scope
// registered before it until it goes, the same way the `dialog` context hides
// every other context inside one scope.
//
// Handlers never log. `shortcut_used` is emitted here with the `action_id` the
// *registry* carries, so no handler can report a different action than the one
// the user actually pressed, and a new shortcut cannot ship unmeasured.

import { type Analytics, analytics as defaultAnalytics } from "../analytics";
import type { ShortcutPlatform } from "./keys";
import { detectPlatform } from "./keys";
import {
  matchShortcut,
  type ShortcutActionId,
  type ShortcutDefinition,
} from "./registry";
import { isTextEntry as defaultIsTextEntry, focusPressesKey } from "./textEntry";
import type { ShortcutContext } from "./types";

/** What a surface registers for one action. */
export interface ShortcutHandler {
  run(): void;
  /** Defaults to enabled. A disabled action does nothing at all. */
  isEnabled?(): boolean;
}

export type ShortcutHandlers = Partial<Record<ShortcutActionId, ShortcutHandler>>;

/** Why a key press did not run an action. Returned for tests and debugging. */
export type ShortcutRejection =
  | "no_match"
  | "composing"
  | "text_entry"
  | "focused_control"
  | "no_handler"
  | "disabled"
  | "repeat";

export interface ShortcutDispatch {
  readonly shortcut: ShortcutDefinition | null;
  readonly ran: boolean;
  readonly rejected: ShortcutRejection | null;
}

/** What one surface registers on the controller (GRV-186). */
export interface ShortcutScopeOptions {
  /** Read per event, so a surface can register handlers reactively. */
  handlers: () => ShortcutHandlers;
  /**
   * The contexts this scope acts in right now; `global` is added
   * automatically. A key is matched against each scope's own contexts, so one
   * surface's contexts never change what a key means to another.
   */
  contexts: () => readonly ShortcutContext[];
  /**
   * A modal surface (a dialog): while it is registered, every scope registered
   * before it is hidden, so nothing underneath has to track that it is open.
   */
  modal?: boolean;
  /** Where this scope's `shortcut_used` goes; defaults to the controller's. */
  analytics?: Analytics;
}

/** A registered scope. `dispose` unregisters it; calling it twice is harmless. */
export interface ShortcutScope {
  /** The contexts this scope reports right now. */
  activeContexts(): readonly ShortcutContext[];
  /** Whether this scope has an enabled handler for an action. */
  isEnabled(id: ShortcutActionId): boolean;
  dispose(): void;
}

export interface ShortcutControllerOptions {
  /**
   * A scope registered at construction, for a controller that serves one
   * surface (the tests of the dispatch rules). The app's root controller
   * starts with none and takes scopes through `addScope`.
   */
  handlers?: () => ShortcutHandlers;
  contexts?: () => readonly ShortcutContext[];
  platform?: ShortcutPlatform;
  analytics?: Analytics;
  isTextEntry?: (target: EventTarget | null) => boolean;
}

const NO_MATCH: ShortcutDispatch = {
  shortcut: null,
  ran: false,
  rejected: "no_match",
};

interface ScopeEntry {
  readonly options: ShortcutScopeOptions;
}

/** A matched shortcut a scope would run, or why it would not. */
type Resolution =
  | { readonly shortcut: ShortcutDefinition; readonly handler: ShortcutHandler }
  | (ShortcutDispatch & { readonly handler?: undefined });

export class ShortcutController {
  private readonly options: ShortcutControllerOptions;
  readonly platform: ShortcutPlatform;
  /** Registered scopes, oldest first. */
  private scopes: readonly ScopeEntry[] = [];
  /**
   * The key whose current press ran an action, until a fresh press. Its
   * auto-repeats belong to that action wherever focus or context has moved
   * since (#961).
   */
  private heldKey: string | null = null;

  constructor(options: ShortcutControllerOptions) {
    this.options = options;
    this.platform = options.platform ?? detectPlatform();
    if (options.handlers) {
      const contexts = options.contexts ?? (() => []);
      this.addScope({ handlers: options.handlers, contexts });
    }
  }

  /**
   * Registers a surface's handlers and contexts until the returned scope is
   * disposed. The newest scope is consulted first.
   */
  addScope(options: ShortcutScopeOptions): ShortcutScope {
    const entry: ScopeEntry = { options };
    this.scopes = [...this.scopes, entry];
    return {
      activeContexts: () => options.contexts(),
      isEnabled: (id) => handlerEnabled(options.handlers()[id]),
      dispose: () => {
        this.scopes = this.scopes.filter((scope) => scope !== entry);
      },
    };
  }

  /** The scopes a key can reach right now, newest first: down to the newest modal. */
  private visibleScopes(): readonly ScopeEntry[] {
    const visible: ScopeEntry[] = [];
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const scope = this.scopes[i] as ScopeEntry;
      visible.push(scope);
      if (scope.options.modal) break;
    }
    return visible;
  }

  /** The contexts a guide or menu should filter by right now. */
  activeContexts(): readonly ShortcutContext[] {
    const contexts = new Set<ShortcutContext>();
    for (const scope of [...this.visibleScopes()].reverse()) {
      for (const context of scope.options.contexts()) contexts.add(context);
    }
    return [...contexts];
  }

  /** Whether an action currently has an enabled handler in a scope a key can reach. */
  isEnabled(id: ShortcutActionId): boolean {
    return this.visibleScopes().some((scope) =>
      handlerEnabled(scope.options.handlers()[id]),
    );
  }

  /**
   * Resolves one key event against the registry and runs its action.
   *
   * The browser default is suppressed only when the action would run: a
   * shortcut that matched but had no handler, or a disabled one, or one typed
   * into a text field, leaves the event exactly as it found it rather than
   * silently eating a key. An auto-repeat of a non-repeatable action is still
   * ignored, but its default is suppressed like the first press's, so holding
   * the key never falls through to the focused control. That holds after the
   * action has moved focus or closed its surface too: Enter inserting from the
   * library returns focus to the slot button, and a held Enter's next repeat
   * must not press it and reopen the library.
   */
  handleKeyDown(event: KeyboardEvent): ShortcutDispatch {
    if (!event.repeat) this.heldKey = null;
    const holding = event.repeat && this.heldKey === event.key;
    const dispatch = this.dispatch(event);
    if (dispatch.ran) {
      if (!event.repeat && dispatch.shortcut?.preventDefault !== false) {
        this.heldKey = event.key;
      }
      return dispatch;
    }
    if (!holding) return dispatch;
    if (!event.defaultPrevented) event.preventDefault();
    return { shortcut: dispatch.shortcut, ran: false, rejected: "repeat" };
  }

  /**
   * Runs the press in the newest reachable scope that would run it, and only
   * there. When none would, the newest scope's reason for standing down is the
   * answer (a matched shortcut's reason ahead of a plain miss).
   */
  private dispatch(event: KeyboardEvent): ShortcutDispatch {
    let rejection: ShortcutDispatch = NO_MATCH;
    for (const scope of this.visibleScopes()) {
      const resolved = this.resolve(event, scope.options);
      if (!resolved.handler) {
        if (rejection.shortcut === null) rejection = resolved;
        continue;
      }
      const { shortcut, handler } = resolved;
      // Past this point the press would run, so its default is the action's to
      // suppress — an ignored auto-repeat included. Leaving a held Space or
      // Enter's repeats alone lets the browser click the focused button (#961).
      if (shortcut.preventDefault !== false) event.preventDefault();
      if (event.repeat && shortcut.repeatable !== true) {
        return { shortcut, ran: false, rejected: "repeat" };
      }

      handler.run();
      // Once per press, whichever scope ran it.
      (scope.options.analytics ?? this.options.analytics ?? defaultAnalytics).log(
        "shortcut_used",
        { action_id: shortcut.id },
      );
      return { shortcut, ran: true, rejected: null };
    }
    return rejection;
  }

  /** What one scope makes of a key: the handler that would run, or why not. */
  private resolve(event: KeyboardEvent, scope: ShortcutScopeOptions): Resolution {
    const shortcut = matchShortcut(event, this.platform, scope.contexts());
    if (!shortcut) return NO_MATCH;

    // A key pressed while an input method is composing is the IME's: the
    // Enter that confirms a Japanese or Chinese candidate must not also send
    // the message (GRV-26). Safari reports that Enter with `isComposing`
    // already false, but with the IME's `keyCode` 229.
    if (isComposing(event)) return { shortcut, ran: false, rejected: "composing" };

    const textEntry = this.options.isTextEntry ?? defaultIsTextEntry;
    if (shortcut.textEntry !== "allowed" && textEntry(event.target)) {
      return { shortcut, ran: false, rejected: "text_entry" };
    }
    // A focused button, toggle or radio takes its own Space and Enter
    // (GRV-54): the browser default presses it, so the shortcut stands down.
    if (shortcut.focusedControl !== "allowed" && focusPressesKey(event.target, event)) {
      return { shortcut, ran: false, rejected: "focused_control" };
    }

    const handler = scope.handlers()[shortcut.id];
    if (!handler) return { shortcut, ran: false, rejected: "no_handler" };
    if (handler.isEnabled?.() === false) {
      return { shortcut, ran: false, rejected: "disabled" };
    }
    return { shortcut, handler };
  }

  /**
   * Listens on a target until the returned function is called.
   *
   * The app attaches one controller (GRV-186), but a test or a stray
   * provider-less surface can attach another, so one press can reach
   * several. It runs one action, not one per controller: the controllers on a
   * target share a single listener that offers the press to the one attached
   * last first, the surface opened most recently and so the one on top, and
   * stops at the first that runs it (GRV-148). A controller with no enabled
   * handler for the key passes it down to the one below.
   *
   * One listener is also what makes the decision see the page as it was when
   * the key went down: a browser runs a microtask checkpoint between two
   * listeners of one event, so with a listener each, a surface the first one
   * closed was already gone from the document when the next one asked.
   */
  attach(target: EventTarget): () => void {
    let layer = layers.get(target);
    if (!layer) {
      const controllers: ShortcutController[] = [];
      const listener = (event: Event) =>
        dispatchToLayer(controllers, event as KeyboardEvent);
      target.addEventListener("keydown", listener);
      layer = { controllers, listener };
      layers.set(target, layer);
    }
    const { controllers } = layer;
    controllers.push(this);
    return () => {
      const index = controllers.lastIndexOf(this);
      if (index === -1) return;
      controllers.splice(index, 1);
      if (controllers.length > 0 || layers.get(target) !== layer) return;
      target.removeEventListener("keydown", layer.listener);
      layers.delete(target);
    };
  }

  /** Forgets the held key: a fresh press elsewhere means this one was let go. */
  releaseHeldKey(): void {
    this.heldKey = null;
  }
}

/** The controllers attached to one target, oldest first, and their listener. */
interface Layer {
  readonly controllers: ShortcutController[];
  readonly listener: (event: Event) => void;
}

const layers = new WeakMap<EventTarget, Layer>();

/**
 * Offers one press to a target's controllers, newest first, until one runs it.
 *
 * A controller that ignored an auto-repeat because it ran the press (or
 * because its action is not repeatable) owns the key too, so a repeat never
 * falls through to an action under it.
 */
function dispatchToLayer(
  controllers: readonly ShortcutController[],
  event: KeyboardEvent,
) {
  const stack = [...controllers];
  if (!event.repeat) for (const controller of stack) controller.releaseHeldKey();
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const dispatch = stack[index].handleKeyDown(event);
    if (dispatch.ran || dispatch.rejected === "repeat") return;
  }
}

function handlerEnabled(handler: ShortcutHandler | undefined): boolean {
  return handler !== undefined && handler.isEnabled?.() !== false;
}

/** Whether a key event belongs to an input method's composition. */
function isComposing(event: KeyboardEvent): boolean {
  return event.isComposing === true || event.keyCode === 229;
}
