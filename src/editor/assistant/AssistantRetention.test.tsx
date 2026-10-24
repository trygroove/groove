import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import type { AssistantRetentionClient } from "../../assistant/retentionClient";
import { TRANSCRIPT_RETENTION_DAYS } from "../../assistant/transcripts";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { clickAndFlush } from "../../testing/events";
import { createFakeAssistantClient } from "../../testing/fakeAssistantClient";
import { createFakeRetentionClient } from "../../testing/fakeRetentionClient";
import { memoryStorage } from "../../testing/storage";
import AssistantPanel from "./AssistantPanel";
import {
  ACCEPT_ANSWER,
  DECLINE_ANSWER,
  DISCLOSURE_PARAGRAPHS,
  NOTE_DECLINE,
  NOTE_DISMISS,
  NOTE_HOW_IT_WORKS,
  NOTE_LABEL,
  NOTE_TEXT,
  NOTICE_CHANGE,
  NOTICE_HEADING,
  OPTED_IN_CONFIRMATION,
  OPTED_OUT_CONFIRMATION,
  RETENTION_LABEL,
  RETENTION_SCOPE,
} from "./retentionCopy";
import { useAssistantChat } from "./useAssistantChat";
import { useAssistantPanel } from "./useAssistantPanel";

afterEach(cleanup);

/** The panel, open, with a conversation and the given retention client. */
async function renderPanel(retention: AssistantRetentionClient) {
  const client = createFakeAssistantClient();
  const transport = createRecordingTransport();
  const analytics = new Analytics({
    transport,
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  const project = createSliceFixtureProject();
  const Harness = () => {
    const panel = useAssistantPanel({
      storage: memoryStorage(),
      analytics: () => analytics,
    });
    const chat = useAssistantChat({
      project: () => project,
      view: () => "arrangement",
      sources: () => ({ selection: null, track: project.song.tracks[0] ?? null }),
      account: () => ({ registered: true }),
      expanded: () => true,
      client: async () => client,
      analytics: () => analytics,
      retention: { client: async () => retention, internal: () => false },
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
  const panel = screen.getByRole("region", { name: "Coproducer" });
  return { client, transport, panel };
}

const composer = (panel: HTMLElement) =>
  within(panel).queryByRole("textbox", { name: "Message Coproducer" });

describe("the assistant's disclosure (GRV-8, GRV-205)", () => {
  const noteOf = (panel: HTMLElement) =>
    within(panel).findByRole("region", { name: NOTE_LABEL });

  it("lets a new account send its first message with the note under the composer", async () => {
    const { panel, client } = await renderPanel(createFakeRetentionClient());
    const note = await noteOf(panel);
    expect(composer(panel)).not.toBeNull();
    expect(note).toHaveTextContent(NOTE_TEXT);
    // The one-liner says "an AI service"; the provider is one tap away.
    expect(note).not.toHaveTextContent("Anthropic");
    expect(within(panel).queryByRole("region", { name: "About Coproducer" })).toBeNull();

    const box = composer(panel) as HTMLTextAreaElement;
    fireEvent.input(box, { target: { value: "Make it groove" } });
    flush();
    clickAndFlush(within(panel).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(client.turns).toHaveLength(1));
    // Sending answers nothing: the note is still there.
    expect(within(panel).queryByRole("region", { name: NOTE_LABEL })).not.toBeNull();
  });

  it("opens the full text in one tap, logging feature_first_use once", async () => {
    const retention = createFakeRetentionClient();
    const { panel, transport } = await renderPanel(retention);
    const note = await noteOf(panel);
    fireEvent.click(within(note).getByRole("button", { name: NOTE_HOW_IT_WORKS }));
    const disclosure = await within(panel).findByRole("region", {
      name: "About Coproducer",
    });
    for (const paragraph of DISCLOSURE_PARAGRAPHS) {
      expect(disclosure).toHaveTextContent(paragraph);
    }
    expect(disclosure).toHaveTextContent("Anthropic does not use anything we send it");
    expect(disclosure).toHaveTextContent(`for ${TRANSCRIPT_RETENTION_DAYS} days`);
    // Nothing was answered by reading it.
    expect(retention.requests.filter((request) => request.op === "set")).toHaveLength(0);
    const opened = () =>
      transport
        .named("feature_first_use")
        .filter((event) => event.params?.feature === "assistant_disclosure");
    expect(opened()).toHaveLength(1);

    // The full text still carries the control, notice and all (GRV-97).
    const notice = within(disclosure).getByRole("group", { name: NOTICE_HEADING });
    expect(notice).toHaveAccessibleDescription(`${NOTICE_CHANGE} ${RETENTION_SCOPE}`);
    const ok = within(notice).getByRole("button", { name: ACCEPT_ANSWER });
    const decline = within(notice).getByRole("button", { name: DECLINE_ANSWER });
    expect(ok.className).toBe(decline.className);
    expect(ok.nextElementSibling).toBe(decline);
  });

  it("opts out from the note, says so, and keeps the composer", async () => {
    const retention = createFakeRetentionClient();
    const { panel, transport } = await renderPanel(retention);
    const note = await noteOf(panel);
    fireEvent.click(within(note).getByRole("button", { name: NOTE_DECLINE }));
    await within(panel).findByText(OPTED_OUT_CONFIRMATION);
    expect(await retention.get()).toMatchObject({ preference: { retain: false } });
    expect(transport.named("assistant_retention_changed")).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ state: "off" }) }),
    ]);
    expect(composer(panel)).not.toBeNull();

    clickAndFlush(within(panel).getByRole("button", { name: NOTE_DISMISS }));
    expect(within(panel).queryByRole("region", { name: NOTE_LABEL })).toBeNull();
  });

  it("is dismissed with a tap, which keeps (the default) and is remembered", async () => {
    const retention = createFakeRetentionClient();
    const { panel, transport } = await renderPanel(retention);
    const note = await noteOf(panel);
    fireEvent.click(within(note).getByRole("button", { name: NOTE_DISMISS }));
    await waitFor(() =>
      expect(within(panel).queryByRole("region", { name: NOTE_LABEL })).toBeNull(),
    );
    expect(await retention.get()).toMatchObject({ preference: { retain: true } });
    expect(transport.named("assistant_retention_changed")).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ state: "on" }) }),
    ]);
  });

  it("is not shown to an account that has answered", async () => {
    const { panel } = await renderPanel(createFakeRetentionClient({ answered: true }));
    await waitFor(() => expect(composer(panel)).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(within(panel).queryByRole("region", { name: NOTE_LABEL })).toBeNull();
  });

  it("shows no note until the answer is known, and the composer is there meanwhile", async () => {
    const stored = createFakeRetentionClient({ answered: true });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const retention: AssistantRetentionClient = {
      ...stored,
      get: async () => {
        await held;
        return stored.get();
      },
    };
    const { panel } = await renderPanel(retention);
    expect(composer(panel)).not.toBeNull();
    expect(within(panel).queryByRole("region", { name: NOTE_LABEL })).toBeNull();
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(within(panel).queryByRole("region", { name: NOTE_LABEL })).toBeNull();
  });
});

describe("the assistant's settings (GRV-8)", () => {
  it("shows the stored answer without changing it, with its scope on the control", async () => {
    const retention = createFakeRetentionClient({ answered: true });
    const { panel } = await renderPanel(retention);
    clickAndFlush(within(panel).getByRole("button", { name: "Coproducer settings" }));

    const box = await within(panel).findByRole("checkbox", { name: RETENTION_LABEL });
    expect(box).toBeChecked();
    expect(box).toHaveAccessibleDescription(RETENTION_SCOPE);
    expect(retention.requests.filter((request) => request.op === "set")).toHaveLength(0);

    fireEvent.click(box);
    await within(panel).findByText(OPTED_OUT_CONFIRMATION);
    expect(
      within(panel).getByRole("checkbox", { name: RETENTION_LABEL }),
    ).not.toBeChecked();
    expect(await retention.get()).toMatchObject({ preference: { retain: false } });

    clickAndFlush(
      within(panel).getByRole("button", { name: "Back to the conversation" }),
    );
    await waitFor(() => expect(composer(panel)).toHaveFocus());
  });

  it("says what turning it on does, with the same scope as the control", async () => {
    const retention = createFakeRetentionClient({ answered: false });
    const { panel } = await renderPanel(retention);
    clickAndFlush(within(panel).getByRole("button", { name: "Coproducer settings" }));
    fireEvent.click(
      await within(panel).findByRole("checkbox", { name: RETENTION_LABEL }),
    );
    const confirmation = await within(panel).findByText(OPTED_IN_CONFIRMATION);
    expect(confirmation).toHaveTextContent(RETENTION_SCOPE);
    expect(await retention.get()).toMatchObject({ preference: { retain: true } });
  });

  it("keeps keyboard focus on the checkbox while and after a change saves (GRV-117)", async () => {
    const retention = createFakeRetentionClient({ answered: true });
    const { panel } = await renderPanel(retention);
    clickAndFlush(within(panel).getByRole("button", { name: "Coproducer settings" }));
    const box = await within(panel).findByRole("checkbox", { name: RETENTION_LABEL });
    box.focus();
    fireEvent.click(box);
    // A disabled control loses focus in a browser, so it must never be disabled.
    await Promise.resolve();
    expect(box).toBeEnabled();
    expect(box).toHaveFocus();
    await within(panel).findByText(OPTED_OUT_CONFIRMATION);
    expect(box).toBeEnabled();
    expect(box).toHaveFocus();
  });

  it("keeps showing what is stored when a change cannot be saved", async () => {
    const retention = createFakeRetentionClient({ answered: false });
    const { panel } = await renderPanel(retention);
    clickAndFlush(within(panel).getByRole("button", { name: "Coproducer settings" }));
    retention.failCalls(true);
    const box = await within(panel).findByRole("checkbox", { name: RETENTION_LABEL });
    fireEvent.click(box);
    await within(panel).findByRole("alert");
    expect(box).not.toBeChecked();
  });
});
