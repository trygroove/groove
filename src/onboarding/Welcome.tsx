import { useNavigate } from "@solidjs/router";
import type { JSX } from "@solidjs/web";
import { createEffect, For, Match, Show, Switch } from "solid-js";
import { ASSISTANT_NAME } from "../../site.config.mjs";
import { type Analytics, analytics as defaultAnalytics } from "../analytics/analytics";
import { useAuth } from "../auth/AuthProvider";
import { SparkIcon } from "../components/icons";
import type { ProjectId } from "../domain/ids";
import AssistantAskCard from "../editor/assistant/AssistantAskCard";
import { WRITING_STATUS } from "../editor/assistant/AssistantChatView";
import {
  isOpen,
  loadLayout,
  saveLayout,
  toggle,
} from "../editor/assistant/assistantPanelLayout";
import { useAskDraft } from "../editor/assistant/useAskDraft";
import type { ConversationEntry } from "../editor/assistant/useAssistantConversation";
import { createStarterProject } from "../editor/starterProject";
import type { ProfileRepository } from "../persistence/profileRepository";
import type { ProjectRepository } from "../persistence/projectRepository";
import { getProfileRepository } from "../profileRepositoryClient";
import { getProjectRepository } from "../projectRepositoryClient";
import { useShortcuts } from "../shortcuts/useShortcuts";
import CueMark from "./CueMark";
import { MemoryCard } from "./MemoryCard";
import { type Onboarding, useOnboarding } from "./useOnboarding";
import "../editor/assistant/AssistantPanel.css";
import "./Welcome.css";

export interface WelcomeProps {
  readonly analytics?: Analytics;
  readonly profiles?: () => Promise<ProfileRepository>;
  readonly projects?: () => Promise<ProjectRepository>;
  /** How long Cue writes before each reply; 0 in tests. */
  readonly replyDelayMs?: number;
}

/** The label on the way out before the questions are done. */
export const SKIP_LABEL = "Skip to the studio";
/** The label on the way out once memory is saved. */
export const OPEN_STUDIO_LABEL = "Open the studio";

/**
 * The welcome (GRV-25): a full-screen conversation with Cue, no editor, in
 * the Studio style: a centred header with Cue's name and its mark, then the
 * conversation and its questions drawn exactly as the assistant panel draws
 * them (`AssistantPanel.css`, `AssistantAskCard`), unboxed on the black.
 *
 * Someone who has already been through onboarding is sent on to the
 * dashboard. Skip to the studio saves onboarding as skipped and goes to the
 * dashboard; Open the studio, once memory is saved, creates the first
 * project, opens Cue's panel in it, and carries the conversation over.
 */
export default function Welcome(props: WelcomeProps): JSX.Element {
  const analytics = props.analytics ?? defaultAnalytics;
  const profiles = props.profiles ?? getProfileRepository;
  const projects = props.projects ?? getProjectRepository;
  const auth = useAuth();
  const navigate = useNavigate();
  const uid = () => auth.user?.uid ?? null;

  const onboarding = useOnboarding({
    uid,
    profiles,
    analytics,
    replyDelayMs: props.replyDelayMs,
    createProject: async (owner): Promise<ProjectId> => {
      const repository = await projects();
      const project = createStarterProject(owner);
      const result = await repository.createProject(project);
      if (!result.ok) throw new Error(result.message);
      analytics.log("project_created", { source: "template" });
      return project.metadata.id;
    },
  });
  const draft = useAskDraft({ conversation: onboarding, project: () => null });

  // Someone who has completed or skipped onboarding already goes on to the
  // dashboard; anyone else has started it. The uid is the one reactive read;
  // the read, the navigation and the event are the apply half's.
  createEffect(
    () => uid(),
    (id) => {
      if (!id) return;
      let cancelled = false;
      profiles()
        .then((repository) => repository.loadProfile(id))
        .then((result) => {
          if (cancelled || !result.ok) return;
          if (result.profile?.onboarding) navigate("/projects", { replace: true });
          else onboarding.started(result.profile);
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    },
  );

  // Enter in the question's text box sends the answer, as it does in the
  // panel: the registry's `assistant.send`, live while that box has focus
  // (the `composer` context). The digits and the chips' Enter are the
  // editor's alone, so the card leaves their hints off here.
  let askText: HTMLElement | undefined;
  const askTextHasFocus = () =>
    askText !== undefined && document.activeElement === askText;
  useShortcuts({
    analytics,
    handlers: () => ({
      "assistant.send": { run: () => void draft.finish(), isEnabled: askTextHasFocus },
    }),
    contexts: () => (askTextHasFocus() ? ["composer"] : []),
  });

  async function skip(): Promise<void> {
    await onboarding.skipAll();
    navigate("/projects");
  }

  async function openStudio(): Promise<void> {
    try {
      const projectId = await onboarding.openStudio();
      // The studio opens with Cue's panel open, where the conversation carries on.
      const layout = loadLayout();
      if (!isOpen(layout)) saveLayout(toggle(layout));
      navigate(`/projects/${projectId}`);
    } catch (error) {
      console.error("Error opening the studio:", error);
    }
  }

  return (
    <main class="welcome">
      <header class="welcome-header">
        <CueMark active={onboarding.streaming()} />
        <h1 class="welcome-name">{ASSISTANT_NAME}</h1>
        <p class="welcome-tagline">The producer beside you in Groove</p>
        <span class="welcome-status" aria-live="polite">
          {onboarding.streaming() ? WRITING_STATUS : ""}
        </span>
      </header>
      <div class="welcome-body">
        <div
          class="assistant-panel-log welcome-log"
          role="log"
          aria-live="polite"
          aria-label="Conversation"
          aria-busy={onboarding.streaming() ? "true" : "false"}
        >
          <For each={onboarding.entries()} keyed={(entry: ConversationEntry) => entry.id}>
            {(entry) => (
              <WelcomeEntry
                entry={entry()}
                asking={onboarding.pendingAsk()?.replyId === entry().id}
              />
            )}
          </For>
          <Show when={onboarding.stage() !== "asking"}>
            <MemoryCard
              memory={onboarding.memory()}
              consent={onboarding.consent()}
              onConsent={(value) => void onboarding.setConsent(value)}
              status={onboarding.stage()}
              onRetry={() => void onboarding.retrySave()}
            />
          </Show>
        </div>
        <Show when={onboarding.pendingAsk()}>
          {(pending) => (
            <AssistantAskCard
              pending={pending()}
              draft={draft}
              streaming={onboarding.streaming()}
              bindText={(element) => {
                askText = element;
              }}
              takeFocus={() => true}
              textLabel={onboarding.question()?.textLabel}
              skipLabel="Skip this question"
              keyHint={false}
            />
          )}
        </Show>
        <div class="welcome-actions">
          <Switch>
            {/* A failed save still lets them in: the card offers the retry,
                and the welcome comes back next time if it never lands. */}
            <Match
              when={
                onboarding.stage() === "saved" || onboarding.stage() === "save_failed"
              }
            >
              <button
                type="button"
                class="assistant-button-primary welcome-open"
                disabled={onboarding.leaving()}
                onClick={() => void openStudio()}
              >
                {OPEN_STUDIO_LABEL}
              </button>
            </Match>
            <Match when={onboarding.stage() === "asking" && !onboarding.finished()}>
              <button
                type="button"
                class="welcome-skip"
                disabled={onboarding.leaving()}
                onClick={() => void skip()}
              >
                {SKIP_LABEL}
              </button>
            </Match>
          </Switch>
        </div>
      </div>
    </main>
  );
}

/** One entry, drawn as the panel draws it (`AssistantChatView`). */
function WelcomeEntry(props: {
  readonly entry: ConversationEntry;
  readonly asking: boolean;
}): JSX.Element {
  return (
    <Switch>
      <Match when={props.entry.kind === "message" && props.entry}>
        {(message) => (
          <div class="assistant-message">
            <span class="assistant-entry-label">Answer · {message().answers}</span>{" "}
            <p>{message().text}</p>
          </div>
        )}
      </Match>
      <Match when={props.entry.kind === "reply" && props.entry}>
        {(reply) => (
          <div class="assistant-reply">
            <span class="assistant-entry-label assistant-reply-who">
              <SparkIcon size={10} />
              {ASSISTANT_NAME}
            </span>{" "}
            <p>{reply().text}</p>
            <Show when={!props.asking && reply().ask}>
              {(ask) => <p class="assistant-reply-asked">Asked: {ask().question}</p>}
            </Show>
          </div>
        )}
      </Match>
    </Switch>
  );
}

export type { Onboarding };
