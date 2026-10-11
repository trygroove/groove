// The vocabulary of the PRD `KEY-01` shortcut registry: where a shortcut is
// allowed to act, and how the mapping guide groups it.
//
// These are deliberately small closed sets. A context is a *surface that is
// currently active*, not a component instance, so context resolution stays
// deterministic: a shortcut acts on the focused editor or the current
// selection and can never silently target hidden content.

/**
 * Surfaces a shortcut can be valid in.
 *
 * `global` is active whenever the application is: `ShortcutController` adds it
 * to every resolution. `dialog` is special — while it is active it is the
 * *only* context considered, so an open modal or menu receives normal typing
 * behavior and cannot have an editor shortcut fire underneath it.
 *
 * `sequence_editor` is the one surface that is a window over the page without
 * being a `dialog` (`UI-001`). It is `role="dialog"` to a screen reader —
 * which is an accessibility fact about a window over content — but the
 * transport, the note shortcuts and the view switches all have to keep working
 * while a producer programs a clip in it, and `dialog` is precisely the
 * context that would stop them. The two words are unrelated: one describes
 * what the surface *is*, the other what the keyboard does while it is open.
 */
export const SHORTCUT_CONTEXTS = [
  "global",
  "editor",
  "arrangement",
  "step_editor",
  "piano_roll",
  "automation_lane",
  "timeline",
  "selection",
  "sequence_editor",
  "dialog",
  "library",
  "gesture",
  "loop_brace",
  "clip_list",
  "value_field",
  "export_tracks",
  "resize_edge",
  "composer",
  "assistant_ask",
] as const;
export type ShortcutContext = (typeof SHORTCUT_CONTEXTS)[number];

/**
 * Contexts that exist only while one element has keyboard focus. A key such as
 * `Left` already means something to the wider editor (`track.move_left`), so
 * while the focused element claims it the focused element wins; the wider
 * meaning is untouched everywhere else. Unlike `dialog` nothing else is
 * suppressed: the transport and every other mapping keep working.
 *
 * Only one element has focus, so no two of these are ever live together, and
 * two of them may claim the same key: `resize_edge` (a focused resize edge,
 * such as the assistant panel's, #849) takes every arrow, as `loop_brace` and
 * `value_field` each take some. `composer` is the assistant's message box
 * (GRV-26), where Enter sends. `assistant_ask` is focus in the assistant's
 * panel anywhere but a text box or its resize edge while it is asking a
 * question (GRV-42), where `1`-`8` pick an answer in place of the view keys.
 */
export const FOCUS_CONTEXTS: readonly ShortcutContext[] = [
  "loop_brace",
  "clip_list",
  "value_field",
  "resize_edge",
  "composer",
  "assistant_ask",
];

/**
 * Contexts of a surface open over the editor (ARR-010). After any focus
 * context, they outrank the editor behind them for the keys they claim: while
 * the piano roll is open its arrows move notes, rather than also moving or
 * selecting tracks (`track.move_left`, `track.select_previous`) underneath.
 */
export const OVERLAY_CONTEXTS: readonly ShortcutContext[] = ["piano_roll"];

/**
 * Contexts a modal may keep alive beside `dialog`. `dialog` alone suppresses
 * every other context; a modal that owns keys of its own (the library, `LIB-010`)
 * activates `dialog` *and* one of these, so its keys fire inside it and nowhere
 * else, while every other modal keeps the plain `dialog` behaviour.
 * `export_tracks` is the Export dialog's track list (`EXP-004`), live only while
 * that list has keyboard focus.
 */
export const MODAL_OWNED_CONTEXTS: readonly ShortcutContext[] = [
  "library",
  "export_tracks",
];

/** The context that suppresses every other one while it is active. */
export const MODAL_CONTEXT: ShortcutContext = "dialog";

/** The context that is always active. */
export const AMBIENT_CONTEXT: ShortcutContext = "global";

/**
 * The PRD `KEY-02` guide sections, in the order the guide renders them.
 *
 * Groups with no shortcuts yet (`mixer_devices`, `browser`) are declared here
 * rather than added later: the section list is the published shape of the
 * guide, and the Phase 1 tasks that own those surfaces add entries to an
 * existing group instead of inventing one.
 */
export const SHORTCUT_GROUPS = [
  "transport",
  "global_editing",
  "arrangement",
  "clips_notes",
  "automation",
  "mixer_devices",
  "browser",
  "navigation",
] as const;
export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number];

/** Human-readable section titles for the guide. */
export const SHORTCUT_GROUP_LABELS: Record<ShortcutGroup, string> = {
  transport: "Transport",
  global_editing: "Global Editing",
  arrangement: "Arrangement",
  clips_notes: "Clips and Notes",
  automation: "Automation",
  mixer_devices: "Mixer and Devices",
  browser: "Browser",
  navigation: "Navigation",
};

/**
 * How a mapping relates to Ableton Live 12, which `KEY-01` takes as its
 * baseline.
 *
 * `differs` always carries the Live combination it deviates from *and* why, so
 * "browser conflicts and Groove deviations are documented rather than
 * handled inconsistently" is a property of the data, not of a wiki page that
 * can drift. `solid_groove` claims no Live baseline at all rather than
 * inventing one.
 */
export type AbletonParity =
  | { readonly kind: "follows"; readonly abletonKeys: string }
  | {
      readonly kind: "differs";
      readonly abletonKeys: string;
      readonly reason: string;
    }
  | { readonly kind: "solid_groove"; readonly reason: string };

/**
 * A browser combination Groove deliberately takes over.
 *
 * Distinct from `RESERVED_CHORDS` in `registry.ts`: those the browser or OS
 * keeps for itself and the registry may never claim. These are ones a page can
 * cancel, where the PRD mapping wins — recorded so the override is a decision
 * with a reason attached rather than an accident.
 */
export interface BrowserConflict {
  readonly keys: string;
  readonly note: string;
}
