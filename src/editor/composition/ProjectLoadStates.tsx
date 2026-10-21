import { Match, Switch } from "solid-js";
import ProjectNotFound from "../../components/ProjectNotFound";
import TapeLoader from "../../components/TapeLoader";

export interface ProjectLoadStatesProps {
  readonly loading: boolean;
  readonly notFound: boolean;
  readonly error: string | null;
}

/**
 * The editor's three non-happy-path branches: loading, not-found, and a
 * generic load error with a retry/back-out. `EditorView` renders this while
 * `project()` has not resolved (or never does); once a project loads,
 * `EditorView` renders its own tree instead — the two are mutually exclusive
 * `Match` branches of the same parent `Switch`, so this component owns its
 * own `Switch` over the same three conditions to keep that exclusivity and
 * per-branch reactivity intact.
 *
 * Split out of `EditorView` (`REFACTOR-001`) — a pure move of the first
 * three `<Match>` branches of its top-level `<Switch>`.
 */
export default function ProjectLoadStates(props: ProjectLoadStatesProps) {
  return (
    <Switch>
      <Match when={props.loading}>
        <TapeLoader label="Loading project" />
      </Match>
      <Match when={props.notFound}>
        <ProjectNotFound />
      </Match>
      <Match when={props.error}>
        <div class="project-error">
          <p class="project-error-message">{props.error}</p>
          <div class="project-error-actions">
            <button
              type="button"
              class="project-error-retry"
              onClick={() => location.reload()}
            >
              Try again
            </button>
            <a class="project-error-home" href="/projects">
              Back to your projects
            </a>
          </div>
        </div>
      </Match>
    </Switch>
  );
}
