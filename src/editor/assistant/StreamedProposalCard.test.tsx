import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { proposalNote } from "../../assistant/history";
import type { AssistantProposalPart, AssistantToolCall } from "../../assistant/protocol";
import {
  ASSISTANT_TOOLSET_VERSION,
  CREATE_EXAMPLES,
  EXPLAIN_TOOL_NAME,
} from "../../assistant/tools";
import type { ControlAddress } from "../../commands/controlAddress";
import { setParameter } from "../../commands/definitions/parameters";
import { removeTrack } from "../../commands/definitions/tracks";
import { createControlRegistry } from "../../controls/registry";
import type { Project } from "../../domain/entities";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { SONG_SWING, TRACK_VOLUME } from "../../domain/parameters";
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
import AssistantPanel from "./AssistantPanel";
import {
  type ConversationStore,
  conversationStorageKey,
  createConversationStore,
} from "./conversationStore";
import { useAssistantChat } from "./useAssistantChat";
import { continueNote, refreshNote } from "./useAssistantConversation";
import { useAssistantPanel } from "./useAssistantPanel";

/**
 * A proposal that arrives part by part (GRV-144), against a real editor
 * session: lines appear in call order while the turn streams, each part
 * applies as its own undo step, a part that needs another waits for it,
 * Apply all takes the rest as one, a part the song moved under offers
 * Refresh, and a turn that fails partway leaves its parts applicable.
 */

afterEach(cleanup);

const ARRANGEMENT = {
  view: "arrangement",
  selection: { scopes: [], focus: null },
  padSelection: { trackId: null, padIds: [] },
  openPlacementId: null,
} as unknown as EditorLocation;

/** Swing to 58%: a part on the song, needing nothing. */
const SWING: AssistantToolCall = {
  id: "toolu_swing",
  name: "parameter_set",
  input: { target: { scope: "song", parameterId: SONG_SWING.id }, value: 58 },
};
/** A Bass track, a one-bar clip on it, and that clip placed: each needs the one before. */
const TRACK: AssistantToolCall = {
  id: "toolu_track",
  name: "track_create",
  input: CREATE_EXAMPLES.track,
};
const CLIP: AssistantToolCall = {
  id: "toolu_clip",
  name: "clip_create",
  input: CREATE_EXAMPLES.clip,
};
const PLACEMENT: AssistantToolCall = {
  id: "toolu_place",
  name: "placement_create",
  input: CREATE_EXAMPLES.placement,
};
const EXPLAIN: AssistantToolCall = {
  id: "toolu_why",
  name: EXPLAIN_TOOL_NAME,
  input: { goal: "A bassline under the kick.", technique: "Root notes on the one." },
};

async function setUp(
  options: {
    /** Where the conversation is kept across a reload (GRV-135). */
    conversationStore?: ConversationStore;
  } = {},
) {
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
  const clock = createManualClock(1_000);
  const session = new EditorSession({
    repository,
    project,
    clock,
    analytics,
    deviceStorage: memoryStorage(),
  });
  const client: FakeAssistantClient = createFakeAssistantClient();
  const registry = createControlRegistry();
  const revealControl = vi.fn(
    (_address: ControlAddress, _options?: { focus?: boolean }) => ARRANGEMENT,
  );
  const track = project.song.tracks[0];
  if (!track) throw new Error("the fixture has no track");

  const [shown, setShown] = createSignal<Project>(session.project);
  const [previewing, setPreviewing] = createSignal(false);
  session.subscribe((snapshot) => {
    setShown(snapshot.project);
    setPreviewing(snapshot.previewing);
  });

  const Harness = () => {
    const panel = useAssistantPanel({
      storage: memoryStorage(),
      analytics: () => analytics,
    });
    const chat = useAssistantChat({
      project: shown,
      view: () => "arrangement" as EditorViewName,
      sources: () => ({ selection: null, track }),
      account: () => ({ registered: true }),
      expanded: () => panel.layout().mode === "floating",
      client: async () => client,
      analytics: () => analytics,
      clock,
      ...(options.conversationStore
        ? {
            conversationKey: () => conversationStorageKey("u1", project.metadata.id),
            conversationStore: options.conversationStore,
          }
        : {}),
      editor: {
        session: {
          proposalTarget: () => assistantProposalTarget(session),
          beginPreview: (commands) => session.beginPreview(commands),
          onEdit: (listener) => session.subscribeEdits(listener),
          onRemoteChange: (listener) => session.subscribeRemoteChanges(listener),
          previewing,
        },
        controls: { registry, revealControl, restoreView: vi.fn() },
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

  let parts = 0;
  /** Sends "Add a bassline" and leaves the turn running. */
  async function ask() {
    fireAndFlush(() =>
      fireEvent.input(composer(), { target: { value: "Add a bassline" } }),
    );
    clickAndFlush(button("Send"));
    await settle();
    parts = 0;
  }
  /** Streams one accepted call, as the gateway does. */
  function part(call: AssistantToolCall) {
    const streamed: AssistantProposalPart = {
      index: parts,
      toolsetVersion: ASSISTANT_TOOLSET_VERSION,
      call,
    };
    parts += 1;
    fireAndFlush(() => client.last().emit({ type: "part", part: streamed }));
  }
  /** Ends the turn with the whole proposal: `calls`, and the explanation. */
  function finish(calls: readonly AssistantToolCall[]) {
    fireAndFlush(() => {
      client.last().emit({
        type: "proposal",
        proposal: {
          baseRevision: client.last().request.projectRevision,
          toolsetVersion: ASSISTANT_TOOLSET_VERSION,
          calls: [...calls, EXPLAIN],
        },
      });
      client.last().done();
    });
  }
  const events = (name: string) =>
    transport.events.filter((event) => event.name === name);
  const swing = () => session.committedProject.song.swing;
  const hasBass = () =>
    session.committedProject.song.tracks.some((candidate) => candidate.name === "Bass");

  /** Ends the turn with an error, partway. */
  function fail() {
    fireAndFlush(() => client.last().fail({ code: "timeout", retryable: true }));
  }
  /** BD's volume to `value` dB: a part on the fixture's own track. */
  const volume = (value: number): AssistantToolCall => ({
    id: `toolu_volume_${value}`,
    name: "parameter_set",
    input: {
      target: { scope: "track", trackId: track.id, parameterId: TRACK_VOLUME.id },
      value,
    },
  });
  /** The producer sets BD's volume by hand. */
  const editVolume = (value: number) =>
    fireAndFlush(() =>
      session.dispatch(
        setParameter(
          { scope: "track", trackId: track.id, parameterId: TRACK_VOLUME.id },
          value,
        ),
      ),
    );

  /** Sends `text` as a new turn and ends it at once, with no reply. */
  async function say(text: string) {
    fireAndFlush(() => fireEvent.input(composer(), { target: { value: text } }));
    clickAndFlush(button("Send"));
    await settle();
    fireAndFlush(() => client.last().done());
  }

  return {
    session,
    client,
    clock,
    say,
    track,
    ask,
    part,
    finish,
    fail,
    volume,
    editVolume,
    events,
    swing,
    hasBass,
  };
}

const panel = () => screen.getByRole("region", { name: "Coproducer" });
const composer = () =>
  within(panel()).getByRole("textbox", { name: "Message Coproducer" });
const button = (name: string | RegExp) => within(panel()).getByRole("button", { name });
const card = () => within(panel()).getByRole("region", { name: /^Proposal\b/ });
const cardButton = (name: string) => within(card()).getByRole("button", { name });
const cardStatus = () => within(card()).getByRole("status");
const lines = () =>
  within(within(card()).getByRole("list", { name: "Changes" })).getAllByRole("listitem");
const lineTexts = () =>
  lines().map(
    (line) => line.querySelector(".assistant-proposal-part-text")?.textContent ?? "",
  );
const applyOf = (text: string) => cardButton(`Apply ${text}`);
const applyAt = (index: number) =>
  within(lines()[index] as HTMLElement).getByRole("button", { name: /^Apply / });
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function press(element: HTMLElement): Promise<void> {
  element.focus();
  clickAndFlush(element);
  await settle();
  flush();
}

describe("a proposal that arrives part by part (GRV-144)", () => {
  it("shows each part as it lands, in call order, the track and its length", async () => {
    const { ask, part, finish } = await setUp();
    await ask();
    part(TRACK);
    expect(lineTexts()).toEqual(["Bass · new track"]);
    expect(cardStatus()).toHaveTextContent("Still writing.");
    expect(within(card()).getByText("More parts on the way…")).toBeInTheDocument();
    // Apply all waits for the turn to end.
    expect(cardButton("Apply all")).toBeDisabled();
    part(CLIP);
    part(SWING);
    expect(lineTexts()).toEqual([
      "Bass · new track",
      "Bass · 1 bar",
      "Swing 50% → to 58%",
    ]);
    finish([TRACK, CLIP, SWING]);
    expect(lineTexts()).toEqual([
      "Bass · new track",
      "Bass · 1 bar",
      "Swing 50% → to 58%",
    ]);
    expect(within(card()).queryByText("More parts on the way…")).toBeNull();
    expect(cardStatus()).toHaveTextContent("Nothing has changed yet.");
    expect(within(card()).getByText("Why this works")).toBeInTheDocument();
  });

  it("never shows a call the gateway refused, though the whole proposal names it", async () => {
    const { ask, part, finish } = await setUp();
    await ask();
    part(SWING);
    // The gateway sent the volume call back to the model, so it never streamed.
    const refused: AssistantToolCall = {
      id: "toolu_bad",
      name: "parameter_set",
      input: { target: { scope: "song", parameterId: SONG_SWING.id }, value: 99 },
    };
    finish([SWING, refused]);
    expect(lineTexts()).toEqual(["Swing 50% → to 58%"]);
    expect(cardButton("Apply all")).toBeEnabled();
  });

  it("applies one part as its own undo step, and undo removes only it", async () => {
    const { ask, part, session, swing, hasBass } = await setUp();
    await ask();
    part(SWING);
    part(TRACK);
    await press(applyOf("Swing 50% to 58%"));
    expect(session.history.entries).toHaveLength(1);
    expect(swing()).toBe(58);
    expect(hasBass()).toBe(false);

    await press(applyOf("Bass · new track"));
    expect(session.history.entries).toHaveLength(2);
    expect(hasBass()).toBe(true);
    expect(within(lines()[1] as HTMLElement).getByText("Applied")).toBeInTheDocument();

    fireAndFlush(() => session.undo());
    expect(hasBass()).toBe(false);
    expect(swing()).toBe(58);
    expect(session.history.entries).toHaveLength(1);
    // The part undone can be applied again.
    expect(applyOf("Bass · new track")).toBeEnabled();
  });

  it("keeps a part that needs another disabled until that one is applied", async () => {
    const { ask, part, hasBass } = await setUp();
    await ask();
    part(TRACK);
    part(CLIP);
    part(PLACEMENT);
    const clip = applyAt(1);
    expect(clip).toBeDisabled();
    expect(clip).toHaveAccessibleDescription("Needs Bass first");
    // The placement needs the track and the clip; it names the first.
    expect(applyAt(2)).toHaveAccessibleDescription("Needs Bass first");

    await press(applyOf("Bass · new track"));
    expect(hasBass()).toBe(true);
    expect(applyAt(1)).toBeEnabled();
    expect(applyAt(1)).not.toHaveAccessibleDescription();
    expect(within(lines()[0] as HTMLElement).getByText("Applied")).toBeInTheDocument();
    // The placement needs the clip too, which is not applied yet.
    expect(applyAt(2)).toBeDisabled();
    expect(applyAt(2)).toHaveAccessibleDescription("Needs Bass · 1 bar first");
  });

  it("applies only the rest with Apply all, as one undo step", async () => {
    const { ask, part, finish, session, swing, hasBass } = await setUp();
    await ask();
    part(SWING);
    part(TRACK);
    part(CLIP);
    await press(applyOf("Swing 50% to 58%"));
    finish([SWING, TRACK, CLIP]);
    await press(cardButton("Apply all"));

    expect(session.history.entries).toHaveLength(2);
    expect(hasBass()).toBe(true);
    expect(session.committedProject.clips.some((clip) => clip.name === "Bassline")).toBe(
      true,
    );
    expect(cardStatus()).toHaveTextContent(
      "Applied in 2 undo steps: 1 part on its own, the rest with Apply all.",
    );
    // One undo takes the rest away together, and leaves the swing.
    await press(cardButton("Undo"));
    expect(hasBass()).toBe(false);
    expect(swing()).toBe(58);
    expect(session.history.entries).toHaveLength(1);
  });

  it("goes out of date when the producer edits what a part touches, and offers Refresh", async () => {
    const { ask, part, finish, session, client } = await setUp();
    await ask();
    part(SWING);
    part(TRACK);
    fireAndFlush(() =>
      session.dispatch(setParameter({ scope: "song", parameterId: SONG_SWING.id }, 54)),
    );
    expect(
      within(lines()[0] as HTMLElement).getByText("Out of date"),
    ).toBeInTheDocument();
    // A part on something else is untouched by it.
    expect(applyOf("Bass · new track")).toBeEnabled();
    finish([SWING, TRACK]);
    expect(cardButton("Apply all")).toBeDisabled();
    expect(cardStatus()).toHaveTextContent("Some parts are out of date");
    await press(cardButton("Refresh"));
    expect(client.turns).toHaveLength(2);
    expect(client.turns[1]?.request.messages.at(-1)).toEqual({
      role: "user",
      text: "Add a bassline",
    });
    expect(within(card()).queryByRole("button", { name: "Refresh" })).toBeNull();
  });

  it("tells Refresh which parts were applied, so the new proposal does not repeat them", async () => {
    const { ask, part, finish, session, client, hasBass } = await setUp();
    await ask();
    part(TRACK);
    part(SWING);
    await press(applyOf("Bass · new track"));
    fireAndFlush(() =>
      session.dispatch(setParameter({ scope: "song", parameterId: SONG_SWING.id }, 54)),
    );
    finish([TRACK, SWING]);
    await press(cardButton("Refresh"));
    expect(client.turns).toHaveLength(2);
    expect(client.turns[1]?.request.messages.at(-1)?.text).toBe(
      `Add a bassline\n\n${refreshNote([
        { text: "Bass · new track", applied: true },
        { text: "Swing 50% to 58%", applied: false },
      ])}`,
    );
    expect(hasBass()).toBe(true);
  });

  it("goes out of date when another streamed card applies a change to what a part touches", async () => {
    const { ask, part, finish, volume, session, track } = await setUp();
    await ask();
    part(volume(-6));
    finish([volume(-6)]);
    await ask();
    part(volume(-3));
    finish([volume(-3)]);
    const [first, second] = within(panel()).getAllByRole("region", {
      name: /^Proposal\b/,
    });
    if (!first || !second) throw new Error("two proposal cards were expected");
    await press(within(first).getByRole("button", { name: /^Apply BD/ }));
    const volumeOf = () =>
      session.committedProject.song.tracks.find((candidate) => candidate.id === track.id)
        ?.mixer.volume;
    expect(volumeOf()).toBe(-6);
    const rows = within(
      within(second).getByRole("list", { name: "Changes" }),
    ).getAllByRole("listitem");
    expect(within(rows[0] as HTMLElement).getByText("Out of date")).toBeInTheDocument();
    expect(within(second).getByRole("button", { name: "Apply all" })).toBeDisabled();
  });

  it("arrives out of date when the producer edited what it touches while it was written", async () => {
    const { ask, part, session } = await setUp();
    await ask();
    fireAndFlush(() =>
      session.dispatch(setParameter({ scope: "song", parameterId: SONG_SWING.id }, 54)),
    );
    part(SWING);
    part(TRACK);
    expect(
      within(lines()[0] as HTMLElement).getByText("Out of date"),
    ).toBeInTheDocument();
    expect(applyOf("Bass · new track")).toBeEnabled();
  });

  it("says why a part does not fit, and becomes a refused proposal when none does (GRV-98)", async () => {
    const { ask, part, finish } = await setUp();
    await ask();
    // A clip for a track nobody made.
    part(CLIP);
    expect(
      within(lines()[0] as HTMLElement).getByText("Can't apply"),
    ).toBeInTheDocument();
    expect(lines()[0]).toHaveTextContent("doesn't fit with the rest of your song");
    finish([CLIP]);
    expect(cardStatus()).toHaveTextContent(
      "It can't be applied as it is. Nothing changed.",
    );
    expect(within(card()).getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(within(card()).queryByRole("button", { name: "Apply all" })).toBeNull();
  });

  it("keeps what arrived applicable when the turn fails partway, and Try again asks for the rest", async () => {
    const { ask, part, client, session, hasBass } = await setUp();
    await ask();
    part(TRACK);
    fireAndFlush(() => client.last().fail({ code: "timeout", retryable: true }));
    expect(cardStatus()).toHaveTextContent("The rest of this proposal didn't arrive.");
    // The error says what went wrong; the card is what offers Try again.
    expect(within(panel()).getAllByRole("button", { name: "Try again" })).toHaveLength(1);
    await press(applyOf("Bass · new track"));
    expect(hasBass()).toBe(true);
    expect(session.history.entries).toHaveLength(1);
    // Apply all takes what arrived once the turn is over.
    expect(cardButton("Apply all")).toBeDisabled();

    await press(cardButton("Try again"));
    expect(client.turns).toHaveLength(2);
    const sent = client.turns[1]?.request;
    expect(sent?.messages.at(-1)?.text).toBe(
      `Add a bassline\n\n${continueNote([{ text: "Bass · new track", applied: true }])}`,
    );
    expect(sent?.projectRevision).toBe(session.committedProject.metadata.revision);
    expect(sent?.context.tracks.some((candidate) => candidate.name === "Bass")).toBe(
      true,
    );
  });

  it("still offers Try again when the card was cancelled before its turn failed", async () => {
    const { ask, part, fail, client } = await setUp();
    await ask();
    part(TRACK);
    await press(cardButton("Cancel"));
    fail();
    expect(cardStatus()).toHaveTextContent(
      "Cancelled. Nothing changed. The rest of this proposal didn't arrive.",
    );
    expect(within(panel()).getAllByRole("button", { name: "Try again" })).toHaveLength(1);
    await press(cardButton("Try again"));
    expect(client.turns).toHaveLength(2);
    expect(client.turns[1]?.request.messages.at(-1)?.text).toBe(
      `Add a bassline\n\n${continueNote([{ text: "Bass · new track", applied: false }])}`,
    );
  });

  it("previews the parts shown so far, and takes in each new one while the turn runs", async () => {
    const { ask, part, session } = await setUp();
    await ask();
    part(SWING);
    await press(cardButton("Preview"));
    expect(session.activePreview).not.toBeNull();
    expect(session.project.song.swing).toBe(58);
    expect(session.committedProject.song.swing).toBe(50);
    part(TRACK);
    expect(session.activePreview).not.toBeNull();
    expect(session.project.song.tracks.some((t) => t.name === "Bass")).toBe(true);
    expect(session.history.canUndo).toBe(false);
    expect(cardButton("Preview")).toHaveAttribute("aria-pressed", "true");
    await press(cardButton("Cancel"));
    expect(session.activePreview).toBeNull();
    expect(session.project.song.swing).toBe(50);
  });

  it("logs the first part once per proposal, and each part applied once", async () => {
    const { ask, part, finish, events, clock } = await setUp();
    await ask();
    clock.advance(1_200);
    part(SWING);
    part(TRACK);
    expect(events("assistant_proposal_first_part_shown").map((e) => e.params)).toEqual([
      expect.objectContaining({ elapsed_ms_bucket: "500ms_2s" }),
    ]);
    await press(applyOf("Bass · new track"));
    finish([SWING, TRACK]);
    await press(applyOf("Swing 50% to 58%"));
    expect(events("assistant_proposal_part_applied").map((e) => e.params)).toEqual([
      expect.objectContaining({ part_index: 1, turn_running: true }),
      expect.objectContaining({ part_index: 0, turn_running: false }),
    ]);
    const firstUse = events("feature_first_use").filter(
      (event) => event.params.feature === "assistant_proposal_part",
    );
    expect(firstUse).toHaveLength(1);
  });

  it("tells Try again which parts were shown, and withdraws those not applied", async () => {
    const { ask, part, fail, client, session, hasBass } = await setUp();
    await ask();
    part(TRACK);
    part(CLIP);
    part(SWING);
    await press(applyOf("Bass · new track"));
    fail();
    expect(applyOf("Bass · 1 bar")).toBeEnabled();

    const oldCard = card();
    await press(cardButton("Try again"));
    const sent = client.turns[1]?.request.messages.at(-1)?.text ?? "";
    expect(sent).toContain("Applied, so the song has them now");
    expect(sent).toContain("- Bass · new track");
    expect(sent).toContain(
      "Not applied, and withdrawn; propose them again only if the song still needs them:\n- Bass · 1 bar\n- Swing 50% to 58%",
    );
    // The old card's parts not applied can no longer go in, alone or together.
    const rows = within(within(oldCard).getByRole("list", { name: "Changes" }))
      .getAllByRole("listitem")
      .map((row) => row.textContent ?? "");
    expect(rows[0]).toContain("Applied");
    expect(rows[1]).toContain("Withdrawn");
    expect(rows[2]).toContain("Withdrawn");
    expect(
      within(oldCard).queryByRole("button", { name: /^Apply Bass · 1 bar/ }),
    ).toBeNull();
    expect(within(oldCard).getByRole("button", { name: "Apply all" })).toBeDisabled();
    expect(within(oldCard).getByRole("status")).toHaveTextContent(
      "the parts not applied here are withdrawn",
    );
    expect(hasBass()).toBe(true);
    expect(session.history.entries).toHaveLength(1);
  });

  it("checks a new part against the parts before it that still apply, skipping one that no longer does", async () => {
    const { ask, part, volume, session, track } = await setUp();
    await ask();
    part(volume(-6));
    // First in the list, so it still goes in once BD is gone.
    part({ ...TRACK, input: { ...CREATE_EXAMPLES.track, order: 0 } });
    // The producer deletes BD, so its volume part no longer applies.
    fireAndFlush(() => session.dispatch(removeTrack(track.id)));
    part(CLIP);
    expect(
      within(lines()[0] as HTMLElement).getByText("Out of date"),
    ).toBeInTheDocument();
    // The clip is read on top of the Bass track, not on the bare song.
    expect(within(lines()[2] as HTMLElement).queryByText("Can't apply")).toBeNull();
    expect(lineTexts()[2]).toBe("Bass · 1 bar");
    expect(applyAt(2)).toBeDisabled();
    expect(applyAt(2)).toHaveAccessibleDescription("Needs Bass first");
  });

  it("says Apply all of every part went in as one undo step", async () => {
    const { ask, part, finish } = await setUp();
    await ask();
    part(SWING);
    part(TRACK);
    finish([SWING, TRACK]);
    await press(cardButton("Apply all"));
    expect(cardStatus()).toHaveTextContent("Applied as one undo step.");
  });

  it("says Apply all goes in as one undo step even with one part left", async () => {
    const { ask, part, finish } = await setUp();
    await ask();
    part(SWING);
    part(TRACK);
    await press(applyOf("Swing 50% to 58%"));
    finish([SWING, TRACK]);
    await press(cardButton("Apply all"));
    expect(cardStatus()).toHaveTextContent(
      "Applied in 2 undo steps: 1 part on its own, the rest with Apply all.",
    );
    expect(cardStatus()).not.toHaveTextContent("Each part is its own undo step");
  });

  it("says why Apply all is off when a part can't be applied", async () => {
    const { ask, part, finish } = await setUp();
    await ask();
    part(SWING);
    part(CLIP);
    finish([SWING, CLIP]);
    expect(cardButton("Apply all")).toBeDisabled();
    expect(cardStatus()).toHaveTextContent(
      "Apply all is off because a part can't be applied; apply the others one at a time.",
    );
  });

  it("says why Apply all is off while a part is out of date", async () => {
    const { ask, part, finish, session } = await setUp();
    await ask();
    part(SWING);
    part(TRACK);
    fireAndFlush(() =>
      session.dispatch(setParameter({ scope: "song", parameterId: SONG_SWING.id }, 54)),
    );
    finish([SWING, TRACK]);
    expect(cardStatus()).toHaveTextContent(
      "Apply all is off while a part is out of date.",
    );
  });
});

describe("a streamed proposal's analytics, as a whole proposal's (GRV-144)", () => {
  it("logs assistant_proposal_applied once, when the last part is applied one at a time", async () => {
    const { ask, part, finish, events } = await setUp();
    await ask();
    part(SWING);
    part(TRACK);
    await press(applyOf("Swing 50% to 58%"));
    finish([SWING, TRACK]);
    expect(events("assistant_proposal_applied")).toHaveLength(0);
    await press(applyOf("Bass · new track"));
    expect(events("assistant_proposal_applied").map((event) => event.params)).toEqual([
      expect.objectContaining({ capability: "mixed", command_count_bucket: "2_5" }),
    ]);
  });

  it("logs assistant_proposal_applied once when every part was applied while the turn ran", async () => {
    const { ask, part, finish, events } = await setUp();
    await ask();
    part(SWING);
    await press(applyOf("Swing 50% to 58%"));
    expect(events("assistant_proposal_applied")).toHaveLength(0);
    finish([SWING]);
    expect(events("assistant_proposal_applied")).toHaveLength(1);
  });

  it("logs assistant_proposal_applied once for Apply all, not again on a redo", async () => {
    const { ask, part, finish, events, session } = await setUp();
    await ask();
    part(SWING);
    part(TRACK);
    finish([SWING, TRACK]);
    await press(cardButton("Apply all"));
    expect(events("assistant_proposal_applied")).toHaveLength(1);
    fireAndFlush(() => session.undo());
    fireAndFlush(() => session.redo());
    expect(events("assistant_proposal_applied")).toHaveLength(1);
  });

  it("logs assistant_proposal_undone once for each step undone, however it was undone", async () => {
    const { ask, part, finish, events, session, clock } = await setUp();
    await ask();
    part(SWING);
    part(TRACK);
    await press(applyOf("Swing 50% to 58%"));
    await press(applyOf("Bass · new track"));
    finish([SWING, TRACK]);
    clock.advance(3_000);
    // The card's Undo.
    await press(cardButton("Undo"));
    expect(events("assistant_proposal_undone").map((event) => event.params)).toEqual([
      expect.objectContaining({
        capability: "tracks",
        command_count_bucket: "1",
        seconds_to_undo_bucket: "0_5s",
      }),
    ]);
    // The header's Undo or a shortcut: the session's own undo.
    fireAndFlush(() => session.undo());
    expect(events("assistant_proposal_undone")).toHaveLength(2);
    expect(events("undo_used").length).toBeGreaterThan(0);
  });

  it("logs assistant_proposal_rejected and a rejected outcome for each part that does not fit, when others do", async () => {
    const { ask, part, finish, events } = await setUp();
    await ask();
    part(SWING);
    part(CLIP);
    expect(events("assistant_proposal_rejected")).toHaveLength(0);
    finish([SWING, CLIP]);
    expect(events("assistant_proposal_rejected").map((event) => event.params)).toEqual([
      expect.objectContaining({ kind: "invalid", command_count_bucket: "1" }),
    ]);
    // The rejected outcome reaches the session's health, as a whole proposal's does.
    expect(events("assistant_session_sad").map((event) => event.params.reason)).toContain(
      "proposal_invalid",
    );
  });

  it("logs assistant_proposal_rejected once for a refused part when the turn fails", async () => {
    const { ask, part, fail, events } = await setUp();
    await ask();
    part(SWING);
    part(CLIP);
    fail();
    expect(events("assistant_proposal_rejected")).toHaveLength(1);
  });

  it("logs assistant_result_edited once when the producer edits by hand what an applied part changed", async () => {
    const { ask, part, finish, events, volume, editVolume } = await setUp();
    await ask();
    part(volume(-6));
    part(SWING);
    await press(applyOf("BD volume 0.0 dB to -6.0 dB"));
    finish([volume(-6), SWING]);
    editVolume(-9);
    editVolume(-12);
    expect(events("assistant_result_edited").map((event) => event.params)).toEqual([
      expect.objectContaining({ capability: "mixer" }),
    ]);
  });

  it("does not log assistant_result_edited for an edit to a part not applied", async () => {
    const { ask, part, finish, events, volume, editVolume } = await setUp();
    await ask();
    part(volume(-6));
    part(SWING);
    await press(applyOf("Swing 50% to 58%"));
    finish([volume(-6), SWING]);
    editVolume(-9);
    expect(events("assistant_result_edited")).toHaveLength(0);
  });
});

describe("what became of a streamed proposal, for the turns after it (GRV-150)", () => {
  /** The note the model reads after the first reply, as the latest turn sent it. */
  const noteSent = (client: FakeAssistantClient) =>
    client.last().request.messages[1]?.text ?? "";

  it("is pending until a part is applied, then applied, and stays applied when the rest is dismissed", async () => {
    const { ask, part, finish, client, say, swing } = await setUp();
    await ask();
    fireAndFlush(() => client.last().text("Here's a bassline."));
    part(SWING);
    part(TRACK);
    finish([SWING, TRACK]);

    await say("And the drums?");
    expect(noteSent(client)).toContain(proposalNote("pending"));

    await press(applyOf("Swing 50% to 58%"));
    await press(cardButton("Cancel"));
    expect(swing()).toBe(58);
    await say("Thanks");
    expect(noteSent(client)).toContain(proposalNote("applied"));
  });

  it("is cancelled when nothing in it was applied, and undone when every applied part is", async () => {
    const { ask, part, finish, client, say, session } = await setUp();
    await ask();
    fireAndFlush(() => client.last().text("Here's a bassline."));
    part(SWING);
    part(TRACK);
    finish([SWING, TRACK]);
    await press(applyOf("Swing 50% to 58%"));
    fireAndFlush(() => session.undo());
    await say("Hmm");
    expect(noteSent(client)).toContain(proposalNote("undone"));
    await press(cardButton("Cancel"));
    await say("Never mind");
    expect(noteSent(client)).toContain(proposalNote("cancelled"));
  });
});

describe("a streamed proposal across a reload (GRV-135)", () => {
  it("comes back out of date as a whole proposal, so nothing in it applies twice", async () => {
    const store = createConversationStore(memoryStorage());
    const before = await setUp({ conversationStore: store });
    await before.ask();
    fireAndFlush(() => before.client.last().text("Here's a bassline."));
    before.part(SWING);
    before.part(TRACK);
    before.finish([SWING, TRACK]);
    await press(applyOf("Swing 50% to 58%"));
    expect(before.swing()).toBe(58);
    cleanup();

    // The reload opens the song as it was saved, with the swing part in it.
    const { client, session } = await setUp({ conversationStore: store });
    fireAndFlush(() =>
      session.dispatch(setParameter({ scope: "song", parameterId: SONG_SWING.id }, 58)),
    );
    expect(card()).toHaveAccessibleName("Proposal: Add a bassline");
    expect(cardStatus()).toHaveTextContent(
      "Out of date. This was proposed before the page reloaded",
    );
    expect(cardButton("Apply")).toBeDisabled();
    expect(within(card()).queryByRole("button", { name: /^Apply / })).toBeNull();
    expect(within(card()).queryByRole("button", { name: "Apply all" })).toBeNull();

    // Refresh asks again, and the reply it went with still says a part went in.
    await press(cardButton("Refresh"));
    expect(client.turns).toHaveLength(1);
    expect(client.last().request.messages[1]?.text).toContain(proposalNote("applied"));
  });

  it("does not come back once every part was applied", async () => {
    const store = createConversationStore(memoryStorage());
    const before = await setUp({ conversationStore: store });
    await before.ask();
    before.part(SWING);
    before.finish([SWING]);
    await press(cardButton("Apply all"));
    cleanup();

    await setUp({ conversationStore: store });
    expect(within(panel()).queryByRole("region", { name: /^Proposal\b/ })).toBeNull();
  });
});
