import { createRoot, createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { expandTakesCall } from "../../assistant/takes";
import { ASSISTANT_TOOLSET_VERSION } from "../../assistant/tools";
import { createControlRegistry } from "../../controls/registry";
import type { Project } from "../../domain/entities";
import { createSliceFixtureProject } from "../../domain/fixtures";
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

  /** Answers the turn on its way with an offer of four takes; returns its card's entry. */
  function offer(): string {
    const written = expandTakesCall(
      {
        id: `toolu_takes_${theChat.conversation.entries().length}`,
        ...offerTakesCall(session.committedProject),
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
    audio,
    ask,
    offer,
    clips,
    shownClips,
    named,
    previewing,
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
    const third = offer();
    chat.takes?.pick(third, 0);
    flush();
    expect(named("assistant_take_picked")).toEqual([
      { position: 1, take_count: 4, reroll_count: 2 },
    ]);
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
