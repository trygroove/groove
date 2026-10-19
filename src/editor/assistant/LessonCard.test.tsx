import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { executeTransaction } from "../../commands/execute";
import type { RawCommandInput } from "../../commands/types";
import type { Project } from "../../domain/entities";
import type { PadId, TrackId } from "../../domain/ids";
import { beatTrack, kickPad } from "../../lessons/drums";
import { useProducerProfile } from "../../memory/useProducerProfile";
import { lessonOfferAsk } from "../../onboarding/questions";
import { InMemoryProfileRepository } from "../../persistence/inMemoryProfileRepository";
import { emptyProfile, type ProducerProfile } from "../../persistence/profileDocuments";
import { clickAndFlush } from "../../testing/events";
import { createFakeAssistantClient } from "../../testing/fakeAssistantClient";
import { applied, starterWorld } from "../../testing/lessonWorld";
import { memoryStorage } from "../../testing/storage";
import type { EditorViewName } from "../editorViews";
import AssistantPanel from "./AssistantPanel";
import { DEFAULT_LAYOUT, float, saveLayout } from "./assistantPanelLayout";
import { LESSON_LABEL } from "./LessonCard";
import { type AssistantChat, useAssistantChat } from "./useAssistantChat";
import { useAssistantPanel } from "./useAssistantPanel";
import { NO_SOUND } from "./useLesson";

afterEach(cleanup);

const UID = "user-1";

function producer(taste: string[] = ["Hip hop"]): ProducerProfile {
  return {
    ...emptyProfile(1),
    onboarding: "completed",
    onboardedAt: Date.now(),
    memory: { ...emptyProfile(1).memory, taste, goal: "first_track" },
  };
}

/**
 * The panel with a lesson-ready chat, over the starter project: Show me's
 * commands apply to it as the editor's would, and its view and transport are
 * signals the test can move.
 */
async function renderLesson(options: { putSound?: boolean } = {}) {
  const client = createFakeAssistantClient();
  const transport = createRecordingTransport();
  const analytics = new Analytics({
    transport,
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  const profiles = new InMemoryProfileRepository();
  await profiles.saveProfile(UID, producer());
  const [project, setProject] = createSignal<Project>(starterWorld().project);
  const [view, setView] = createSignal<EditorViewName>("arrangement");
  const [playing, setPlaying] = createSignal(false);
  const putSound = vi.fn(async (_role: "kick", trackId: TrackId, padId: PadId) => {
    if (!options.putSound) return false;
    setProject((current) => {
      const track = current.song.tracks.find((each) => each.id === trackId);
      if (track?.instrument?.kind !== "drumMachine") return current;
      const pads = track.instrument.pads.map((pad) =>
        pad.id === padId
          ? { ...pad, assetId: "ast_Other0000000000000001" as never }
          : pad,
      );
      return {
        ...current,
        song: {
          ...current.song,
          tracks: current.song.tracks.map((each) =>
            each.id === trackId && each.instrument?.kind === "drumMachine"
              ? { ...each, instrument: { ...each.instrument, pads } }
              : each,
          ),
        },
      };
    });
    return true;
  });
  const point = vi.fn();
  const apply = vi.fn((commands: readonly RawCommandInput[]) => {
    const result = executeTransaction(project(), commands, { actor: "assistant" });
    if (result.ok) setProject(result.project);
    return result.ok;
  });
  let chat: AssistantChat | undefined;
  let profileStore: ReturnType<typeof useProducerProfile> | undefined;
  const Harness = () => {
    const storage = memoryStorage();
    saveLayout(float(DEFAULT_LAYOUT), storage);
    const panel = useAssistantPanel({ storage, analytics: () => analytics });
    const store = useProducerProfile({
      uid: () => UID,
      repository: async () => profiles,
    });
    profileStore = store;
    chat = useAssistantChat({
      project,
      view,
      sources: () => ({ selection: null, track: project().song.tracks[0] ?? null }),
      account: () => ({ registered: true }),
      expanded: () => true,
      client: async () => client,
      analytics: () => analytics,
      profile: store,
      playing,
      lessonEditor: {
        apply,
        goTo: (next) => setView(next),
        point,
        play: () => setPlaying(true),
        putSound,
      },
    });
    return <AssistantPanel panel={panel} chat={chat} />;
  };
  render(() => <Harness />);
  const ready = chat;
  if (!ready) throw new Error("no chat");
  // The lesson reads the producer's genre off the profile.
  await waitFor(() => expect(profileStore?.loaded()).toBe(true));
  return {
    chat: ready,
    /** Starts a lesson as the panel would, and draws it. */
    start(...args: Parameters<AssistantChat["lesson"]["start"]>) {
      ready.lesson.start(...args);
      flush();
    },
    client,
    transport,
    profiles,
    project,
    setProject,
    setView,
    setPlaying,
    apply,
    point,
    putSound,
    lesson: () => screen.getByRole("region", { name: LESSON_LABEL }),
    bite: (title: string) =>
      within(screen.getByRole("list", { name: "Bites" }))
        .getAllByRole("listitem")
        .find((item) => item.textContent?.startsWith(title)),
    /** Ends the reply on its way, so the next lesson turn can go. */
    async reply() {
      client.last().text("Okay.");
      client.last().done();
      await Promise.resolve();
    },
  };
}

/** A kick on step 11 of BD, as the producer would click it. */
function kickOnEleven(project: Project): Project {
  const track = beatTrack(project);
  const pad = track && kickPad(track);
  const clip = project.clips[0];
  if (!track || !pad || !clip || clip.content.kind !== "notes")
    throw new Error("no beat");
  return applied(project, [
    {
      type: "note.add",
      payload: {
        clipId: clip.id,
        notes: [
          {
            ...clip.content.events[0],
            id: "evt_Eleven000000000000001",
            startTicks: 10 * 48,
          },
        ],
      },
    },
  ]);
}

describe("a lesson in the panel (GRV-43)", () => {
  it("starts from the offer at the end of onboarding, its first bite under way", async () => {
    const h = await renderLesson();
    h.chat.conversation.send("Hello");
    await waitFor(() => expect(h.client.turns).toHaveLength(1));
    h.client.last().emit({ type: "ask", ask: lessonOfferAsk("first_track") });
    h.client.last().done();
    clickAndFlush(await screen.findByRole("button", { name: /Let's go/ }));
    const lesson = await screen.findByRole("region", { name: LESSON_LABEL });
    expect(within(lesson).getByRole("heading", { name: "Make a beat" })).toBeVisible();
    expect(h.bite("Pick a kick")).toHaveAttribute("aria-current", "step");
    expect(lesson).toHaveTextContent(/Library/);
    await waitFor(() => expect(h.client.turns).toHaveLength(2));
    expect(h.client.last().request.messages.at(-1)?.text).toBe(
      'Let\'s do "Pick a kick".',
    );
    // The lesson's own turn is labelled as the lesson's, not with a scope.
    expect(screen.getByRole("log", { name: "Conversation" })).toHaveTextContent(
      'Lesson · Make a beat Let\'s do "Pick a kick".',
    );
    expect(h.client.last().request.lesson).toMatchObject({
      biteId: "beat-library",
      moment: "bite_started",
      style: "boom_bap",
    });
    expect(h.transport.named("lesson_bite_started")[0]?.params).toMatchObject({
      chapter_id: "beat",
      bite_id: "beat-library",
      source: "onboarding",
    });
    expect(
      h.transport
        .named("feature_first_use")
        .filter((event) => event.params.feature === "lessons"),
    ).toHaveLength(1);
  });

  it("sees a step done by hand, says so, and saves the bite as done", async () => {
    const h = await renderLesson();
    h.start("beat", "asked", "beat-kick");
    await waitFor(() => expect(h.client.turns).toHaveLength(1));
    const lesson = h.lesson();
    expect(lesson).toHaveTextContent(/beat 1 and on the "and" of beat 3/);
    h.setProject(kickOnEleven(h.project()));
    await waitFor(() => expect(h.bite("The kick pattern")).toHaveTextContent("done"));
    expect(within(lesson).getByRole("button", { name: "Next: Hear it" })).toBeVisible();
    await h.reply();
    await waitFor(() => expect(h.client.turns).toHaveLength(2));
    expect(h.client.last().request.messages.at(-1)?.text).toBe(
      'Finished "The kick pattern": I did it myself.',
    );
    expect(h.client.last().request.lesson?.changes).toEqual([
      "BD's BD: hits added on step 11.",
    ]);
    expect(h.transport.named("lesson_bite_completed")[0]?.params).toMatchObject({
      bite_id: "beat-kick",
      how: "did_it",
    });
    await waitFor(async () => {
      const loaded = await h.profiles.loadProfile(UID);
      expect(loaded.ok && loaded.profile?.lessonsDone).toEqual(["beat-kick"]);
    });
  });

  it("shows a step with Show me, as one change the assistant makes", async () => {
    const h = await renderLesson();
    h.start("beat", "asked", "beat-snare");
    clickAndFlush(within(h.lesson()).getByRole("button", { name: "Show me" }));
    expect(h.apply).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(h.bite("The backbeat")).toHaveTextContent("done"));
    expect(h.transport.named("lesson_bite_completed")[0]?.params.how).toBe("show_me");
    expect(beatTrack(h.project())?.instrument.pads.map((pad) => pad.name)).toEqual([
      "BD",
      "Snare",
    ]);
  });

  it("plays the song for Hear it, and goes to the view for a stop on the tour", async () => {
    const h = await renderLesson();
    h.start("beat", "asked", "beat-play");
    clickAndFlush(within(h.lesson()).getByRole("button", { name: "Show me" }));
    await waitFor(() => expect(h.bite("Hear it")).toHaveTextContent("done"));

    h.start("tour", "asked", "tour-mixer");
    await waitFor(() =>
      expect(h.bite("The Mixer")).toHaveAttribute("aria-current", "step"),
    );
    clickAndFlush(within(h.lesson()).getByRole("button", { name: "Show me" }));
    // The Mixer was the tour's last stop: the lesson is over.
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: LESSON_LABEL }),
      ).not.toBeInTheDocument(),
    );
  });

  it("puts a library kick on the pad for Pick a kick, and says when there is none", async () => {
    const found = await renderLesson({ putSound: true });
    found.start("beat", "asked", "beat-library");
    clickAndFlush(within(found.lesson()).getByRole("button", { name: "Show me" }));
    const track = beatTrack(starterWorld().project);
    expect(found.putSound).toHaveBeenCalledWith(
      "kick",
      expect.any(String),
      expect.any(String),
    );
    expect(track).not.toBeNull();
    await waitFor(() => expect(found.bite("Pick a kick")).toHaveTextContent("done"));
    cleanup();

    const missing = await renderLesson({ putSound: false });
    missing.start("beat", "asked", "beat-library");
    clickAndFlush(within(missing.lesson()).getByRole("button", { name: "Show me" }));
    expect(await within(missing.lesson()).findByText(NO_SOUND)).toBeVisible();
    expect(missing.bite("Pick a kick")).not.toHaveTextContent("done");
  });

  it("explains a term without leaving the step", async () => {
    const h = await renderLesson();
    h.start("beat", "asked", "beat-kick");
    const term = within(h.lesson()).getByRole("button", { name: "boom bap" });
    expect(term).toHaveAttribute("aria-expanded", "false");
    clickAndFlush(term);
    expect(term).toHaveAttribute("aria-expanded", "true");
    expect(h.lesson()).toHaveTextContent(/classic hip hop beat/);
    expect(within(h.lesson()).getByRole("button", { name: "Show me" })).toBeVisible();
  });

  it("skips a bite, pulls the next, and drops out on Leave", async () => {
    const h = await renderLesson();
    h.start("beat", "asked", "beat-hats");
    clickAndFlush(within(h.lesson()).getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(h.bite("Hats")).toHaveTextContent("skipped"));
    clickAndFlush(within(h.lesson()).getByRole("button", { name: "Next: Loop it" }));
    expect(h.bite("Loop it")).toHaveAttribute("aria-current", "step");
    expect(h.transport.named("lesson_bite_started").at(-1)?.params.source).toBe("next");
    clickAndFlush(within(h.lesson()).getByRole("button", { name: "Leave" }));
    expect(screen.queryByRole("region", { name: LESSON_LABEL })).not.toBeInTheDocument();
    expect(h.transport.named("lesson_dropped_out")[0]?.params).toMatchObject({
      chapter_id: "beat",
      bite_id: "beat-loop",
    });
  });

  it("starts the chapter Coproducer names, and carries the lesson on the producer's own messages", async () => {
    const h = await renderLesson();
    h.chat.conversation.send("Teach me to shape a sound");
    await waitFor(() => expect(h.client.turns).toHaveLength(1));
    expect(h.client.last().request.lesson).toBeUndefined();
    h.client.last().emit({
      type: "proposal",
      proposal: {
        baseRevision: 0,
        toolsetVersion: 10,
        calls: [{ id: "t1", name: "start_lesson", input: { chapter: "sound" } }],
      },
    });
    h.client.last().done();
    const lesson = await screen.findByRole("region", { name: LESSON_LABEL });
    expect(within(lesson).getByRole("heading", { name: "Shape a sound" })).toBeVisible();
    await waitFor(() => expect(h.client.turns).toHaveLength(2));
    await h.reply();
    h.chat.conversation.send("What's an oscillator?");
    await waitFor(() => expect(h.client.turns).toHaveLength(3));
    expect(h.client.last().request.lesson).toMatchObject({
      chapterId: "sound",
      moment: "under_way",
    });
  });
});
