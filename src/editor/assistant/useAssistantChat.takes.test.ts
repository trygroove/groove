import { createRoot, createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { expandTakesCall } from "../../assistant/takes";
import { ASSISTANT_TOOLSET_VERSION } from "../../assistant/tools";
import { setParameter } from "../../commands";
import { createControlRegistry } from "../../controls/registry";
import type { Project } from "../../domain/entities";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { TRACK_VOLUME } from "../../domain/parameters";
import { createInMemoryProjectRepository } from "../../persistence/inMemoryProjectRepository";
import { createManualClock } from "../../shared/clock";
import { createManualScheduler } from "../../shared/scheduler";
import { createFakeAssistantClient } from "../../testing/fakeAssistantClient";
import { memoryStorage } from "../../testing/storage";
import { offerTakesCall, TAKES_STEM } from "../../testing/takes";
import { assistantProposalTarget } from "../composition/assistantProposalTarget";
import { EditorSession } from "../composition/EditorSession";
import type { EditorLocation } from "../composition/editorControls";
import { type AssistantChat, useAssistantChat } from "./useAssistantChat";
import type { TurnOrigin } from "./useAssistantConversation";
import { useAssistantTakes } from "./useAssistantTakes";

/**
 * Four takes to pick from (GRV-207), against a real editor session: each take
 * heard in the song through the preview, one picked and applied through the
 * proposal path as one undo step, none applied when declined, and "4 more"
 * asking again for a fresh set.
 */

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const clipOf = (take: number) => `clp_${TAKES_STEM}${String(take).padStart(4, "0")}`;

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

async function setUp() {
  const repository = createInMemoryProjectRepository();
  const project = createSliceFixtureProject();
  const created = await repository.createProject(project);
  if (!created.ok) throw new Error("fixture project failed to create");
  const transport = createRecordingTransport();
  const analytics = new Analytics({
    transport,
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  analytics.setAccountType("registered");
  const session = new EditorSession({
    repository,
    project,
    clock: createManualClock(1_000),
    analytics,
    deviceStorage: memoryStorage(),
  });
  const client = createFakeAssistantClient();
  const track = project.song.tracks[0];
  if (!track) throw new Error("the fixture has no track");
  const [shown, setShown] = createSignal<Project>(session.project);
  const [previewing, setPreviewing] = createSignal(false);
  session.subscribe((snapshot) => {
    setShown(snapshot.project);
    setPreviewing(snapshot.previewing);
  });
  const [playing, setPlaying] = createSignal(false);
  let position = 1_536;
  const setPosition = (ticks: number) => {
    position = ticks;
  };
  const audio = {
    isPlaying: playing,
    play: vi.fn(async () => {
      setPlaying(true);
    }),
    pause: vi.fn(() => setPlaying(false)),
    positionTicks: () => position,
    seekTicks: vi.fn((ticks: number) => {
      position = ticks;
    }),
  };
  let chat: AssistantChat | undefined;
  disposers.push(
    createRoot((dispose) => {
      chat = useAssistantChat({
        project: shown,
        view: () => "arrangement",
        sources: () => ({ selection: null, track }),
        account: () => ({ registered: true }),
        expanded: () => true,
        client: async () => client,
        analytics: () => analytics,
        committedProject: () => session.committedProject,
        editor: {
          session: {
            proposalTarget: () => assistantProposalTarget(session),
            beginPreview: (commands) => session.beginPreview(commands),
            onEdit: (listener) => session.subscribeEdits(listener),
            onRemoteChange: (listener) => session.subscribeRemoteChanges(listener),
            previewing,
          },
          controls: {
            registry: createControlRegistry(),
            revealControl: vi.fn(() => ({}) as EditorLocation),
            restoreView: vi.fn(),
          },
          audio,
        },
        clock: createManualClock(1_000_000),
        scheduler: createManualScheduler(),
      });
      return dispose;
    }),
  );
  flush();
  await settle();
  if (!chat) throw new Error("the chat did not start");
  const theChat = chat;

  /**
   * Answers the turn on its way with an offer of four takes (the model's
   * call, `made`); returns its card's entry.
   */
  function offer(made = offerTakesCall(session.committedProject)): string {
    const written = expandTakesCall(
      {
        id: `toolu_takes_${theChat.conversation.entries().length}`,
        ...made,
      },
      TAKES_STEM,
    );
    if (!written.ok) throw new Error(written.message);
    client.last().text("Four takes of a lead.");
    client.last().emit({
      type: "proposal",
      proposal: {
        baseRevision: session.committedProject.metadata.revision,
        toolsetVersion: ASSISTANT_TOOLSET_VERSION,
        calls: [written.call],
      },
    });
    client.last().done();
    flush();
    const card = theChat.conversation
      .entries()
      .findLast((entry) => entry.kind === "takes");
    if (!card) throw new Error("no takes card");
    return card.id;
  }

  async function ask(): Promise<string> {
    expect(theChat.conversation.send("Write me a lead melody")).toBe(true);
    await settle();
    return offer();
  }

  const clips = () => session.committedProject.clips.map((clip) => clip.id);
  const shownClips = () => shown().clips.map((clip) => clip.id);
  /** The params of each `name` event, without the ones every event carries. */
  const named = (name: string) =>
    transport.named(name).map((event) => {
      const {
        account_type: _account,
        release_sha: _release,
        surface: _surface,
        ...own
      } = (event.params ?? {}) as Record<string, unknown>;
      return own;
    });

  return {
    chat: theChat,
    client,
    session,
    repository,
    project,
    audio,
    ask,
    offer,
    clips,
    shownClips,
    named,
    previewing,
    track,
    setPosition,
    setPlaying,
  };
}

describe("four takes to pick from (GRV-207)", () => {
  it("shows one card holding the four takes, nothing changed", async () => {
    const { chat, ask, clips } = await setUp();
    const before = clips();
    const entryId = await ask();
    const card = chat.takes?.card(entryId);
    expect(card?.status).toBe("choosing");
    expect(card?.part).toBe("Lead melody");
    expect(card?.takes.map((take) => take.fits)).toEqual([true, true, true, true]);
    expect(clips()).toEqual(before);
    // The proposal path has no card of its own until one is picked.
    expect(chat.conversation.entries().some((entry) => entry.kind === "proposal")).toBe(
      false,
    );
  });

  it("hears one take at a time in the song, from where it starts, and switches without stopping", async () => {
    const { chat, ask, audio, shownClips, clips, previewing } = await setUp();
    const entryId = await ask();
    const takes = chat.takes;
    if (!takes) throw new Error("no takes");

    takes.hear(entryId, 1);
    flush();
    expect(shownClips()).toContain(clipOf(2));
    expect(shownClips()).not.toContain(clipOf(1));
    expect(audio.seekTicks).toHaveBeenLastCalledWith(0);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(takes.card(entryId)?.hearing).toBe(1);

    // Instant: the preview swaps under the playing song.
    takes.hear(entryId, 2);
    flush();
    expect(shownClips()).toContain(clipOf(3));
    expect(shownClips()).not.toContain(clipOf(2));
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.pause).not.toHaveBeenCalled();
    expect(takes.card(entryId)?.hearing).toBe(2);

    // Pressed again, it stops: the song it started pauses back where it was.
    takes.hear(entryId, 2);
    flush();
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.seekTicks).toHaveBeenLastCalledWith(1_536);
    expect(previewing()).toBe(false);
    expect(takes.card(entryId)?.hearing).toBeNull();
    // Hearing never changed the song.
    expect(clips()).not.toContain(clipOf(3));
  });

  it("applies only the take picked, through the proposal path, as one undo step", async () => {
    const { chat, ask, clips, session, named, previewing } = await setUp();
    const entryId = await ask();
    const revision = session.committedProject.metadata.revision;
    chat.takes?.hear(entryId, 0);
    flush();
    chat.takes?.pick(entryId, 2);
    flush();

    expect(clips()).toContain(clipOf(3));
    for (const other of [1, 2, 4]) expect(clips()).not.toContain(clipOf(other));
    expect(session.committedProject.metadata.revision).toBe(revision + 1);
    expect(previewing()).toBe(false);
    expect(chat.takes?.card(entryId)?.status).toBe("picked");
    expect(chat.takes?.decided(entryId)).toBe(true);

    // The take became a proposal card, applied, titled by the take.
    const proposal = chat.conversation
      .entries()
      .findLast((entry) => entry.kind === "proposal");
    if (!proposal) throw new Error("no proposal card");
    expect(chat.proposals?.card(proposal.id)?.status).toBe("applied");
    expect(chat.proposals?.card(proposal.id)?.title).toBe("Lead melody · take 3");

    // One undo takes it all back out.
    session.undo();
    expect(clips()).not.toContain(clipOf(3));

    expect(named("assistant_take_picked")).toEqual([
      { position: 3, take_count: 4, reroll_count: 0 },
    ]);
    expect(named("feature_first_use")).toContainEqual({ feature: "assistant_takes" });
  });

  it("loses no choice to an edit after the offer: the card goes stale and Use this applies nothing", async () => {
    const { chat, ask, clips, session, track, named } = await setUp();
    const entryId = await ask();
    // The producer turns a fader down before picking: a song edit, which
    // moves the song under every take as it does under a proposal.
    session.dispatch(
      setParameter(
        { scope: "track", trackId: track.id, parameterId: TRACK_VOLUME.id },
        -6,
      ),
    );
    flush();
    const revision = session.committedProject.metadata.revision;
    expect(chat.takes?.card(entryId)?.status).toBe("stale");

    chat.takes?.pick(entryId, 2);
    flush();
    expect(clips()).not.toContain(clipOf(3));
    expect(session.committedProject.metadata.revision).toBe(revision);
    expect(chat.takes?.card(entryId)?.status).toBe("stale");
    expect(chat.takes?.decided(entryId)).toBe(false);
    expect(chat.conversation.entries().some((entry) => entry.kind === "proposal")).toBe(
      false,
    );
    expect(named("assistant_take_picked")).toEqual([]);
  });

  it("still uses a take after an edit that leaves it fitting", async () => {
    const { chat, ask, clips, session } = await setUp();
    const entryId = await ask();
    // Where the song loops: no take depends on it.
    session.dispatch({
      type: "loop.setEnabled",
      payload: { enabled: !session.committedProject.song.loop.enabled },
    });
    flush();
    expect(chat.takes?.card(entryId)?.status).toBe("choosing");
    chat.takes?.pick(entryId, 2);
    flush();
    expect(clips()).toContain(clipOf(3));
    expect(chat.takes?.card(entryId)?.status).toBe("picked");
  });

  it("jumps a song already playing elsewhere to where the take starts", async () => {
    const { chat, ask, audio, setPlaying, setPosition } = await setUp();
    const entryId = await ask();
    setPlaying(true);
    setPosition(3_072);
    flush();
    chat.takes?.hear(entryId, 0);
    flush();
    expect(audio.seekTicks).toHaveBeenLastCalledWith(0);
    expect(audio.play).not.toHaveBeenCalled();

    // Inside the take, the playhead stays where it is.
    audio.seekTicks.mockClear();
    setPosition(384);
    chat.takes?.hear(entryId, 1);
    flush();
    expect(audio.seekTicks).not.toHaveBeenCalled();
  });

  it("tells the next turn which take was picked", async () => {
    const { chat, ask, client } = await setUp();
    const entryId = await ask();
    chat.takes?.pick(entryId, 1);
    flush();
    expect(chat.conversation.send("Now some drums")).toBe(true);
    await settle();
    const said = client.last().request.messages.at(-2)?.text ?? "";
    expect(said).toContain("1. Sparse and low; 2. Busy and high");
    expect(said).toContain("They picked take 2");
    expect(said).toContain("[The producer applied this proposal.");
  });

  it("applies nothing when none is picked", async () => {
    const { chat, ask, clips, session, named, previewing } = await setUp();
    const before = clips();
    const revision = session.committedProject.metadata.revision;
    const entryId = await ask();
    chat.takes?.hear(entryId, 3);
    flush();
    chat.takes?.decline(entryId);
    flush();
    expect(clips()).toEqual(before);
    expect(session.committedProject.metadata.revision).toBe(revision);
    expect(previewing()).toBe(false);
    expect(chat.takes?.card(entryId)?.status).toBe("declined");
    expect(named("assistant_takes_declined")).toEqual([
      { take_count: 4, reroll_count: 0 },
    ]);
    expect(named("assistant_take_picked")).toEqual([]);
  });

  it("replaces the four with four more, asking again and applying nothing", async () => {
    const { chat, ask, offer, client, clips, named } = await setUp();
    const before = clips();
    const first = await ask();
    const tracks = client.last().request.context.tracks.length;
    // Pressed while a take is heard: the new turn reads the committed song.
    chat.takes?.hear(first, 1);
    flush();
    chat.takes?.more(first);
    flush();
    await settle();
    expect(client.last().request.context.tracks).toHaveLength(tracks);

    // A new turn: the request again, with the takes to move on from.
    expect(client.turns).toHaveLength(2);
    const asked = client.last().request.messages.at(-1)?.text ?? "";
    expect(asked.startsWith("Write me a lead melody")).toBe(true);
    expect(asked).toContain("[4 more]");
    expect(asked).toContain("Busy and high");
    // The offer's own line in the history says they were set aside, not
    // that the producer has yet to pick.
    const offered = client.last().request.messages.at(-2)?.text ?? "";
    expect(offered).toContain("They asked for 4 more instead");
    expect(offered).not.toContain("They have not picked one");
    expect(chat.takes?.card(first)?.status).toBe("more");
    expect(clips()).toEqual(before);
    expect(named("assistant_takes_rerolled")).toEqual([{ reroll_count: 1 }]);

    // The fresh set is a card of its own, and its pick counts the re-roll.
    const second = offer();
    expect(second).not.toBe(first);
    expect(chat.takes?.card(second)?.status).toBe("choosing");
    chat.takes?.more(second);
    flush();
    await settle();
    expect(named("assistant_takes_rerolled")).toEqual([
      { reroll_count: 1 },
      { reroll_count: 2 },
    ]);
    // Each "4 more" is the first request with one note naming every take
    // set aside, never the last turn's words with their note on top.
    const again = client.last().request.messages.at(-1)?.text ?? "";
    expect(again.startsWith("Write me a lead melody\n\n[4 more]")).toBe(true);
    expect(again.match(/\[4 more\]/g)).toHaveLength(1);
    expect(again).toContain("None of your last 8 takes");
    expect(again).toContain("8. Lots of space");
    const third = offer();
    chat.takes?.pick(third, 0);
    flush();
    expect(named("assistant_take_picked")).toEqual([
      { position: 1, take_count: 4, reroll_count: 2 },
    ]);
  });

  it("arrives out of date when a change made elsewhere landed while it was written", async () => {
    const { chat, client, session, repository, project, clips, offer } = await setUp();
    expect(chat.conversation.send("Write me a lead melody")).toBe(true);
    await settle();
    let adopted = 0;
    session.subscribeRemoteChanges(() => {
      adopted += 1;
    });
    const saved = await repository.saveMetadata(
      project.metadata.id,
      { name: "Renamed in another tab" },
      project.metadata.revision,
    );
    expect(saved.ok).toBe(true);
    await vi.waitFor(() => expect(adopted).toBe(1));
    const before = clips();
    const entryId = offer();
    expect(chat.takes?.card(entryId)?.status).toBe("stale");
    chat.takes?.pick(entryId, 0);
    chat.takes?.hear(entryId, 0);
    flush();
    expect(clips()).toEqual(before);
    expect(session.activePreview).toBeNull();
    expect(client.turns).toHaveLength(1);
  });

  it("says why once when not one take fits a song that did not move", async () => {
    const { chat, session, track, offer, named } = await setUp();
    expect(chat.conversation.send("Write me a lead melody")).toBe(true);
    await settle();
    // Every take makes its track under the ID of one the song already has.
    const made = offerTakesCall(session.committedProject);
    for (const take of made.input.takes) {
      for (const call of take.calls) {
        if (call.name === "track_create") call.input = { ...call.input, id: track.id };
        else call.input = { ...call.input, trackId: track.id };
      }
    }
    const entryId = offer(made);
    expect(chat.takes?.card(entryId)?.status).toBe("invalid");
    expect(named("assistant_takes_unfit")).toEqual([
      { issue_code: "rejected", take_count: 4 },
    ]);
    expect(named("feature_first_use")).not.toContainEqual({ feature: "assistant_takes" });
  });

  it("says nothing of a card whose takes fit", async () => {
    const { ask, named } = await setUp();
    await ask();
    expect(named("assistant_takes_unfit")).toEqual([]);
  });

  it("logs no take's notes, label or part", async () => {
    const { chat, ask, named } = await setUp();
    const entryId = await ask();
    chat.takes?.pick(entryId, 0);
    flush();
    const logged = JSON.stringify([
      ...named("assistant_take_picked"),
      ...named("feature_first_use"),
    ]);
    expect(logged).not.toContain("Lead");
    expect(logged).not.toContain("Sparse");
  });
});

describe("hearing a take whose preview cannot open (GRV-207)", () => {
  it("leaves the other proposal previews open and says so", () => {
    const project = createSliceFixtureProject();
    const repository = createInMemoryProjectRepository();
    const session = new EditorSession({
      repository,
      project,
      clock: createManualClock(1_000),
      analytics: new Analytics({
        transport: createRecordingTransport(),
        consent: new ConsentStore(memoryStorage()),
        storage: memoryStorage(),
      }),
      deviceStorage: memoryStorage(),
    });
    const onPreviewOpen = vi.fn();
    const beginPreview = vi.fn(
      () =>
        ({ ok: false, issues: [] }) as unknown as ReturnType<
          EditorSession["beginPreview"]
        >,
    );
    let takes: ReturnType<typeof useAssistantTakes> | undefined;
    disposers.push(
      createRoot((dispose) => {
        takes = useAssistantTakes({
          session: {
            proposalTarget: () => assistantProposalTarget(session),
            beginPreview,
            onEdit: (listener) => session.subscribeEdits(listener),
            onRemoteChange: (listener) => session.subscribeRemoteChanges(listener),
            previewing: () => false,
          },
          project: () => session.project,
          analytics: () => {
            throw new Error("no analytics here");
          },
          onPreviewOpen,
          onPick: vi.fn(),
          onMore: () => false,
        });
        return dispose;
      }),
    );
    const written = expandTakesCall(
      { id: "toolu_takes", ...offerTakesCall(project) },
      TAKES_STEM,
    );
    if (!written.ok || !takes) throw new Error("no offer");
    takes.receive("entry-1", written.call, project.metadata.revision, {
      text: "Write me a lead melody",
      scope: { kind: "song", label: "Song", track: null },
      remoteChanges: 0,
    } as unknown as TurnOrigin);
    flush();
    takes.hear("entry-1", 0);
    flush();
    expect(beginPreview).toHaveBeenCalledTimes(1);
    expect(onPreviewOpen).not.toHaveBeenCalled();
    expect(takes.card("entry-1")?.hearing).toBeNull();
    expect(takes.card("entry-1")?.notice).not.toBeNull();
  });

  it("takes back the outcome when 4 more could not ask", () => {
    const project = createSliceFixtureProject();
    const session = new EditorSession({
      repository: createInMemoryProjectRepository(),
      project,
      clock: createManualClock(1_000),
      analytics: new Analytics({
        transport: createRecordingTransport(),
        consent: new ConsentStore(memoryStorage()),
        storage: memoryStorage(),
      }),
      deviceStorage: memoryStorage(),
    });
    const outcomes: string[] = [];
    let takes: ReturnType<typeof useAssistantTakes> | undefined;
    disposers.push(
      createRoot((dispose) => {
        takes = useAssistantTakes({
          session: {
            proposalTarget: () => assistantProposalTarget(session),
            beginPreview: (commands) => session.beginPreview(commands),
            onEdit: (listener) => session.subscribeEdits(listener),
            onRemoteChange: (listener) => session.subscribeRemoteChanges(listener),
            previewing: () => false,
          },
          project: () => session.project,
          analytics: () => {
            throw new Error("no analytics here");
          },
          onPick: vi.fn(),
          onMore: () => {
            outcomes.push("asked");
            return false;
          },
          onOutcome: (_entry, outcome) => outcomes.push(outcome),
        });
        return dispose;
      }),
    );
    const written = expandTakesCall(
      { id: "toolu_takes", ...offerTakesCall(project) },
      TAKES_STEM,
    );
    if (!written.ok || !takes) throw new Error("no offer");
    takes.receive("entry-1", written.call, project.metadata.revision, {
      text: "Write me a lead melody",
      scope: { kind: "song", label: "Song", track: null },
      remoteChanges: 0,
    } as unknown as TurnOrigin);
    flush();
    takes.more("entry-1");
    flush();
    // Recorded before the turn goes, so its history says so; taken back when it cannot.
    expect(outcomes).toEqual(["more", "asked", "pending"]);
    expect(takes.card("entry-1")?.status).toBe("choosing");
  });
});
