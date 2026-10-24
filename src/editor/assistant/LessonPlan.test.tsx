import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { ASSISTANT_TOOLSET_VERSION } from "../../assistant/tools";
import { executeTransaction } from "../../commands/execute";
import type { RawCommandInput } from "../../commands/types";
import type { Project } from "../../domain/entities";
import type { PadId, TrackId } from "../../domain/ids";
import { beatTrack, kickPad } from "../../lessons/drums";
import { BITE_IDS } from "../../lessons/ids";
import { useProducerProfile } from "../../memory/useProducerProfile";
import { lessonOfferAsk } from "../../onboarding/questions";
import { InMemoryLessonRepository } from "../../persistence/inMemoryLessonRepository";
import { InMemoryProfileRepository } from "../../persistence/inMemoryProfileRepository";
import type { LessonRecord } from "../../persistence/lessonDocuments";
import { emptyProfile, type ProducerProfile } from "../../persistence/profileDocuments";
import { clickAndFlush } from "../../testing/events";
import { createFakeAssistantClient } from "../../testing/fakeAssistantClient";
import {
  createFakeRetentionClient,
  type FakeRetentionClient,
} from "../../testing/fakeRetentionClient";
import { applied, starterWorld } from "../../testing/lessonWorld";
import { memoryStorage } from "../../testing/storage";
import type { EditorViewName } from "../composition/editorViews";
import AssistantPanel from "./AssistantPanel";
import { DEFAULT_LAYOUT, float, saveLayout } from "./assistantPanelLayout";
import { LESSON_LABEL } from "./LessonPlan";
import { type AssistantChat, useAssistantChat } from "./useAssistantChat";
import { useAssistantPanel } from "./useAssistantPanel";
import { NO_SOUND } from "./useLessonShowMe";

afterEach(cleanup);

const UID = "user-1";
const PROJECT = "prj_lesson";

function producer(taste: string[] = ["Hip hop"]): ProducerProfile {
  return {
    ...emptyProfile(1),
    onboarding: "completed",
    onboardedAt: Date.now(),
    memory: { ...emptyProfile(1).memory, taste, goal: "first_track" },
  };
}

/**
 * Removes elements the way Chrome does (GRV-190 QA): the focused element gets
 * its `focusout`, with no related target, while it is still on the page, and
 * only then leaves it. jsdom drops focus silently, which hid the bug.
 */
function blurOnRemoveLikeChrome(): () => void {
  const blurIfFocused = (node: Node) => {
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      node.contains(active)
    ) {
      active.dispatchEvent(
        new FocusEvent("focusout", { bubbles: true, relatedTarget: null }),
      );
    }
  };
  const removeChild = Node.prototype.removeChild;
  const replaceChild = Node.prototype.replaceChild;
  const remove = Element.prototype.remove;
  const replaceWith = Element.prototype.replaceWith;
  Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T {
    blurIfFocused(child);
    return removeChild.call(this, child) as T;
  };
  Node.prototype.replaceChild = function <T extends Node>(
    this: Node,
    node: Node,
    child: T,
  ): T {
    blurIfFocused(child);
    return replaceChild.call(this, node, child) as T;
  };
  Element.prototype.remove = function (this: Element) {
    blurIfFocused(this);
    remove.call(this);
  };
  Element.prototype.replaceWith = function (this: Element, ...nodes: (Node | string)[]) {
    blurIfFocused(this);
    replaceWith.apply(this, nodes);
  };
  return () => {
    Node.prototype.removeChild = removeChild;
    Node.prototype.replaceChild = replaceChild;
    Element.prototype.remove = remove;
    Element.prototype.replaceWith = replaceWith;
  };
}

/**
 * The panel with a lesson-ready chat, over the starter project: Show me's
 * commands apply to it as the editor's would, and its view and transport are
 * signals the test can move.
 */
async function renderLesson(
  options: {
    putSound?: boolean;
    profile?: ProducerProfile;
    record?: LessonRecord;
    /** The records another page load left, for a reload. */
    records?: InMemoryLessonRepository;
    /** The account's answer about keeping conversations (GRV-8). */
    retention?: FakeRetentionClient;
  } = {},
) {
  const client = createFakeAssistantClient();
  const transport = createRecordingTransport();
  const analytics = new Analytics({
    transport,
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  const profiles = new InMemoryProfileRepository();
  await profiles.saveProfile(UID, options.profile ?? producer());
  const records = options.records ?? new InMemoryLessonRepository();
  if (options.record) await records.saveRecord(UID, PROJECT, options.record);
  const [project, setProject] = createSignal<Project>(starterWorld().project);
  const [view, setView] = createSignal<EditorViewName>("arrangement");
  const [playing, setPlaying] = createSignal(false);
  // Whether a project is open: with none, there is nothing to start a lesson in.
  const [open, setOpen] = createSignal(true);
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
  const openExport = vi.fn();
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
      project: () => (open() ? project() : null),
      view,
      sources: () => ({ selection: null, track: project().song.tracks[0] ?? null }),
      account: () => ({ registered: true }),
      expanded: () => true,
      client: async () => client,
      analytics: () => analytics,
      profile: store,
      playing,
      retention: options.retention
        ? {
            client: async () => options.retention as FakeRetentionClient,
            internal: () => false,
          }
        : undefined,
      lessonRecord: {
        owner: () => ({ uid: UID, projectId: PROJECT }),
        repository: async () => records,
      },
      lessonEditor: {
        apply,
        goTo: (next) => setView(next),
        point,
        play: async () => {
          setPlaying(true);
        },
        putSound,
        openExport,
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
    records,
    project,
    setProject,
    setOpen,
    view,
    setView,
    setPlaying,
    apply,
    point,
    putSound,
    openExport,
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

/**
 * Boom bap's kick on BD, as the producer would click it: step 11 on, and the
 * starter's kicks on 5, 9 and 13 off.
 */
function boomBapKickByHand(project: Project): Project {
  const track = beatTrack(project);
  const pad = track && kickPad(track);
  const clip = project.clips[0];
  if (!track || !pad || !clip || clip.content.kind !== "notes")
    throw new Error("no beat");
  const offBeat = clip.content.events
    .filter((note) => note.startTicks !== 0)
    .map((note) => note.id);
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
    { type: "note.remove", payload: { clipId: clip.id, eventIds: offBeat } },
  ]);
}

describe("a lesson in the panel (GRV-43)", () => {
  it("starts the tour from the offer at the end of onboarding, its first bite under way (GRV-190)", async () => {
    const h = await renderLesson();
    h.chat.conversation.send("Hello");
    await waitFor(() => expect(h.client.turns).toHaveLength(1));
    h.client.last().emit({ type: "ask", ask: lessonOfferAsk("first_track") });
    h.client.last().done();
    clickAndFlush(await screen.findByRole("button", { name: /Let's go/ }));
    const lesson = await screen.findByRole("region", { name: LESSON_LABEL });
    expect(
      within(lesson).getByRole("heading", { name: "Lesson · Tour the studio" }),
    ).toBeVisible();
    expect(h.bite("The Arrangement")).toHaveAttribute("aria-current", "step");
    expect(lesson).toHaveTextContent(/Arrangement/);
    await waitFor(() => expect(h.client.turns).toHaveLength(2));
    expect(h.client.last().request.messages.at(-1)?.text).toBe(
      'Let\'s do "The Arrangement".',
    );
    // The lesson's own turn is labelled as the lesson's, not with a scope.
    expect(screen.getByRole("log", { name: "Conversation" })).toHaveTextContent(
      'Lesson · Tour the studio Let\'s do "The Arrangement".',
    );
    expect(h.client.last().request.lesson).toMatchObject({
      biteId: "tour-arrangement",
      moment: "bite_started",
    });
    expect(h.transport.named("lesson_bite_started")).toHaveLength(1);
    expect(h.transport.named("lesson_bite_started")[0]?.params).toMatchObject({
      chapter_id: "tour",
      bite_id: "tour-arrangement",
      source: "onboarding",
    });
    expect(
      h.transport
        .named("feature_first_use")
        .filter((event) => event.params.feature === "lessons"),
    ).toHaveLength(1);
  });

  it("lets the offer go once the producer types something else, and keeps a model's question (GRV-206)", async () => {
    const h = await renderLesson();
    h.chat.conversation.send("Hello");
    await waitFor(() => expect(h.client.turns).toHaveLength(1));
    h.client.last().emit({ type: "ask", ask: lessonOfferAsk("first_track") });
    h.client.last().done();
    expect(await screen.findByRole("button", { name: /Let's go/ })).toBeVisible();

    expect(h.chat.conversation.send("so what do I do now")).toBe(true);
    await waitFor(() => expect(h.client.turns).toHaveLength(2));
    expect(h.chat.conversation.pendingAsk()).toBeNull();
    expect(screen.queryByRole("button", { name: /Let's go/ })).toBeNull();
    expect(
      h.transport.named("assistant_ask_answered").map((event) => event.params.how),
    ).toEqual(["dismissed"]);

    // A question the model asked still waits for its answer.
    const ask = { ...lessonOfferAsk("first_track"), id: "model-question" };
    h.client.last().emit({ type: "ask", ask });
    h.client.last().done();
    await waitFor(() => expect(h.chat.conversation.pendingAsk()?.ask.id).toBe(ask.id));
    expect(h.chat.conversation.send("make a beat")).toBe(true);
    await waitFor(() => expect(h.client.turns).toHaveLength(3));
    expect(h.chat.conversation.pendingAsk()?.ask.id).toBe(ask.id);
  });

  it("sees a step done by hand, says so, and saves the bite as done", async () => {
    const h = await renderLesson();
    h.start("beat", "asked", "beat-kick");
    await waitFor(() => expect(h.client.turns).toHaveLength(1));
    const lesson = h.lesson();
    expect(lesson).toHaveTextContent(/beat 1 and on the "and" of beat 3/);
    h.setProject(boomBapKickByHand(h.project()));
    await waitFor(() => expect(h.bite("The kick pattern")).toHaveTextContent("done"));
    expect(within(lesson).getByRole("button", { name: "Next: Hear it" })).toBeVisible();
    await h.reply();
    await waitFor(() => expect(h.client.turns).toHaveLength(2));
    expect(h.client.last().request.messages.at(-1)?.text).toBe(
      'Finished "The kick pattern": I did it myself.',
    );
    expect(h.client.last().request.lesson?.changes).toEqual([
      "BD's BD: hits added on step 11.",
      "BD's BD: hits removed from step 5, step 9 and step 13.",
    ]);
    expect(h.transport.named("lesson_bite_completed")).toHaveLength(1);
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
    expect(h.transport.named("lesson_bite_completed")).toHaveLength(1);
    expect(h.transport.named("lesson_bite_completed")[0]?.params.how).toBe("show_me");
    expect(beatTrack(h.project())?.instrument.pads.map((pad) => pad.name)).toEqual([
      "BD",
      "Snare",
    ]);
  });

  it("plays the song for Hear it, and goes to the view for a stop on the tour", async () => {
    const h = await renderLesson();
    h.start("beat", "asked", "beat-play");
    // Boom bap's tempo first, then playing it.
    expect(h.lesson()).toHaveTextContent(/90 BPM/);
    clickAndFlush(within(h.lesson()).getByRole("button", { name: "Show me" }));
    await waitFor(() => expect(h.project().song.tempo).toBe(90));
    await waitFor(() => expect(h.lesson()).toHaveTextContent(/Play/));
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
    expect(h.transport.named("lesson_bite_completed")).toHaveLength(1);
    expect(h.transport.named("lesson_bite_completed")[0]?.params).toMatchObject({
      bite_id: "beat-hats",
      how: "skipped",
    });
    clickAndFlush(within(h.lesson()).getByRole("button", { name: "Next: Loop it" }));
    expect(h.bite("Loop it")).toHaveAttribute("aria-current", "step");
    expect(h.transport.named("lesson_bite_started").at(-1)?.params.source).toBe("next");
    clickAndFlush(within(h.lesson()).getByRole("button", { name: "Leave" }));
    expect(screen.queryByRole("region", { name: LESSON_LABEL })).not.toBeInTheDocument();
    expect(h.transport.named("lesson_dropped_out")).toHaveLength(1);
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
        toolsetVersion: ASSISTANT_TOOLSET_VERSION,
        calls: [{ id: "t1", name: "start_lesson", input: { chapter: "sound" } }],
      },
    });
    h.client.last().done();
    const lesson = await screen.findByRole("region", { name: LESSON_LABEL });
    expect(
      within(lesson).getByRole("heading", { name: "Lesson · Shape a sound" }),
    ).toBeVisible();
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

describe("Finish a track in the panel (GRV-44)", () => {
  const place = (h: Awaited<ReturnType<typeof renderLesson>>) =>
    within(h.lesson()).getByText(/^bite \d+ of \d+/);
  /** The chapter under way, as the strip says it to a screen reader. */
  const chapterNow = (h: Awaited<ReturnType<typeof renderLesson>>) =>
    within(h.lesson())
      .getByRole("list", { name: "Chapters" })
      .querySelector('[data-state="current"]');

  it("starts when Coproducer names it, saying the chapter and what the song already has", async () => {
    const h = await renderLesson({ profile: producer(["House"]) });
    h.chat.conversation.send("Teach me to finish a track");
    await waitFor(() => expect(h.client.turns).toHaveLength(1));
    h.client.last().emit({
      type: "proposal",
      proposal: {
        baseRevision: 0,
        toolsetVersion: ASSISTANT_TOOLSET_VERSION,
        calls: [{ id: "t1", name: "start_lesson", input: { chapter: "track" } }],
      },
    });
    h.client.last().done();
    const lesson = await screen.findByRole("region", { name: LESSON_LABEL });
    expect(
      within(lesson).getByRole("heading", { name: "Lesson · Finish a track" }),
    ).toBeVisible();
    expect(chapterNow(h)).toHaveTextContent("Make a beat: 0 of 6 done");
    expect(place(h)).toHaveTextContent("bite 1 of 6");
    // House's kick is the starter's four on the floor: already there.
    expect(h.bite("The kick pattern")).toHaveTextContent("already in your song");
    expect(h.bite("Pick a kick")).toHaveAttribute("aria-current", "step");
  });

  it("marks only what this song has, not beat bites done in another lesson", async () => {
    const beat = BITE_IDS.filter((id) => id.startsWith("beat-"));
    const h = await renderLesson({
      profile: { ...producer(["House"]), lessonsDone: beat },
    });
    h.start("track", "asked");
    expect(chapterNow(h)).toHaveTextContent("Make a beat");
    expect(place(h)).toHaveTextContent("bite 1 of 6");
    expect(h.bite("The kick pattern")).toHaveTextContent("already in your song");
    for (const title of ["Pick a kick", "Hear it", "The backbeat", "Hats", "Loop it"]) {
      expect(h.bite(title)?.textContent).toBe(title);
    }
  });

  it("picks the lesson up where the project's record left it (GRV-190)", async () => {
    const h = await renderLesson({
      // The profile's list says nothing about where a lesson is.
      profile: { ...producer(), lessonsDone: ["bass-key", "bass-line"] },
      record: {
        underWay: {
          lessonId: "track",
          chapterIndex: 2,
          biteId: "chords-loop",
          stepIndex: 0,
          endings: { "bass-sound": "skipped" },
          passed: [],
        },
        finished: {},
        updatedAt: 1,
      },
    });
    // A reload brings it back on its own, at the same bite.
    await waitFor(() => expect(chapterNow(h)).toHaveTextContent("Chords and hook"));
    expect(h.client.turns).toHaveLength(0);
    h.start("track", "asked");
    expect(chapterNow(h)).toHaveTextContent("Chords and hook");
    expect(place(h)).toHaveTextContent("bite 1 of 3");
  });

  it("offers the next chapter once one is over, and goes on to it", async () => {
    const h = await renderLesson();
    h.start("track", "asked", "bass-sound");
    // No Bass track in the starter: adding one comes first. Skip both steps.
    clickAndFlush(within(h.lesson()).getByRole("button", { name: "Skip" }));
    clickAndFlush(within(h.lesson()).getByRole("button", { name: "Skip" }));
    const next = await within(h.lesson()).findByRole("button", {
      name: "Next chapter: Chords and hook",
    });
    // The bite is over, waiting on Next: the place says so.
    expect(place(h)).toHaveTextContent("bite 3 of 3 · done");
    expect(chapterNow(h)).toHaveTextContent("Bass");
    clickAndFlush(next);
    expect(chapterNow(h)).toHaveTextContent("Chords and hook");
    expect(h.bite("A chord loop")).toHaveAttribute("aria-current", "step");
    expect(h.transport.named("lesson_chapter_completed")).toHaveLength(1);
  });
});

describe("the Lessons list and lesson mode (GRV-190)", () => {
  const lessonsButton = () => screen.getByRole("button", { name: "Lessons" });
  const list = () => screen.getByRole("region", { name: "Lessons" });
  const row = (title: string) =>
    within(list())
      .getAllByRole("button")
      .find((button) => button.textContent?.startsWith(title));

  it("opens from the header in place of the conversation, and Done or the button closes it", async () => {
    const h = await renderLesson();
    expect(lessonsButton()).toHaveAttribute("aria-pressed", "false");
    clickAndFlush(lessonsButton());
    expect(lessonsButton()).toHaveAttribute("aria-pressed", "true");
    expect(list()).toBeVisible();
    expect(screen.queryByRole("log", { name: "Conversation" })).toBeNull();
    // The tour first, then the beat, the sound and the track.
    expect(
      within(list())
        .getAllByRole("button")
        .map((button) => button.querySelector(".lessons-list-title")?.textContent)
        .filter(Boolean),
    ).toEqual(["Tour the studio", "Make a beat", "Shape a sound", "Finish a track"]);
    expect(h.transport.named("lessons_list_opened")).toHaveLength(1);
    expect(
      h.transport
        .named("feature_first_use")
        .filter((event) => event.params.feature === "lessons_list"),
    ).toHaveLength(1);
    clickAndFlush(within(list()).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("region", { name: "Lessons" })).toBeNull();
    expect(screen.getByRole("log", { name: "Conversation" })).toBeVisible();
    clickAndFlush(lessonsButton());
    clickAndFlush(lessonsButton());
    expect(screen.queryByRole("region", { name: "Lessons" })).toBeNull();
    // Once per open.
    expect(h.transport.named("lessons_list_opened")).toHaveLength(2);
  });

  it("opens for a registered account before the data disclosure is answered (GRV-205)", async () => {
    const h = await renderLesson({ retention: createFakeRetentionClient({ uid: UID }) });
    await waitFor(() => expect(h.chat.retention?.known()).toBe(true));
    expect(h.chat.retention?.answered()).toBe(false);
    clickAndFlush(lessonsButton());
    expect(list()).toBeVisible();
    clickAndFlush(row("Make a beat") as HTMLElement);
    expect(screen.queryByRole("region", { name: "Lessons" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Lesson · Make a beat" })).toBeVisible();
  });

  it("stays open when a lesson cannot start, with no project open", async () => {
    const h = await renderLesson();
    h.setOpen(false);
    flush();
    clickAndFlush(lessonsButton());
    clickAndFlush(row("Make a beat") as HTMLElement);
    expect(list()).toBeVisible();
    expect(h.chat.lesson.state()).toBeNull();
    expect(h.transport.named("lesson_started_from_list")).toHaveLength(0);
  });

  it("shows each lesson's progress from the record and the profile", async () => {
    const tour = BITE_IDS.filter((id) => id.startsWith("tour-"));
    const h = await renderLesson({
      // The tour done in another project; the beat part-way here.
      profile: { ...producer(), lessonsDone: tour },
      record: {
        underWay: null,
        finished: {
          "beat-library": { how: "did_it", at: 1 },
          "beat-kick": { how: "show_me", at: 1 },
          "beat-play": { how: "skipped", at: 1 },
        },
        updatedAt: 1,
      },
    });
    await waitFor(() => expect(h.chat.lesson.finished()).toHaveProperty("beat-kick"));
    clickAndFlush(lessonsButton());
    expect(row("Make a beat")).toHaveTextContent("2 of 6 done");
    expect(row("Tour the studio")).toHaveTextContent("Done");
    expect(row("Shape a sound")).toHaveTextContent("Not started");
    // "Make a beat" is Finish a track's first chapter: its bites count there too.
    expect(row("Finish a track")).toHaveTextContent("2 of 22 done");
    const ticks = row("Make a beat")?.querySelectorAll(".lesson-ticks i");
    expect([...(ticks ?? [])].map((tick) => tick.getAttribute("data-tick"))).toEqual([
      "done",
      "done",
      "skipped",
      "todo",
      "todo",
      "todo",
    ]);
  });

  it("starts a lesson with one press and no message, and shows its plan", async () => {
    const h = await renderLesson();
    clickAndFlush(lessonsButton());
    clickAndFlush(row("Shape a sound") as HTMLElement);
    expect(screen.queryByRole("region", { name: "Lessons" })).toBeNull();
    expect(
      within(h.lesson()).getByRole("heading", { name: "Lesson · Shape a sound" }),
    ).toBeVisible();
    // Coproducer's first lesson turn follows, as the lesson's own.
    await waitFor(() => expect(h.client.turns).toHaveLength(1));
    expect(h.client.last().request.lesson).toMatchObject({
      chapterId: "sound",
      moment: "bite_started",
    });
    expect(h.transport.named("lesson_started_from_list")).toHaveLength(1);
    expect(h.transport.named("lesson_started_from_list")[0]?.params).toMatchObject({
      lesson: "sound",
    });
    expect(h.transport.named("lesson_bite_started")[0]?.params).toMatchObject({
      source: "list",
    });
  });

  it("says Continue for the lesson under way, and leaves it for another without asking", async () => {
    const h = await renderLesson();
    h.start("tour", "asked");
    clickAndFlush(lessonsButton());
    expect(row("Tour the studio")).toHaveTextContent("In progress");
    expect(row("Tour the studio")).toHaveTextContent("Continue");
    expect(row("Tour the studio")).toHaveAttribute("aria-current", "true");
    // Continuing it is no new start.
    clickAndFlush(row("Tour the studio") as HTMLElement);
    expect(h.transport.named("lesson_bite_started")).toHaveLength(1);
    expect(h.transport.named("lesson_dropped_out")).toHaveLength(0);
    expect(h.transport.named("lesson_started_from_list")).toHaveLength(0);
    clickAndFlush(lessonsButton());
    clickAndFlush(row("Make a beat") as HTMLElement);
    expect(h.transport.named("lesson_started_from_list")).toHaveLength(1);
    expect(
      within(h.lesson()).getByRole("heading", { name: "Lesson · Make a beat" }),
    ).toBeVisible();
    expect(h.transport.named("lesson_dropped_out")).toHaveLength(1);
    expect(h.transport.named("lesson_dropped_out")[0]?.params).toMatchObject({
      chapter_id: "tour",
    });
  });

  it("links to Instagram in a new tab, and logs it once", async () => {
    const h = await renderLesson();
    clickAndFlush(lessonsButton());
    expect(list()).toHaveTextContent(
      "More bite-sized lessons on Instagram: follow @trygroove.app.",
    );
    const link = within(list()).getByRole("link", { name: "@trygroove.app" });
    expect(link).toHaveAttribute("href", "https://www.instagram.com/trygroove.app");
    expect(link).toHaveAttribute("target", "_blank");
    link.addEventListener("click", (event) => event.preventDefault());
    clickAndFlush(link);
    expect(h.transport.named("instagram_link_opened")).toHaveLength(1);
  });

  it("says it is a lesson: the panel's title, the plan's eyebrow and its first line", async () => {
    const h = await renderLesson();
    expect(
      screen.getByText("Coproducer", { selector: ".assistant-panel-title" }),
    ).toBeVisible();
    h.start("tour", "asked");
    expect(
      screen.getByText("Coproducer · Lesson", { selector: ".assistant-panel-title" }),
    ).toBeVisible();
    // The panel is still named Coproducer.
    expect(screen.getByRole("region", { name: "Coproducer" })).toBeVisible();
    expect(h.lesson()).toHaveTextContent(
      "Coproducer teaches this one step at a time in your project. Do each step yourself, or press Show me. Leave at any time.",
    );
    clickAndFlush(within(h.lesson()).getByRole("button", { name: "Skip" }));
    expect(h.lesson()).not.toHaveTextContent(
      "Coproducer teaches this one step at a time",
    );
    clickAndFlush(within(h.lesson()).getByRole("button", { name: "Leave" }));
    expect(screen.queryByRole("region", { name: LESSON_LABEL })).toBeNull();
    expect(
      screen.getByText("Coproducer", { selector: ".assistant-panel-title" }),
    ).toBeVisible();
  });

  it("folds to its first two rows while the producer talks, and a transition unfolds it", async () => {
    const h = await renderLesson();
    h.start("tour", "asked", "tour-sequence");
    const fold = within(h.lesson()).getByRole("button", { name: "Fold the plan" });
    expect(fold).toHaveAttribute("aria-expanded", "true");
    clickAndFlush(fold);
    expect(h.lesson()).toHaveAttribute("data-folded", "true");
    expect(within(h.lesson()).queryByRole("button", { name: "Skip" })).toBeNull();
    expect(within(h.lesson()).queryByRole("list", { name: "Bites" })).toBeNull();
    // The eyebrow row names the bite, and Leave and the strip stay.
    expect(h.lesson()).toHaveTextContent("The Sequence view");
    expect(within(h.lesson()).getByRole("button", { name: "Leave" })).toBeVisible();
    expect(within(h.lesson()).getByRole("list", { name: "Chapters" })).toBeVisible();
    h.setView("sequence");
    flush();
    await waitFor(() => expect(h.lesson()).toHaveAttribute("data-folded", "false"));
  });

  it("draws a tick per bite: done, skipped, passed over, under way and to come", async () => {
    const h = await renderLesson({ profile: producer(["House"]) });
    h.start("track", "asked");
    clickAndFlush(within(h.lesson()).getByRole("button", { name: "Skip" }));
    const strip = within(h.lesson()).getByRole("list", { name: "Chapters" });
    const columns = strip.querySelectorAll("li");
    expect(columns).toHaveLength(5);
    expect(columns[0]).toHaveTextContent("Beat");
    const first = [...columns[0].querySelectorAll(".lesson-ticks i")].map((tick) =>
      tick.getAttribute("data-tick"),
    );
    expect(first).toEqual(["skipped", "passed", "todo", "todo", "todo", "todo"]);
    clickAndFlush(within(h.lesson()).getByRole("button", { name: /^Next: / }));
    const now = [...columns[0].querySelectorAll(".lesson-ticks i")].map((tick) =>
      tick.getAttribute("data-tick"),
    );
    expect(now).toEqual(["skipped", "passed", "current", "todo", "todo", "todo"]);
  });

  it("comes back on a reload at the same step, from the record", async () => {
    const first = await renderLesson();
    first.start("tour", "asked", "tour-sequence");
    clickAndFlush(within(first.lesson()).getByRole("button", { name: "Skip" }));
    clickAndFlush(within(first.lesson()).getByRole("button", { name: /^Next: / }));
    await waitFor(async () => {
      const stored = await first.records.loadRecord(UID, PROJECT);
      expect(stored.ok && stored.record?.underWay?.biteId).toBe("tour-instrument");
    });
    cleanup();
    const again = await renderLesson({ records: first.records });
    await waitFor(() =>
      expect(again.bite("The Instrument view")).toHaveAttribute("aria-current", "step"),
    );
    expect(again.bite("The Sequence view")).toHaveTextContent("skipped");
  });

  it("puts a quiz away once its lesson is left", async () => {
    const h = await renderLesson();
    h.start("tour", "asked", "tour-sequence");
    await waitFor(() => expect(h.client.turns).toHaveLength(1));
    // Coproducer answers the bite with a quiz question.
    h.client.last().emit({
      type: "ask",
      ask: {
        id: "quiz",
        question: "Which key opens Sequence?",
        options: [{ label: "2" }, { label: "5" }],
        multiSelect: false,
      },
    });
    h.client.last().done();
    expect(await screen.findByRole("button", { name: /^2/ })).toBeVisible();
    clickAndFlush(within(h.lesson()).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(h.chat.conversation.pendingAsk()).toBeNull());
    expect(screen.queryByRole("button", { name: /^2/ })).toBeNull();
  });

  /** Starts `biteId` of the tour and has Coproducer answer it with a quiz. */
  async function quizzed(h: Awaited<ReturnType<typeof renderLesson>>, biteId: string) {
    h.start("tour", "asked", biteId as never);
    await waitFor(() => expect(h.client.turns).toHaveLength(1));
    h.client.last().emit({
      type: "ask",
      ask: {
        id: "quiz",
        question: "Which key opens the view?",
        options: [{ label: "2" }, { label: "5" }],
        multiSelect: false,
      },
    });
    h.client.last().done();
    expect(await screen.findByRole("button", { name: /^2/ })).toBeVisible();
  }

  it("puts a quiz away once its lesson is over", async () => {
    const h = await renderLesson();
    // The tour's Mixer is its last bite: Show me finishes the lesson.
    await quizzed(h, "tour-mixer");
    clickAndFlush(within(h.lesson()).getByRole("button", { name: "Show me" }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: LESSON_LABEL })).toBeNull(),
    );
    await waitFor(() => expect(h.chat.conversation.pendingAsk()).toBeNull());
    expect(screen.queryByRole("button", { name: /^2/ })).toBeNull();
  });

  it("puts a quiz away when another lesson from the list replaces its lesson", async () => {
    const h = await renderLesson();
    await quizzed(h, "tour-sequence");
    expect(h.chat.pickLesson("beat")).toBe(true);
    flush();
    expect(h.chat.lesson.state()?.lessonId).toBe("beat");
    await waitFor(() => expect(h.chat.conversation.pendingAsk()).toBeNull());
    expect(screen.queryByRole("button", { name: /^2/ })).toBeNull();
  });

  it("puts a quiz away that a replaced lesson's reply asks after the replacement", async () => {
    const h = await renderLesson();
    h.start("tour", "asked", "tour-sequence");
    await waitFor(() => expect(h.client.turns).toHaveLength(1));
    // Another lesson replaces the tour while the tour's reply is on its way.
    expect(h.chat.pickLesson("beat")).toBe(true);
    flush();
    expect(h.chat.lesson.state()?.lessonId).toBe("beat");
    // The tour's reply asks its quiz only now.
    h.client.last().emit({
      type: "ask",
      ask: {
        id: "quiz",
        question: "Which key opens Sequence?",
        options: [{ label: "2" }, { label: "5" }],
        multiSelect: false,
      },
    });
    h.client.last().done();
    await waitFor(() => expect(h.client.turns).toHaveLength(2));
    expect(h.chat.conversation.pendingAsk()).toBeNull();
    expect(screen.queryByRole("button", { name: /^2/ })).toBeNull();
  });

  it("opens the Library from its term in the step", async () => {
    const h = await renderLesson();
    h.start("beat", "asked", "beat-library");
    clickAndFlush(within(h.lesson()).getByRole("button", { name: "Library" }));
    expect(h.view()).toBe("library");
    expect(h.lesson()).toHaveTextContent(/Every sound Groove has/);
  });

  it("keeps focus in the plan when Show me finishes the step it was on", async () => {
    const h = await renderLesson();
    h.start("tour", "asked", "tour-mixer");
    const showMe = within(h.lesson()).getByRole("button", { name: "Show me" });
    showMe.focus();
    clickAndFlush(showMe);
    // The tour's Mixer is the chapter's last: the lesson is over.
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: LESSON_LABEL })).toBeNull(),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("textbox", { name: "Message Coproducer" }),
      ),
    );
  });

  it("keeps focus on the plan's next control as a bite ends under Show me", async () => {
    const h = await renderLesson();
    h.start("tour", "asked", "tour-sequence");
    const showMe = within(h.lesson()).getByRole("button", { name: "Show me" });
    showMe.focus();
    clickAndFlush(showMe);
    const next = await within(h.lesson()).findByRole("button", { name: /^Next: / });
    await waitFor(() => expect(document.activeElement).toBe(next));
  });

  it("keeps focus on the plan's next control when the browser blurs Show me as its step finishes", async () => {
    const restore = blurOnRemoveLikeChrome();
    try {
      const h = await renderLesson();
      h.start("tour", "asked", "tour-sequence");
      const showMe = within(h.lesson()).getByRole("button", { name: "Show me" });
      showMe.focus();
      // The step finishes on a later flush than the press, as the view Show me
      // asked for opens.
      h.setView("sequence");
      flush();
      const next = await within(h.lesson()).findByRole("button", { name: /^Next: / });
      await waitFor(() => expect(document.activeElement).toBe(next));
    } finally {
      restore();
    }
  });

  it("leaves focus on the page when the producer clicks away from Show me before its step finishes", async () => {
    const restore = blurOnRemoveLikeChrome();
    try {
      const h = await renderLesson();
      h.start("tour", "asked", "tour-sequence");
      const showMe = within(h.lesson()).getByRole("button", { name: "Show me" });
      showMe.focus();
      // A click on the canvas, which takes no focus.
      showMe.blur();
      await new Promise((settle) => setTimeout(settle, 0));
      h.setView("sequence");
      flush();
      await within(h.lesson()).findByRole("button", { name: /^Next: / });
      await new Promise((settle) => setTimeout(settle, 0));
      expect(document.activeElement).toBe(document.body);
    } finally {
      restore();
    }
  });

  it("leaves focus where the producer put it when they leave the plan", async () => {
    const h = await renderLesson();
    h.start("tour", "asked", "tour-sequence");
    const showMe = within(h.lesson()).getByRole("button", { name: "Show me" });
    showMe.focus();
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    h.setView("sequence");
    flush();
    await within(h.lesson()).findByRole("button", { name: /^Next: / });
    await new Promise((settle) => setTimeout(settle, 0));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("holds Show me while a library sound is on its way", async () => {
    let finish: (put: boolean) => void = () => {};
    const h = await renderLesson();
    h.putSound.mockImplementation(
      () =>
        new Promise<boolean>((done) => {
          finish = done;
        }),
    );
    h.start("beat", "asked", "beat-library");
    const showMe = within(h.lesson()).getByRole("button", { name: "Show me" });
    clickAndFlush(showMe);
    expect(showMe).toBeDisabled();
    clickAndFlush(showMe);
    expect(h.putSound).toHaveBeenCalledTimes(1);
    finish(false);
    await waitFor(() => expect(showMe).not.toBeDisabled());
  });
});
