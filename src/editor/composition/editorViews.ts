import {
  EDITOR_VIEWS,
  type EditorViewName,
  type ViewChangeSource,
} from "../../analytics/catalog";

/**
 * The editor's views, and the addresses they live at (`UI-001`, `UI-002`).
 *
 * The editor does one job at a time, and which one you are on is **the URL**,
 * not a signal — so a deep link opens that view, the back button moves between
 * them, and a reload returns you to the one you left.
 *
 * The view names come from `src/analytics/catalog.ts` (as
 * `instrumentKinds.ts` takes `InstrumentTypeKey` from there): the set is a
 * published analytics contract, so a view cannot be added without deciding how
 * it is measured.
 */

export type { EditorViewName, ViewChangeSource };
export { EDITOR_VIEWS };

export interface EditorViewSpec {
  /** Which view this is. Spelled `view`, not `name`: a `.name` here is a
   * *user-authored* name, which the replay-privacy guards scan for. */
  readonly view: EditorViewName;
  /** The dock's visible text, and so the link's accessible name. */
  readonly label: string;
  /** The path segment under `/projects/:id`. Empty for the arrangement, which
   * a project opens on, so the link copied on arrival is the project's. */
  readonly segment: string;
  /** The shortcut that switches to this view, for the dock's tooltip. */
  readonly actionId: `view.show_${EditorViewName}`;
}

/** The views, in dock order: the order they are offered and switched by key. */
export const EDITOR_VIEW_SPECS: readonly EditorViewSpec[] = [
  {
    view: "arrangement",
    label: "Arrangement",
    segment: "",
    actionId: "view.show_arrangement",
  },
  {
    view: "sequence",
    label: "Sequence",
    segment: "sequence",
    actionId: "view.show_sequence",
  },
  {
    view: "instrument",
    label: "Instrument",
    segment: "instrument",
    actionId: "view.show_instrument",
  },
  {
    view: "library",
    label: "Library",
    segment: "library",
    actionId: "view.show_library",
  },
  { view: "mixer", label: "Mixer", segment: "mixer", actionId: "view.show_mixer" },
];

/** What a project opens on, and what an address we cannot read falls back to. */
export const DEFAULT_EDITOR_VIEW: EditorViewName = "arrangement";

export function editorViewSpec(view: EditorViewName): EditorViewSpec {
  const spec = EDITOR_VIEW_SPECS.find((candidate) => candidate.view === view);
  if (!spec) throw new TypeError(`Unknown editor view "${view}"`);
  return spec;
}

/** The address one view of one project lives at. */
export function editorViewPath(projectId: string, view: EditorViewName): string {
  const { segment } = editorViewSpec(view);
  return segment ? `/projects/${projectId}/${segment}` : `/projects/${projectId}`;
}

/** `/projects/<id>/<segment>`, and nothing else. */
const PROJECT_VIEW_PATTERN = /^\/projects\/[^/]+\/([^/]+)\/?$/;

/**
 * A project route's trailing segment, as a view. Deliberately total: an address
 * this module does not recognise shows the arrangement rather than an empty
 * editor. Unreachable through the router, which matches only the three
 * registered paths — reachable if the table and this module ever drift.
 */
export function editorViewFromPath(pathname: string): EditorViewName {
  const segment = PROJECT_VIEW_PATTERN.exec(pathname)?.[1];
  if (segment === undefined) return DEFAULT_EDITOR_VIEW;
  return (
    EDITOR_VIEW_SPECS.find((spec) => spec.segment === segment)?.view ??
    DEFAULT_EDITOR_VIEW
  );
}

/**
 * The non-empty path segments, for the route table's `matchFilters`.
 *
 * The views are **one** route (`/projects/:id/:view?`), not three: the
 * router unmounts a route's component when it leaves it, and remounting the
 * editor on every switch would reload the project and rebuild the audio graph —
 * the one thing switching views must never do. A filter is what keeps that
 * single route from also matching `/projects/:id/anything`.
 */
export const EDITOR_VIEW_SEGMENTS: readonly string[] = EDITOR_VIEW_SPECS.map(
  (spec) => spec.segment,
).filter((segment) => segment !== "");
