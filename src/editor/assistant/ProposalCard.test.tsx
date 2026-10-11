import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import type { AssistantProposal } from "../../assistant/protocol";
import { ASSISTANT_TOOLSET_VERSION, EXPLAIN_TOOL_NAME } from "../../assistant/tools";
import {
  type ControlAddress,
  controlAddress,
  SONG_ENTITY,
} from "../../commands/controlAddress";
import { setParameter } from "../../commands/definitions/parameters";
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
import {
  createFakeRetentionClient,
  type FakeRetentionClient,
} from "../../testing/fakeRetentionClient";
import { memoryStorage } from "../../testing/storage";
import { assistantProposalTarget } from "../assistantProposalTarget";
import { EditorSession } from "../EditorSession";
import type { EditorLocation } from "../editorControls";
import type { EditorViewName } from "../editorViews";
import AssistantPanel, { PREVIEWING_STATUS } from "./AssistantPanel";
import { useAssistantChat } from "./useAssistantChat";
import { useAssistantPanel } from "./useAssistantPanel";

/**
 * The assistant's proposal card (GRV-5) against a real editor session: the
 * card lists the changes, previews them uncommitted, cancels back to where the
 * editor was, applies them as one undo step, goes out of date under an edit
 * here or elsewhere, and notices a producer's own edit to what it changed.
 */

afterEach(cleanup);

/** What the assistant says the default proposal is for, through `explain_change`. */
const EXPLANATION = {
  goal: "The beat feels played rather than programmed.",
  technique: "Swing delays every second 16th note, the way a drummer's hand lags.",
};

const ARRANGEMENT: EditorLocation = {
  view: "arrangement",
  selection: { scopes: [], focus: null },
  padSelection: { trackId: null, padIds: [] },
  openPlacementId: null,
} as unknown as EditorLocation;

async function setUp(options: { retention?: FakeRetentionClient } = {}) {
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
  const client: FakeAssistantClient = createFakeAssistantClient();
  const registry = createControlRegistry();
  const revealControl = vi.fn(
    (_address: ControlAddress, _options?: { focus?: boolean }) => ARRANGEMENT,
  );
  const restoreView = vi.fn((_location: EditorLocation) => {});
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
      ...(options.retention
        ? {
            retention: {
              client: async () => options.retention as FakeRetentionClient,
              internal: () => false,
            },
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
        controls: { registry, revealControl, restoreView },
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
  // An account's answer about keeping conversations loads first (GRV-8).
  if (options.retention) await new Promise<void>((resolve) => setTimeout(resolve, 0));

  const swing = controlAddress(SONG_ENTITY, "swing");
  const volume = controlAddress(track.id, "volume");
  const volumeTo = (value: number) =>
    setParameter(
      { scope: "track", trackId: track.id, parameterId: TRACK_VOLUME.id },
      value,
    );

  /** Asks, and answers with swing at 58% and the track 3 dB down, explained. */
  async function propose(
    calls: AssistantProposal["calls"] = [
      {
        id: "toolu_1",
        name: "parameter_set",
        input: { target: { scope: "song", parameterId: SONG_SWING.id }, value: 58 },
      },
      {
        id: "toolu_2",
        name: "parameter_set",
        input: {
          target: { scope: "track", trackId: track.id, parameterId: TRACK_VOLUME.id },
          value: -3,
        },
      },
      { id: "toolu_3", name: EXPLAIN_TOOL_NAME, input: EXPLANATION },
    ],
  ) {
    fireAndFlush(() =>
      fireEvent.input(composer(), { target: { value: "Loosen the beat" } }),
    );
    clickAndFlush(button("Send"));
    await settle();
    fireAndFlush(() => client.last().text("Some swing, and BD back a little."));
    fireAndFlush(() =>
      client.last().emit({
        type: "proposal",
        proposal: {
          baseRevision: session.committedProject.metadata.revision,
          toolsetVersion: ASSISTANT_TOOLSET_VERSION,
          calls,
        },
      }),
    );
    fireAndFlush(() => client.last().done());
  }

  const events = (name: string) =>
    transport.events.filter((event) => event.name === name);

  return {
    project,
    repository,
    session,
    client,
    registry,
    revealControl,
    restoreView,
    track,
    swing,
    volume,
    volumeTo,
    propose,
    events,
  };
}

const panel = () => screen.getByRole("region", { name: "Assistant" });
const composer = () =>
  within(panel()).getByRole("textbox", { name: "Message the assistant" });
const button = (name: string | RegExp) => within(panel()).getByRole("button", { name });
const card = () => within(panel()).getByRole("region", { name: /^Proposal\b/ });
const cardButton = (name: string) => within(card()).getByRole("button", { name });
const cardStatus = () => within(card()).getByRole("status");
const panelStatus = () =>
  panel().querySelector(".assistant-panel-status")?.textContent ?? "";
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Clicks with focus on the button first, as a keyboard or a pointer leaves it. */
async function press(element: HTMLElement): Promise<void> {
  element.focus();
  clickAndFlush(element);
  await settle();
  flush();
}

/** Presses keys as a keyboard would, then lets the card re-render and move focus. */
async function keys(text: string): Promise<void> {
  await userEvent.keyboard(text);
  flush();
  await settle();
  flush();
}

async function tab(): Promise<void> {
  await userEvent.tab();
  flush();
}

describe("the proposal card (GRV-5)", () => {
  it("lists every control it would change, old to new, and changes nothing", async () => {
    const { propose, session, project } = await setUp();
    await propose();
    expect(card()).toHaveAccessibleName("Proposal: Loosen the beat");
    const rows = within(
      within(card()).getByRole("list", { name: "Changes" }),
    ).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Swing 50% → to 58%",
      "BD volume 0.0 dB → to -3.0 dB",
    ]);
    expect(cardStatus()).toHaveTextContent("Nothing has changed yet.");
    expect(session.committedProject).toBe(project);
    expect(session.history.canUndo).toBe(false);
  });

  it("previews uncommitted: the view that shows it, dashed outlines, no undo, no save", async () => {
    const { propose, session, revealControl, registry, swing, volume, repository } =
      await setUp();
    await propose();
    repository.clearWrites();
    const preview = cardButton("Preview");
    await press(preview);

    expect(session.activePreview).not.toBeNull();
    expect(session.project.song.swing).toBe(58);
    expect(session.committedProject.song.swing).toBe(50);
    expect(session.history.canUndo).toBe(false);
    expect(session.autosave.status.state).not.toBe("pending");
    // It goes to the mixer, where BD's volume is, and leaves focus on the card.
    expect(revealControl).toHaveBeenCalledWith(volume, { focus: false });
    expect(preview).toHaveFocus();
    expect(preview).toHaveAttribute("aria-pressed", "true");
    expect(registry.markOf(swing)).toBe("previewed");
    expect(registry.markOf(volume)).toBe("previewed");
    expect(cardStatus()).toHaveTextContent(
      "Previewing in Mixer. Nothing is saved until you apply. Cancel takes you back to Arrangement.",
    );
    expect(panelStatus()).toBe(PREVIEWING_STATUS);
    await session.autosave.flush();
    expect(repository.writes).toHaveLength(0);
  });

  it("cancels a preview back to where the editor was, with nothing to undo", async () => {
    const { propose, session, restoreView, registry, volume } = await setUp();
    await propose();
    await press(cardButton("Preview"));
    const cancel = cardButton("Cancel");
    await press(cancel);

    expect(session.activePreview).toBeNull();
    expect(session.project.song.swing).toBe(50);
    expect(session.history.canUndo).toBe(false);
    expect(restoreView).toHaveBeenCalledWith(ARRANGEMENT);
    expect(registry.markOf(volume)).toBe("none");
    expect(cardStatus()).toHaveTextContent("Nothing has changed yet.");
    expect(panelStatus()).toBe("");
    expect(cancel).toHaveFocus();
  });

  it("applies as one undo step, outlines what changed and offers Undo", async () => {
    const { propose, session, registry, swing, volume, events, track } = await setUp();
    await propose();
    await press(cardButton("Preview"));
    await press(cardButton("Apply"));

    expect(session.activePreview).toBeNull();
    expect(session.history.entries).toHaveLength(1);
    expect(session.committedProject.song.swing).toBe(58);
    expect(
      session.committedProject.song.tracks.find((t) => t.id === track.id)?.mixer.volume,
    ).toBe(-3);
    expect(registry.markOf(swing)).toBe("changed");
    expect(registry.markOf(volume)).toBe("changed");
    expect(cardStatus()).toHaveTextContent("Applied as one undo step.");
    expect(cardButton("Undo")).toHaveFocus();
    expect(events("assistant_proposal_applied")).toHaveLength(1);
    expect(within(card()).queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("undoes from the card, and the card says so", async () => {
    const { propose, session, registry, volume } = await setUp();
    await propose();
    await press(cardButton("Apply"));
    await press(cardButton("Undo"));

    expect(session.committedProject.song.swing).toBe(50);
    expect(session.history.canUndo).toBe(false);
    expect(registry.markOf(volume)).toBe("none");
    expect(cardStatus()).toHaveTextContent("Undone.");
    expect(card()).toHaveFocus();
  });

  it("clears the solid outline at the next edit, and stops saying it is there", async () => {
    const { propose, session, registry, swing, volumeTo } = await setUp();
    await propose();
    await press(cardButton("Apply"));
    expect(cardStatus()).toHaveTextContent("Changed controls are outlined.");
    fireAndFlush(() => session.dispatch(volumeTo(-12)));
    expect(registry.markOf(swing)).toBe("none");
    expect(cardStatus()).toHaveTextContent("Applied as one undo step.");
    expect(cardStatus()).not.toHaveTextContent("outlined");
  });

  it("goes out of date under a local edit: Apply is off and Refresh asks again", async () => {
    const { propose, session, volumeTo, client } = await setUp();
    await propose();
    fireAndFlush(() => session.dispatch(volumeTo(-6)));

    expect(cardStatus()).toHaveTextContent("Out of date.");
    expect(cardButton("Apply")).toBeDisabled();
    await press(cardButton("Refresh"));
    expect(client.turns).toHaveLength(2);
    const asked = client.turns[1]?.request;
    expect(asked?.messages.at(-1)).toEqual({ role: "user", text: "Loosen the beat" });
    expect(asked?.projectRevision).toBe(session.committedProject.metadata.revision);
    expect(asked?.context.selection?.description).toContain("BD");
    expect(within(card()).queryByRole("button", { name: "Refresh" })).toBeNull();
  });

  it("titles a proposal that answered a question with the answer, and Refresh resends it as an answer (GRV-42)", async () => {
    const { session, volumeTo, client } = await setUp();
    fireAndFlush(() =>
      fireEvent.input(composer(), { target: { value: "Build a drop" } }),
    );
    clickAndFlush(button("Send"));
    await settle();
    fireAndFlush(() => {
      client.last().emit({
        type: "ask",
        ask: {
          id: "toolu_ask",
          question: "How loose?",
          options: [{ label: "A little" }, { label: "A lot" }],
          multiSelect: false,
        },
      });
      client.last().done();
    });
    clickAndFlush(button(/A little/));
    await settle();
    const answer = '[Answer to "How loose?"] Picked: A little.';
    expect(client.turns[1]?.request.messages.at(-1)).toEqual({
      role: "user",
      text: answer,
    });
    fireAndFlush(() => {
      client.last().emit({
        type: "proposal",
        proposal: {
          baseRevision: session.committedProject.metadata.revision,
          toolsetVersion: ASSISTANT_TOOLSET_VERSION,
          calls: [
            {
              id: "toolu_1",
              name: "parameter_set",
              input: { target: { scope: "song", parameterId: SONG_SWING.id }, value: 58 },
            },
          ],
        },
      });
      client.last().done();
    });
    expect(card()).toHaveTextContent("A little");
    expect(card()).not.toHaveTextContent("[Answer to");

    fireAndFlush(() => session.dispatch(volumeTo(-6)));
    await press(cardButton("Refresh"));
    expect(client.turns).toHaveLength(3);
    expect(client.turns[2]?.request.messages.at(-1)).toEqual({
      role: "user",
      text: answer,
    });
    const log = within(panel()).getByRole("log", { name: "Conversation" });
    expect(within(log).getAllByText("Answer · How loose?")).toHaveLength(2);
  });

  it("goes out of date while previewing when the song changes under it", async () => {
    const { propose, session, volumeTo, registry, volume } = await setUp();
    await propose();
    await press(cardButton("Preview"));
    fireAndFlush(() => session.dispatch(volumeTo(-6)));
    flush();

    expect(session.activePreview).toBeNull();
    expect(cardStatus()).toHaveTextContent("Out of date.");
    expect(registry.markOf(volume)).toBe("none");
    expect(cardButton("Apply")).toBeDisabled();
  });

  it("goes out of date under a change made elsewhere", async () => {
    const { propose, repository, project } = await setUp();
    await propose();
    const saved = await repository.saveMetadata(
      project.metadata.id,
      { name: "Renamed in another tab" },
      project.metadata.revision,
    );
    expect(saved.ok).toBe(true);
    await vi.waitFor(() => {
      flush();
      expect(cardStatus()).toHaveTextContent("Out of date.");
    });
    expect(cardButton("Apply")).toBeDisabled();
  });

  it("arrives out of date when the song moved while it was written", async () => {
    const { session, volumeTo, client } = await setUp();
    fireAndFlush(() =>
      fireEvent.input(composer(), { target: { value: "Loosen the beat" } }),
    );
    clickAndFlush(button("Send"));
    await settle();
    const asked = client.last().request.projectRevision;
    fireAndFlush(() => session.dispatch(volumeTo(-6)));
    fireAndFlush(() =>
      client.last().emit({
        type: "proposal",
        proposal: {
          baseRevision: asked,
          toolsetVersion: ASSISTANT_TOOLSET_VERSION,
          calls: [
            {
              id: "toolu_1",
              name: "parameter_set",
              input: { target: { scope: "song", parameterId: SONG_SWING.id }, value: 58 },
            },
          ],
        },
      }),
    );
    fireAndFlush(() => client.last().done());
    expect(cardStatus()).toHaveTextContent("Out of date.");
    expect(within(card()).getByRole("button", { name: "Refresh" })).toBeEnabled();
  });

  it("says so, and offers only Dismiss, for a proposal that does not fit the song", async () => {
    const { propose } = await setUp();
    await propose([
      {
        id: "toolu_1",
        name: "parameter_set",
        input: { target: { scope: "song", parameterId: SONG_SWING.id }, value: 99 },
      },
    ]);
    expect(cardStatus()).toHaveTextContent("can't be applied");
    expect(within(card()).queryByRole("button", { name: "Apply" })).toBeNull();
    await press(cardButton("Dismiss"));
    expect(cardStatus()).toHaveTextContent("Cancelled. Nothing changed.");
    expect(card()).toHaveFocus();
  });

  it("tells a kept turn what became of its proposal: applied, undone, cancelled (GRV-8)", async () => {
    const retention = createFakeRetentionClient({ answered: true });
    const { propose, client } = await setUp({ retention });
    await propose();
    const turnId = client.last().request.session?.turnId;
    expect(turnId).toBeDefined();
    await press(cardButton("Apply"));
    await press(cardButton("Undo"));
    await settle();
    expect(retention.requests.filter((request) => request.op === "outcome")).toEqual([
      { op: "outcome", turnId, outcome: "applied" },
      { op: "outcome", turnId, outcome: "undone" },
    ]);

    await propose();
    const next = client.last().request.session?.turnId;
    await press(
      within(
        within(panel())
          .getAllByRole("region", { name: /^Proposal\b/ })
          .at(-1) as HTMLElement,
      ).getByRole("button", { name: "Cancel" }),
    );
    await settle();
    expect(
      retention.requests.filter((request) => request.op === "outcome").at(-1),
    ).toEqual({ op: "outcome", turnId: next, outcome: "cancelled" });
  });

  it("says nothing about outcomes for an account that keeps nothing (GRV-8)", async () => {
    const retention = createFakeRetentionClient({ answered: false });
    const { propose } = await setUp({ retention });
    await propose();
    await press(cardButton("Apply"));
    await settle();
    expect(retention.requests.filter((request) => request.op === "outcome")).toEqual([]);
  });

  it("turns a proposal down with Cancel, changing nothing", async () => {
    const { propose, session, events } = await setUp();
    await propose();
    await press(cardButton("Cancel"));
    expect(cardStatus()).toHaveTextContent("Cancelled. Nothing changed.");
    expect(session.history.canUndo).toBe(false);
    expect(events("assistant_proposal_cancelled")).toHaveLength(1);
    expect(card()).toHaveFocus();
  });

  it("logs assistant_result_edited once when a changed control is edited by hand", async () => {
    const { propose, session, volumeTo, events } = await setUp();
    await propose();
    await press(cardButton("Apply"));
    fireAndFlush(() =>
      session.dispatch(setParameter({ scope: "song", parameterId: "song.tempo" }, 100)),
    );
    expect(events("assistant_result_edited")).toHaveLength(0);
    fireAndFlush(() => session.dispatch(volumeTo(-9)));
    fireAndFlush(() => session.dispatch(volumeTo(-10)));
    const edited = events("assistant_result_edited");
    expect(edited).toHaveLength(1);
    expect(edited[0]?.params).toMatchObject({ capability: "mixed" });
  });

  it("does not count the assistant's own undo as an edit by hand", async () => {
    const { propose, events } = await setUp();
    await propose();
    await press(cardButton("Apply"));
    await press(cardButton("Undo"));
    expect(events("assistant_result_edited")).toHaveLength(0);
  });

  it("explains itself: the assistant's goal and technique, and the changed controls as links", async () => {
    const { propose, revealControl, swing, volume } = await setUp();
    await propose();
    const why = within(card()).getByText("Why this works");
    fireAndFlush(() => fireEvent.click(why));
    const details = why.closest("details");
    if (!details) throw new Error("no details");
    expect(details).toHaveTextContent(`Goal${EXPLANATION.goal}`);
    expect(details).toHaveTextContent(`Technique${EXPLANATION.technique}`);
    // Neither the request repeated nor the change restated (GRV-5 QA).
    expect(details).not.toHaveTextContent("Loosen the beat");
    expect(details).not.toHaveTextContent("Set Swing");
    const links = within(details).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("aria-label"))).toEqual([
      "Show Swing",
      "Show BD volume",
    ]);
    clickAndFlush(within(details).getByRole("link", { name: "Show BD volume" }));
    expect(revealControl).toHaveBeenLastCalledWith(volume);
    clickAndFlush(
      within(card()).getAllByRole("link", { name: "Show Swing" })[0] as HTMLElement,
    );
    expect(revealControl).toHaveBeenLastCalledWith(swing);
  });

  it("folds nothing out when the assistant did not explain the change", async () => {
    const { propose } = await setUp();
    await propose([
      {
        id: "toolu_1",
        name: "parameter_set",
        input: { target: { scope: "song", parameterId: SONG_SWING.id }, value: 58 },
      },
    ]);
    expect(cardButton("Apply")).toBeEnabled();
    expect(within(card()).queryByText("Why this works")).toBeNull();
  });

  it("lists its controls as links, not buttons", async () => {
    const { propose } = await setUp();
    await propose();
    const changes = within(card()).getByRole("list", { name: "Changes" });
    expect(
      within(changes)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Swing", "BD volume"]);
    expect(within(changes).queryAllByRole("button")).toEqual([]);
  });

  it("undoes from the card again after a redo of it from the header", async () => {
    const { propose, session, events } = await setUp();
    await propose();
    await press(cardButton("Apply"));
    await press(cardButton("Undo"));
    fireAndFlush(() => session.redo());
    expect(session.committedProject.song.swing).toBe(58);
    expect(cardStatus()).toHaveTextContent("Applied as one undo step.");

    await press(cardButton("Undo"));
    expect(session.committedProject.song.swing).toBe(50);
    expect(session.history.canUndo).toBe(false);
    expect(cardStatus()).toHaveTextContent("Undone. Your song is back as it was.");
    expect(cardStatus()).not.toHaveTextContent("header's Undo");
    expect(events("assistant_proposal_undone")).toHaveLength(2);
  });

  it("counts an undo of the proposal from the header as its undo", async () => {
    const { propose, session, events } = await setUp();
    await propose();
    await press(cardButton("Apply"));
    fireAndFlush(() => session.undo());
    expect(cardStatus()).toHaveTextContent("Undone.");
    expect(events("assistant_proposal_undone")).toHaveLength(1);
  });

  it("logs assistant_result_edited once per proposal, even after it is undone and redone", async () => {
    const { propose, session, volumeTo, events } = await setUp();
    await propose();
    await press(cardButton("Apply"));
    fireAndFlush(() => session.dispatch(volumeTo(-9)));
    expect(events("assistant_result_edited")).toHaveLength(1);
    fireAndFlush(() => session.undo()); // the edit by hand
    fireAndFlush(() => session.undo()); // the proposal
    fireAndFlush(() => session.redo()); // the proposal again
    expect(cardStatus()).toHaveTextContent("Applied as one undo step.");
    fireAndFlush(() => session.dispatch(volumeTo(-10)));
    expect(events("assistant_result_edited")).toHaveLength(1);
  });

  it("arrives out of date when a change made elsewhere landed while it was written", async () => {
    const { session, client, repository, project } = await setUp();
    fireAndFlush(() =>
      fireEvent.input(composer(), { target: { value: "Loosen the beat" } }),
    );
    clickAndFlush(button("Send"));
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
    fireAndFlush(() =>
      client.last().emit({
        type: "proposal",
        proposal: {
          baseRevision: session.committedProject.metadata.revision,
          toolsetVersion: ASSISTANT_TOOLSET_VERSION,
          calls: [
            {
              id: "toolu_1",
              name: "parameter_set",
              input: { target: { scope: "song", parameterId: SONG_SWING.id }, value: 58 },
            },
          ],
        },
      }),
    );
    fireAndFlush(() => client.last().done());
    expect(cardStatus()).toHaveTextContent("Out of date.");
    expect(cardButton("Apply")).toBeDisabled();
    expect(within(card()).getByRole("button", { name: "Refresh" })).toBeEnabled();
  });

  it("logs feature_first_use for assistant_proposal once, across Preview and Apply", async () => {
    const { propose, events } = await setUp();
    await propose();
    await press(cardButton("Preview"));
    await press(cardButton("Apply"));
    const firstUse = events("feature_first_use").filter(
      (event) => event.params.feature === "assistant_proposal",
    );
    expect(firstUse).toHaveLength(1);
  });
});

describe("the proposal card from the keyboard (GRV-5)", () => {
  it("tabs through its control links to Preview, Apply and Cancel, in that order", async () => {
    const { propose } = await setUp();
    await propose();
    card().focus();
    const order: (string | null)[] = [];
    for (let step = 0; step < 5; step += 1) {
      await tab();
      const focused = document.activeElement as HTMLElement | null;
      order.push(focused?.getAttribute("aria-label") ?? focused?.textContent ?? null);
    }
    expect(order).toEqual(["Show Swing", "Show BD volume", "Preview", "Apply", "Cancel"]);
  });

  it("previews with Enter, ends it with Space, and announces each in the card's status", async () => {
    const { propose, session } = await setUp();
    await propose();
    const preview = cardButton("Preview");
    preview.focus();
    await keys("{Enter}");
    expect(session.activePreview).not.toBeNull();
    expect(cardStatus().tagName).toBe("OUTPUT");
    expect(cardStatus()).toHaveTextContent("Previewing in Mixer.");
    expect(preview).toHaveFocus();

    await keys(" ");
    expect(session.activePreview).toBeNull();
    expect(cardStatus()).toHaveTextContent("Nothing has changed yet.");
    expect(preview).toHaveFocus();
  });

  it("applies with Enter, hands focus to Undo, and undoes with Space", async () => {
    const { propose, session } = await setUp();
    await propose();
    cardButton("Apply").focus();
    await keys("{Enter}");
    expect(session.committedProject.song.swing).toBe(58);
    expect(cardStatus()).toHaveTextContent("Applied as one undo step.");
    expect(cardButton("Undo")).toHaveFocus();

    await keys(" ");
    expect(session.committedProject.song.swing).toBe(50);
    expect(cardStatus()).toHaveTextContent("Undone.");
    expect(card()).toHaveFocus();
  });

  it("cancels a preview with Enter on Cancel, keeping focus there, and turns it down with a second", async () => {
    const { propose, session, restoreView } = await setUp();
    await propose();
    cardButton("Preview").focus();
    await keys("{Enter}");
    const cancel = cardButton("Cancel");
    cancel.focus();
    await keys("{Enter}");
    expect(session.activePreview).toBeNull();
    expect(restoreView).toHaveBeenCalledWith(ARRANGEMENT);
    expect(cancel).toHaveFocus();

    await keys("{Enter}");
    expect(cardStatus()).toHaveTextContent("Cancelled. Nothing changed.");
    expect(card()).toHaveFocus();
  });

  it("refreshes an out-of-date proposal with Enter", async () => {
    const { propose, session, volumeTo, client } = await setUp();
    await propose();
    fireAndFlush(() => session.dispatch(volumeTo(-6)));
    cardButton("Refresh").focus();
    await keys("{Enter}");
    expect(client.turns).toHaveLength(2);
    expect(cardStatus()).toHaveTextContent("A new proposal was asked for below.");
    expect(cardButton("Dismiss")).toHaveFocus();
  });

  it("shows a control from its link with Enter", async () => {
    const { propose, revealControl, swing, volume } = await setUp();
    await propose();
    within(card()).getAllByRole("link", { name: "Show BD volume" })[0]?.focus();
    await keys("{Enter}");
    expect(revealControl).toHaveBeenLastCalledWith(volume);
    within(card()).getAllByRole("link", { name: "Show Swing" })[0]?.focus();
    await keys("{Enter}");
    expect(revealControl).toHaveBeenLastCalledWith(swing);
  });
});
