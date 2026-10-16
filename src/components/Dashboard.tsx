// The signed-in producer's dashboard: their project list and New Project.

import { useNavigate } from "@solidjs/router";
import { HiSolidArrowPath, HiSolidPlus } from "solid-icons/hi";
import { createEffect, createMemo, createSignal, Match, Show, Switch } from "solid-js";
import { type Analytics, analytics as defaultAnalytics } from "../analytics/analytics";
import { projectAgeBucket } from "../analytics/buckets";
import { useAuth } from "../auth/AuthProvider";
import { duplicateProject } from "../domain/duplicateProject";
import type { ProjectMetadata } from "../domain/entities";
import type { ProjectId } from "../domain/ids";
import { createStarterProject } from "../editor/starterProject";
import { getProjectRepository } from "../projectRepositoryClient";
import { LogInButton, SignOutButton } from "./AccountControls";
import type { ProjectActionResult } from "./ProjectList";
import ProjectList from "./ProjectList";
import TapeLoader from "./TapeLoader";
import UpgradeAccountPrompt from "./UpgradeAccountPrompt";

interface ProjectsState {
  loading: boolean;
  error: string | null;
  data: ProjectMetadata[];
}

/** What the project-listing effect's tracked half hands to its apply half. */
interface ProjectsListing {
  /** The signed-in user whose projects to list, if there is one. */
  id: string | undefined;
  /** Carried for its dependency alone: bumping it re-runs the fetch. */
  retry: number;
  /** A different user from the last run: their first fetch shows the loader. */
  isNewUser: boolean;
}

export interface DashboardProps {
  /** Overridden in tests; defaults to the app-wide analytics boundary. */
  analytics?: Analytics;
}

export default function Dashboard(props: DashboardProps = {}) {
  const analytics = props.analytics ?? defaultAnalytics;
  const auth = useAuth();
  const navigate = useNavigate();
  const userId = createMemo(() => auth.user?.uid);
  const [creating, setCreating] = createSignal(false);
  const [createError, setCreateError] = createSignal<string | null>(null);
  const [projectsState, setProjectsState] = createSignal<ProjectsState>({
    loading: true,
    error: null,
    data: [],
  });
  // Bumped to force the effect below to re-run and retry.
  const [retryCount, setRetryCount] = createSignal(0);

  // Split effect. Both reactive reads — the signed-in user and the retry
  // counter — stay in the compute half, which is the only half Solid 2
  // tracks; `retryCount()` is read for its dependency alone, and a fresh
  // object is returned every run so bumping the counter always re-fetches.
  // The fetch and every `setProjectsState` write live in the apply half,
  // where a write is sanctioned, and the cancellation that used to be a
  // nested `onCleanup` is the cleanup that half returns.
  //
  // `isNewUser` is keyed on the user, not on the effect's first run: sign-in
  // usually resolves after the dashboard mounts, so the run that first sees
  // an id is the second one, and keying on the first run left `loading`
  // false with an empty list -- the "No projects yet" state -- until the
  // listing arrived.
  createEffect<ProjectsListing>(
    (previous) => ({
      id: userId(),
      // Read for its dependency alone; the apply half never destructures it.
      // The property *is* the read -- delete the line and the "Try again"
      // button silently stops retrying. `Dashboard.test.tsx`'s "retries the
      // listing when 'Try again' is clicked" is what catches that.
      retry: retryCount(),
      isNewUser: previous?.id !== userId(),
    }),
    ({ id, isNewUser }) => {
      if (!id) {
        setProjectsState({ loading: false, error: null, data: [] });
        return;
      }

      // Only show the full loading state on a user's first fetch. A retry
      // re-runs this same effect, but the dashboard chrome (button, error
      // panel) is already on screen, so swapping back to the loader would
      // just flash the tape deck in and out again for no benefit — the error
      // panel stays up until the retry resolves one way or the other.
      if (isNewUser) {
        setProjectsState({ loading: true, error: null, data: [] });
      }

      let cancelled = false;
      getProjectRepository()
        .then((repository) => repository.listProjects(id))
        .then((projects) => {
          if (cancelled) return;
          setProjectsState({ loading: false, error: null, data: projects });
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          console.error("Error fetching projects:", error);
          setProjectsState({
            loading: false,
            error: "Something went wrong while loading your projects.",
            data: [],
          });
        });

      return () => {
        cancelled = true;
      };
    },
  );

  const retryFetchProjects = () => setRetryCount((count) => count + 1);

  /** Creates the `FND-009` starter: audible content with no genre attached. */
  const createProject = async () => {
    const id = userId();
    if (!id || creating()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const repository = await getProjectRepository();
      const project = createStarterProject(id);
      const result = await repository.createProject(project);
      if (!result.ok) {
        throw new Error(result.message);
      }
      analytics.log("project_created", { source: "template" });
      navigate(`/projects/${project.metadata.id}`);
    } catch (error) {
      console.error("Error creating project:", error);
      setCreateError("Couldn't create a new project. Please try again.");
      setCreating(false);
    }
  };

  const renameProject = async (
    projectId: string,
    name: string,
  ): Promise<ProjectActionResult> => {
    const current = projectsState().data.find((p) => p.id === projectId);
    if (!current) return { ok: false, message: "That project is no longer here." };
    try {
      const repository = await getProjectRepository();
      const result = await repository.saveMetadata(
        projectId as ProjectId,
        { name },
        current.revision,
      );
      if (!result.ok) {
        return { ok: false, message: result.message };
      }
      setProjectsState((state) => ({
        ...state,
        data: state.data.map((project) =>
          project.id === projectId
            ? {
                ...project,
                name,
                revision: result.revision,
                modifiedAt: result.modifiedAt,
              }
            : project,
        ),
      }));
      return { ok: true };
    } catch (error) {
      console.error("Error renaming project:", error);
      return { ok: false, message: "Couldn't rename this project." };
    }
  };

  const duplicateExistingProject = async (
    projectId: string,
  ): Promise<ProjectActionResult> => {
    const id = userId();
    if (!id) return { ok: false, message: "Not signed in." };
    try {
      const repository = await getProjectRepository();
      const loaded = await repository.loadProject(projectId as ProjectId);
      if (!loaded.ok) {
        return {
          ok: false,
          message: "Couldn't load this project to duplicate.",
        };
      }
      const duplicate = duplicateProject(loaded.value, { ownerId: id });
      const result = await repository.createProject(duplicate);
      if (!result.ok) {
        return { ok: false, message: result.message };
      }
      analytics.log("project_created", { source: "duplicate" });
      setProjectsState((state) => ({
        ...state,
        data: [...state.data, duplicate.metadata],
      }));
      return { ok: true };
    } catch (error) {
      console.error("Error duplicating project:", error);
      return { ok: false, message: "Couldn't duplicate this project." };
    }
  };

  const deleteProject = async (projectId: string): Promise<ProjectActionResult> => {
    const current = projectsState().data.find((p) => p.id === projectId);
    try {
      const repository = await getProjectRepository();
      await repository.deleteProject(projectId as ProjectId);
      analytics.log("project_deleted", {
        project_age_bucket: projectAgeBucket(
          Date.now() - (current?.createdAt ?? Date.now()),
        ),
      });
      setProjectsState((state) => ({
        ...state,
        data: state.data.filter((project) => project.id !== projectId),
      }));
      return { ok: true };
    } catch (error) {
      console.error("Error deleting project:", error);
      return { ok: false, message: "Couldn't delete this project." };
    }
  };

  return (
    <Switch>
      <Match when={!userId() || projectsState().loading}>
        <TapeLoader label="Loading projects" />
      </Match>
      <Match when={userId()}>
        {/* Wrapped in a single element: Match/Show render a list of sibling
				    children as-is without re-running reactively as a group, so the
				    conditional error/list swap below needs to live inside its own
				    single reactive container to update correctly on retry. */}
        <div>
          <div class="dashboard-actions">
            <div class="action-row">
              <Show when={!auth.isAnonymous}>
                {/* What Cue remembers about them (GRV-25). */}
                <a class="dashboard-memory-link" href="/memory">
                  Memory
                </a>
                <SignOutButton analytics={analytics} class="account-button" />
              </Show>
              <button
                type="button"
                class="new-project"
                disabled={creating()}
                onClick={() => void createProject()}
              >
                <HiSolidPlus size={18} />
                <span>New Project</span>
              </button>
            </div>
            <Show when={createError()}>
              <p class="create-error">{createError()}</p>
            </Show>
          </div>
          <Show when={auth.isAnonymous}>
            <UpgradeAccountPrompt analytics={analytics}>
              <LogInButton analytics={analytics} class="account-button" />
            </UpgradeAccountPrompt>
          </Show>
          <Switch>
            <Match when={projectsState().error}>
              {(error) => <ErrorPanel message={error()} onRetry={retryFetchProjects} />}
            </Match>
            <Match when={projectsState().data}>
              <ProjectList
                projects={projectsState().data}
                onRename={renameProject}
                onDuplicate={duplicateExistingProject}
                onDelete={deleteProject}
              />
            </Match>
          </Switch>
        </div>
      </Match>
    </Switch>
  );
}

/** A failure the dashboard cannot get past on its own, with a retry. */
function ErrorPanel(props: { message: string; onRetry: () => void }) {
  return (
    <div class="projects-error">
      <p class="projects-error-message">{props.message}</p>
      <button type="button" class="retry-button" onClick={() => props.onRetry()}>
        <HiSolidArrowPath size={16} />
        <span>Try again</span>
      </button>
    </div>
  );
}
