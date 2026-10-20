// The searchable `?` mapping guide, generated from the shortcut registry.

import { For, type JSX, Show } from "@solidjs/web";
import { createMemo, createSignal, createUniqueId, onSettled } from "solid-js";
import { type Analytics, analytics as defaultAnalytics } from "../analytics";
import { detectPlatform, type ShortcutPlatform } from "./keys";
import {
  isInContext,
  resolveContexts,
  type ShortcutActionId,
  type ShortcutDefinition,
  shortcutLabels,
  shortcutSections,
} from "./registry";
import type { ShortcutContext } from "./types";
import { SHORTCUT_GROUP_LABELS } from "./types";
import { useShortcutScope } from "./useShortcutScope";
import "./ShortcutGuide.css";

export interface ShortcutGuideProps {
  /** Contexts active behind the guide, so it can filter to what applies now. */
  readonly contexts: readonly ShortcutContext[];
  /** Whether an action has an enabled handler right now. Defaults to unknown-as-enabled. */
  readonly isEnabled?: (id: ShortcutActionId) => boolean;
  readonly platform?: ShortcutPlatform;
  /** Defaults to the application's singleton; injectable for tests. */
  readonly analytics?: Analytics;
  onClose(): void;
}

/** The guide is a modal: only `dialog` keys reach it. */
const GUIDE_CONTEXTS: readonly ShortcutContext[] = ["dialog"];

/** Whether a query matches an action name or one of its key combinations. */
function matchesQuery(
  shortcut: ShortcutDefinition,
  labels: readonly string[],
  query: string,
): boolean {
  if (query === "") return true;
  const needle = query.toLowerCase();
  if (shortcut.label.toLowerCase().includes(needle)) return true;
  if (shortcut.description.toLowerCase().includes(needle)) return true;
  return labels.some((label) => label.toLowerCase().includes(needle));
}

/** The one-line Ableton note `KEY-02` requires for every mapping. */
function abletonNote(shortcut: ShortcutDefinition): string {
  const parity = shortcut.ableton;
  if (parity.kind === "follows") {
    return `Same as Ableton Live (${parity.abletonKeys}).`;
  }
  if (parity.kind === "differs") {
    return `Live uses ${parity.abletonKeys}. ${parity.reason}`;
  }
  return `Groove addition. ${parity.reason}`;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The PRD `KEY-02` keyboard mapping guide.
 *
 * Every row is generated from the `KEY-01` registry — nothing here restates a
 * key combination — so the guide reflects the current platform's labels, the
 * contexts active behind it, and which actions actually have a handler.
 *
 * `Escape` is not compared here: it is `view.close_surface` in the registry,
 * which the guide registers as a modal shortcut scope (GRV-186), dispatched by
 * the same controller as every other shortcut. Being modal, the scope hides
 * every surface behind the guide, so nothing under it hears a key while it is
 * open and none of them has to know it is. Focus is captured on open and
 * restored on close.
 */
export default function ShortcutGuide(props: ShortcutGuideProps): JSX.Element {
  const titleId = createUniqueId();
  const instructionsId = createUniqueId();
  const [query, setQuery] = createSignal("");
  const [contextOnly, setContextOnly] = createSignal(false);
  let dialog: HTMLDivElement | undefined;
  let search: HTMLInputElement | undefined;

  useShortcutScope({
    modal: true,
    handlers: () => ({ "view.close_surface": { run: () => props.onClose() } }),
    contexts: () => GUIDE_CONTEXTS,
    analytics: props.analytics,
  });

  const platform = createMemo(() => props.platform ?? detectPlatform());
  const resolved = createMemo(() => resolveContexts(props.contexts));

  const available = (shortcut: ShortcutDefinition): boolean =>
    isInContext(shortcut, resolved()) && (props.isEnabled?.(shortcut.id) ?? true);

  const sections = createMemo(() => {
    const currentQuery = query().trim();
    return shortcutSections().flatMap((section) => {
      const rows = section.shortcuts
        .map((shortcut) => ({
          shortcut,
          labels: shortcutLabels(shortcut, platform()),
          available: available(shortcut),
        }))
        .filter(
          (row) =>
            matchesQuery(row.shortcut, row.labels, currentQuery) &&
            (!contextOnly() || row.available),
        );
      return rows.length > 0 ? [{ group: section.group, rows }] : [];
    });
  });

  // `onSettled` runs once the first render has settled, with `ref` already
  // assigned — the same point 1.x's `onMount` gave us for the focus move, and
  // nothing in this component touches focus before it, so `document.activeElement`
  // is still the element the guide was opened from. The restore rides the
  // returned cleanup rather than a nested `onCleanup`, which is how Solid 2
  // pairs teardown with settle-time setup.
  onSettled(() => {
    const previous = document.activeElement;
    search?.focus();
    (props.analytics ?? defaultAnalytics).logFeatureFirstUse("shortcut_guide");
    return () => {
      // `KEY-02`: closing "restores focus to the prior editor element".
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus();
      }
    };
  });

  /** Keeps Tab inside the modal (`KEY-02`: "traps focus while modal"). */
  function trapFocus(event: KeyboardEvent): void {
    if (event.key !== "Tab" || !dialog) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div class="shortcut-guide-backdrop">
      <div
        class="shortcut-guide"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={instructionsId}
        ref={dialog}
        onKeyDown={trapFocus}
      >
        <header class="shortcut-guide-header">
          <h2 class="shortcut-guide-title" id={titleId}>
            Keyboard shortcuts
          </h2>
          <p class="shortcut-guide-instructions" id={instructionsId}>
            Search by action or key combination. Press Escape to close and return to the
            editor.
          </p>
          <div class="shortcut-guide-filters">
            <input
              class="shortcut-guide-search"
              type="search"
              aria-label="Search shortcuts"
              placeholder="Search shortcuts"
              value={query()}
              ref={search}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
            <label class="shortcut-guide-context-filter">
              <input
                type="checkbox"
                checked={contextOnly()}
                onChange={(event) => setContextOnly(event.currentTarget.checked)}
              />
              Only shortcuts available here
            </label>
          </div>
        </header>
        {/* A tab stop of its own (#76): the list scrolls, and nothing in it is
            focusable, so without one a keyboard could never scroll it. */}
        <section class="shortcut-guide-sections" aria-label="Shortcuts" tabindex={0}>
          <For each={sections()}>
            {(section) => (
              <section class="shortcut-guide-section">
                <h3 class="shortcut-guide-section-title">
                  {SHORTCUT_GROUP_LABELS[section.group]}
                </h3>
                <ul class="shortcut-guide-list">
                  <For each={section.rows}>
                    {(row) => (
                      <li
                        class="shortcut-guide-row"
                        data-action={row.shortcut.id}
                        data-available={String(row.available)}
                      >
                        <div class="shortcut-guide-action">
                          <span class="shortcut-guide-action-label">
                            {row.shortcut.label}
                          </span>
                          <span class="shortcut-guide-action-description">
                            {row.shortcut.description}
                          </span>
                          <span class="shortcut-guide-ableton">
                            {abletonNote(row.shortcut)}
                          </span>
                          <Show when={row.shortcut.browserConflict}>
                            {(conflict) => (
                              <span class="shortcut-guide-browser-note">
                                Browser conflict: {conflict().note}
                              </span>
                            )}
                          </Show>
                        </div>
                        <div class="shortcut-guide-keys">
                          <For each={row.labels}>{(label) => <kbd>{label}</kbd>}</For>
                          <Show when={!row.available}>
                            <span class="shortcut-guide-unavailable">
                              Not available here
                            </span>
                          </Show>
                        </div>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            )}
          </For>
          <Show when={sections().length === 0}>
            <p class="shortcut-guide-empty">No shortcuts match your search.</p>
          </Show>
        </section>
        <footer class="shortcut-guide-footer">
          <button
            type="button"
            class="shortcut-guide-close"
            onClick={() => props.onClose()}
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
