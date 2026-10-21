// Moving around the editor: its views, zoom and scroll, and the shortcut guide.

import { type AnalyticsEventDefinition, enumParam } from "./params";

/**
 * The editor's views (`UI-001`), as `view_changed`'s `view`, in the order of
 * their keys.
 *
 * A view is a low-cardinality *place in the editor*, not a surface: `SURFACES`
 * stays `landing / dashboard / editor`, because every one of these is the
 * editor. `src/editor/composition/editorViews.ts` builds the view table — label, URL
 * segment, dock order — over this list, so the analytics vocabulary and the
 * addresses cannot drift apart.
 */
export const EDITOR_VIEWS = [
  "arrangement",
  "sequence",
  "instrument",
  "library",
  "mixer",
] as const;
export type EditorViewName = (typeof EDITOR_VIEWS)[number];

/**
 * How a view was reached. The entrypoints must stay equivalent, so the one
 * that was used is the interesting half of the event: `dock` is the floating
 * tab bar, `keyboard` is `1`-`5`, and `url` is everything the address bar does
 * on its own — the back button, a deep link followed within the session, a
 * restored session. `arrangement` is opening a clip from the timeline (a
 * double-click, or `Enter` on a selected clip), `slot` is pressing a sample
 * slot, which aims the Library at it, `empty_screen` is the fix button on
 * a view that had nothing to show, and `library_insert` is the Library's
 * Insert button, which inserts and goes back (`UI-002`). `reveal` is the
 * editor moving itself to show a control (`UI-004`): a proposal line followed
 * to the control it changes, or the view it left restored on Cancel.
 */
export const VIEW_CHANGE_SOURCES = [
  "dock",
  "keyboard",
  "url",
  "arrangement",
  "slot",
  "empty_screen",
  "library_insert",
  "reveal",
] as const;
export type ViewChangeSource = (typeof VIEW_CHANGE_SOURCES)[number];

/** Navigation `feature_first_use` keys (see `FEATURE_KEYS`). */
export const NAVIGATION_FEATURE_KEYS = ["shortcut_guide"] as const;

/** Navigation shortcut actions, as `shortcut_used`'s `action_id` (see `SHORTCUT_ACTION_IDS`). */
export const NAVIGATION_SHORTCUT_ACTION_IDS = [
  "view.zoom_to_selection",
  "view.zoom_back",
  "view.zoom_to_arrangement",
  "view.scroll_to_playhead",
  "view.zoom_in",
  "view.zoom_out",
  "view.show_arrangement",
  "view.show_sequence",
  "view.show_instrument",
  "view.show_library",
  "view.show_mixer",
  "arrangement.open_clip",
  "view.close_surface",
  "help.shortcut_guide",
  "track.select_previous",
  "track.select_next",
] as const;

export const NAVIGATION_EVENTS = {
  view_changed: {
    phase: 1,
    owners: ["UI-001", "UI-002"],
    // Which view, and how it was reached. The editor is one job at a time
    // (UI-001), so how often a producer switches — and whether the dock or the
    // keyboard is what they reach for — is the measure that says whether the
    // bet paid off. Both parameters are closed sets; nothing user-entered can
    // reach this event, since `view` is an address segment and `via` is an
    // entrypoint.
    params: {
      view: enumParam(EDITOR_VIEWS),
      via: enumParam(VIEW_CHANGE_SOURCES),
    },
  },
} as const satisfies Record<string, AnalyticsEventDefinition>;
