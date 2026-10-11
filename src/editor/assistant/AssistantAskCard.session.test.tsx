import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import type { AssistantAsk } from "../../assistant/ask";
import type { AssistantProposal, AssistantStopReason } from "../../assistant/protocol";
import { ASSISTANT_TOOLSET_VERSION } from "../../assistant/tools";
import { createControlGesture } from "../../commands";
import { setParameter } from "../../commands/definitions/parameters";
import { createControlRegistry } from "../../controls/registry";
import type { Project } from "../../domain/entities";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { SONG_SWING, SONG_TEMPO } from "../../domain/parameters";
import { createInMemoryProjectRepository } from "../../persistence/inMemoryProjectRepository";
import { createManualClock } from "../../shared/clock";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import {
  createFakeAssistantClient,
  type FakeAssistantClient,
} from "../../testing/fakeAssistantClient";
import { memoryStorage } from "../../testing/storage";
import { assistantProposalTarget } from "../assistantProposalTarget";
import { EditorSession } from "../EditorSession";
import type { EditorLocation } from "../editorControls";
import type { EditorViewName } from "../editorViews";
import { ASK_CARD_LABEL } from "./AssistantAskCard";
import AssistantPanel from "./AssistantPanel";
import { useAskEditorLink } from "./useAskEditorLink";
import { useAssistantChat } from "./useAssistantChat";
import { useAssistantPanel } from "./useAssistantPanel";

/**
 * A question the assistant asks (GRV-42) beside a real editor session and
 * its proposal cards (GRV-5): it is answered by the producer's own edit, and
 * by nothing else that moves the song (a preview, a drag still held, a
 * proposal applied, a change made elsewhere); and hovering one of its options
 * leaves a proposal's preview where it is.
 */

afterEach(cleanup);

const ARRANGEMENT = {
  view: "arrangement",
  selection: { scopes: [], focus: null },
  padSelection: { trackId: null, padIds: [] },
  openPlacementId: null,
} as unknown as EditorLocation;

const tempoTo = (bpm: number) =>
  setParameter({ scope: "song", parameterId: SONG_TEMPO.id }, bpm);

/** An ask whose third option is answered by taking the tempo to 100 BPM or below. */
const RICH: AssistantAsk = {
  id: "toolu_rich",
  question: "What should change first?",
  options: [
    { label: "The opening", ref: { kind: "bars", startBar: 1, endBar: 2 } },
    { label: "Faster" },
    {
      label: "Slower",
      sound: {
        kind: "preview",
        calls: [{ name: "parameter_set", input: { ...tempoTo(100).payload } }],
      },
      doneWhen: { kind: "tempo", max: 100 },
    },
  ],
  multiSelect: false,
};

const DID_IT = '[Answer to "What should change first?"] Did it in the editor: Slower.';

async function setUp(start: Project = createSliceFixtureProject()) {
  const repository = createInMemoryProjectRepository();
  const created = await repository.createProject(start);
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
    project: start,
    clock: createManualClock(1_000),
    analytics,
    deviceStorage: memoryStorage(),
  });
  const client: FakeAssistantClient = createFakeAssistantClient();
  const track = start.song.tracks[0] ?? null;
  const [shown, setShown] = createSignal<Project>(session.project);
  const [previewing, setPreviewing] = createSignal(false);
  /** Stands in for the committed song moving without an edit event. */
  let committedOverride: Project | null = null;
  const committed = () => committedOverride ?? session.committedProject;
  session.subscribe((snapshot) => {
    setShown(snapshot.project);
    setPreviewing(snapshot.previewing);
  });
  const audio = {
    isPlaying: () => false,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    positionTicks: () => 0,
    seekTicks: vi.fn(),
    auditionTrack: vi.fn(async () => true),
  };

  const Harness = () => {
    const panel = useAssistantPanel({
      storage: memoryStorage(),
      analytics: () => analytics,
    });
    const link = useAskEditorLink({
      project: shown,
      session: {
        beginPreview: (commands) => session.beginPreview(commands),
        committedProject: () => session.committedProject,
        previewOpen: () => session.activePreview !== null,
      },
      audio,
      selectTrack: () => {},
      selectArrangement: () => {},
      mayStartSound: () => true,
    });
    const chat = useAssistantChat({
      project: shown,
      view: () => "arrangement" as EditorViewName,
      sources: () => ({ selection: null, track }),
      account: () => ({ registered: true }),
      expanded: () => panel.layout().mode === "floating",
      client: async () => client,
      analytics: () => analytics,
      committedProject: committed,
      link,
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
          revealControl: () => ARRANGEMENT,
          restoreView: () => {},
        },
      },
    });
    return (
      <>
        <button type="button" onClick={(event) => panel.toggle(event.currentTarget)}>
          Open it
        </button>
        <AssistantPanel panel={panel} chat={chat} />
      </>
    );
  };
  render(() => <Harness />);
  clickAndFlush(screen.getByRole("button", { name: "Open it" }));

  /** Sends a message; the turn stays open until the test finishes it. */
  async function send(text: string): Promise<void> {
    fireAndFlush(() => fireEvent.input(composer(), { target: { value: text } }));
    clickAndFlush(within(panel()).getByRole("button", { name: "Send" }));
    await settle();
  }

  /** Ends the open turn, with a proposal of `proposal` and/or the question. */
  function reply(options: {
    readonly ask?: AssistantAsk;
    readonly proposal?: AssistantProposal["calls"];
  }): void {
    fireAndFlush(() => {
      const turn = client.last();
      turn.text("Here is a thought.");
      if (options.proposal) {
        turn.emit({
          type: "proposal",
          proposal: {
            baseRevision: session.committedProject.metadata.revision,
            toolsetVersion: ASSISTANT_TOOLSET_VERSION,
            calls: options.proposal,
          },
        });
      }
      if (options.ask) turn.emit({ type: "ask", ask: options.ask });
      turn.emit({
        type: "done",
        stopped: false,
        stopReason: "tool_use" satisfies AssistantStopReason,
        requestsRemaining: 98,
      });
    });
  }

  const tempoCall = (bpm: number): AssistantProposal["calls"] => [
    { id: "toolu_tempo", name: "parameter_set", input: { ...tempoTo(bpm).payload } },
  ];

  const setCommitted = (project: Project) => {
    committedOverride = project;
  };

  return {
    session,
    repository,
    client,
    transport,
    send,
    reply,
    tempoCall,
    start,
    setCommitted,
  };
}

const panel = () => screen.getByRole("region", { name: "Assistant" });
const composer = () =>
  within(panel()).getByRole("textbox", { name: "Message the assistant" });
const askCard = () => within(panel()).queryByRole("region", { name: ASK_CARD_LABEL });
const proposalCard = () => within(panel()).getByRole("region", { name: /^Proposal\b/ });
const option = (name: RegExp) => {
  const card = askCard();
  if (!card) throw new Error("no question is waiting");
  return within(card).getByRole("button", { name });
};
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function press(element: HTMLElement): Promise<void> {
  element.focus();
  clickAndFlush(element);
  await settle();
  flush();
}

describe("a question answered by doing, against the editor session (GRV-42)", () => {
  it("is answered by the producer's own edit", async () => {
    const { session, client, transport, send, reply } = await setUp();
    await send("Teach me tempo");
    reply({ ask: RICH });
    expect(askCard()).toBeInTheDocument();

    fireAndFlush(() => session.dispatch(tempoTo(90)));
    await settle();
    expect(askCard()).toBeNull();
    expect(client.turns).toHaveLength(2);
    expect(client.last().request.messages.at(-1)?.text).toBe(DID_IT);
    const answered = transport.named("assistant_ask_answered");
    expect(answered).toHaveLength(1);
    expect(answered[0]?.params).toMatchObject({ how: "did_it", option_count: 3 });

    // A later edit has no question left to answer.
    fireAndFlush(() => session.dispatch(tempoTo(85)));
    await settle();
    expect(transport.named("assistant_ask_answered")).toHaveLength(1);
  });

  it("is not answered by applying a proposal that makes the change", async () => {
    const { session, client, transport, send, reply, tempoCall } = await setUp();
    await send("Slow it down?");
    reply({ ask: RICH, proposal: tempoCall(90) });
    expect(askCard()).toBeInTheDocument();

    await press(within(proposalCard()).getByRole("button", { name: "Apply" }));
    expect(session.committedProject.song.tempo).toBe(90);
    expect(askCard()).toBeInTheDocument();
    expect(client.turns).toHaveLength(1);
    expect(transport.named("assistant_ask_answered")).toHaveLength(0);

    // The producer's own edit after it, which leaves the tempo where the
    // proposal put it, does not answer it either.
    fireAndFlush(() => session.dispatch(tempoTo(95)));
    await settle();
    expect(askCard()).toBeInTheDocument();
    expect(client.turns).toHaveLength(1);
  });

  it("is not answered by a change adopted from elsewhere", async () => {
    const { session, repository, client, send, reply, start } = await setUp();
    await send("Teach me tempo");
    reply({ ask: RICH });
    let adopted = 0;
    session.subscribeRemoteChanges(() => {
      adopted += 1;
    });
    const saved = await repository.saveSong(
      start.metadata.id,
      { ...session.committedProject.song, tempo: 90 },
      session.committedProject.metadata.revision,
    );
    expect(saved.ok).toBe(true);
    await vi.waitFor(() => {
      flush();
      expect(adopted).toBe(1);
    });
    await settle();
    expect(askCard()).toBeInTheDocument();
    expect(client.turns).toHaveLength(1);
  });

  it("is not answered by a preview of the change", async () => {
    const { session, client, send, reply, tempoCall } = await setUp();
    await send("Slow it down?");
    reply({ ask: RICH, proposal: tempoCall(90) });
    await press(within(proposalCard()).getByRole("button", { name: "Preview" }));
    expect(session.project.song.tempo).toBe(90);
    await press(within(proposalCard()).getByRole("button", { name: "Cancel" }));
    await settle();
    expect(askCard()).toBeInTheDocument();
    expect(client.turns).toHaveLength(1);
  });

  it("is not answered by a drag that passes through the change and is cancelled; one let go there answers it", async () => {
    const { session, client, send, reply, start } = await setUp();
    await send("Teach me tempo");
    reply({ ask: RICH });

    const cancelled = session.beginGesture();
    fireAndFlush(() => cancelled.apply(tempoTo(105)));
    fireAndFlush(() => cancelled.apply(tempoTo(90)));
    await settle();
    expect(askCard()).toBeInTheDocument();
    fireAndFlush(() => cancelled.cancel());
    await settle();
    expect(session.committedProject.song.tempo).toBe(start.song.tempo);
    expect(askCard()).toBeInTheDocument();
    expect(client.turns).toHaveLength(1);

    const held = session.beginGesture();
    fireAndFlush(() => held.apply(tempoTo(95)));
    await settle();
    expect(askCard()).toBeInTheDocument();
    fireAndFlush(() => held.commit());
    await settle();
    expect(askCard()).toBeNull();
    expect(client.last().request.messages.at(-1)?.text).toBe(DID_IT);
  });

  it("is not answered by a change that was already made when it was asked", async () => {
    const slow = createSliceFixtureProject();
    const { session, client, send, reply } = await setUp({
      ...slow,
      song: { ...slow.song, tempo: 90 },
    });
    await send("Teach me tempo");
    reply({ ask: RICH });
    fireAndFlush(() => session.dispatch(tempoTo(95)));
    await settle();
    expect(askCard()).toBeInTheDocument();
    expect(client.turns).toHaveLength(1);
  });

  it("waits for a reply on its way, and forgets an edit taken back before it is done", async () => {
    const { session, client, send, reply, start } = await setUp();
    await send("Teach me tempo");
    reply({ ask: RICH });

    await send("Wait, what is a BPM?");
    fireAndFlush(() => session.dispatch(tempoTo(90)));
    fireAndFlush(() => session.dispatch(tempoTo(start.song.tempo)));
    reply({});
    await settle();
    expect(askCard()).toBeInTheDocument();
    expect(client.turns).toHaveLength(2);

    await send("And now?");
    fireAndFlush(() => session.dispatch(tempoTo(90)));
    await settle();
    expect(askCard()).toBeInTheDocument();
    reply({});
    await settle();
    expect(askCard()).toBeNull();
    expect(client.last().request.messages.at(-1)?.text).toContain("Did it in the editor");
  });

  it("is not answered once a reply ends if the song no longer holds the change then", async () => {
    const { session, client, transport, send, reply, start, setCommitted } =
      await setUp();
    await send("Teach me tempo");
    reply({ ask: RICH });

    await send("Wait, what is a BPM?");
    fireAndFlush(() => session.dispatch(tempoTo(90)));
    await settle();
    // Something that is no edit of the producer's (and so no edit event)
    // has taken the tempo back by the time the reply ends.
    setCommitted(start);
    reply({});
    await settle();
    expect(askCard()).toBeInTheDocument();
    expect(client.turns).toHaveLength(2);
    expect(transport.named("assistant_ask_answered")).toHaveLength(0);
  });

  it("is answered by dragging the swing control into an option's range", async () => {
    const { session, client, transport, send, reply, start } = await setUp();
    expect(start.song.swing).toBe(SONG_SWING.defaultValue);
    const swingTo = (value: number) =>
      setParameter({ scope: "song", parameterId: SONG_SWING.id }, value);
    const SWING: AssistantAsk = {
      id: "toolu_swing",
      question: "How much swing?",
      options: [
        { label: "Keep it straight" },
        { label: "A light shuffle", doneWhen: { kind: "swing", min: 54, max: 62 } },
        { label: "Heavy swing", doneWhen: { kind: "swing", min: 63 } },
      ],
      multiSelect: false,
    };
    await send("Teach me swing");
    reply({ ask: SWING });
    expect(askCard()).toBeInTheDocument();

    // The swing control's own path: one gesture, steps applied as it moves,
    // committed when it is let go (`useSongControls`).
    const control = createControlGesture({
      beginGesture: (options) => session.beginGesture(options),
      dispatch: (commands) => session.dispatch(commands),
      summary: () => "Set swing",
      command: swingTo,
    });
    fireAndFlush(() => control.input(54));
    fireAndFlush(() => control.input(58));
    await settle();
    expect(askCard()).toBeInTheDocument();
    fireAndFlush(() => control.commit(58));
    await settle();
    expect(session.committedProject.song.swing).toBe(58);
    expect(askCard()).toBeNull();
    expect(client.last().request.messages.at(-1)?.text).toBe(
      '[Answer to "How much swing?"] Did it in the editor: A light shuffle.',
    );
    expect(transport.named("assistant_ask_answered")[0]?.params).toMatchObject({
      how: "did_it",
    });
  });
});

describe("an option's sound beside a proposal's preview (GRV-42 with GRV-5)", () => {
  it("leaves the proposal's preview open on a hover", async () => {
    const { session, send, reply, tempoCall } = await setUp();
    await send("Slow it down?");
    reply({ ask: RICH, proposal: tempoCall(90) });
    await press(within(proposalCard()).getByRole("button", { name: "Preview" }));
    const proposalPreview = session.activePreview;
    expect(proposalPreview).not.toBeNull();

    fireAndFlush(() => fireEvent.pointerEnter(option(/Slower/)));
    await settle();
    expect(session.activePreview).toBe(proposalPreview);
    expect(session.project.song.tempo).toBe(90);
    fireAndFlush(() => fireEvent.pointerLeave(option(/Slower/)));
    await settle();
    expect(session.activePreview).toBe(proposalPreview);
    expect(
      within(proposalCard()).getByRole("button", { name: "Cancel" }),
    ).toBeInTheDocument();
  });
});
