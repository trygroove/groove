import { createContext, onCleanup, useContext } from "solid-js";
import type { Analytics } from "../analytics";
import type { ShortcutPlatform } from "./keys";
import type { ShortcutActionId } from "./registry";
import {
  ShortcutController,
  type ShortcutHandlers,
  type ShortcutScopeOptions,
} from "./ShortcutController";
import type { ShortcutContext } from "./types";

/**
 * The app's one `ShortcutController` (GRV-186), provided by `ShortcutRoot` at
 * the top of `App`. A test can provide its own to pin the platform or the
 * analytics instance.
 */
export const ShortcutRootContext = createContext<ShortcutController | null>(null);

let fallback: ShortcutController | undefined;

/**
 * The controller a scope rendered with no `ShortcutRoot` above it uses: one per
 * page, created on first use and listening on the window from then on. In the
 * app every surface is under `ShortcutRoot`, so this only serves a component
 * rendered on its own (a component test); it is still one controller, never one
 * per surface.
 */
function fallbackRoot(): ShortcutController {
  if (!fallback) {
    fallback = new ShortcutController({});
    fallback.attach(window);
  }
  return fallback;
}

/** The controller scopes register on here. */
export function useShortcutRoot(): ShortcutController {
  return useContext(ShortcutRootContext) ?? fallbackRoot();
}

export interface ShortcutScopeHookOptions {
  /** Read per event, so a surface can register handlers reactively. */
  handlers: () => ShortcutHandlers;
  /** The contexts this surface acts in right now; `global` is added automatically. */
  contexts: () => readonly ShortcutContext[];
  /** A dialog: hides every scope mounted before it while it is mounted. */
  modal?: boolean;
  /** Where this scope's `shortcut_used` goes; defaults to the root's. */
  analytics?: Analytics;
}

/** What a surface gets back: labels and guide filtering for its own scope. */
export interface ShortcutScopeHandle {
  readonly platform: ShortcutPlatform;
  activeContexts(): readonly ShortcutContext[];
  isEnabled(id: ShortcutActionId): boolean;
}

/**
 * Registers a surface's shortcuts on the app's one controller for the lifetime
 * of the calling component (PRD `KEY-01`, GRV-186).
 *
 * The scope registers as the component body runs, not when it settles, so a
 * child surface is always newer than the parent that renders it: a focused
 * name field or an open picker inside the editor gets Escape first, and the
 * editor only when that surface stands down or goes. It unregisters when the
 * component is disposed.
 */
export function useShortcutScope(options: ShortcutScopeHookOptions): ShortcutScopeHandle {
  const root = useShortcutRoot();
  const scopeOptions: ShortcutScopeOptions = {
    handlers: options.handlers,
    contexts: options.contexts,
    modal: options.modal,
    analytics: options.analytics,
  };
  const scope = root.addScope(scopeOptions);
  onCleanup(() => scope.dispose());
  return {
    platform: root.platform,
    activeContexts: () => scope.activeContexts(),
    isEnabled: (id) => scope.isEnabled(id),
  };
}
