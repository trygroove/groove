import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
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
import { RETENTION_LOADING } from "./AssistantRetention";
import {
  ACCEPT_ANSWER,
  DECLINE_ANSWER,
  DISCLOSURE_PARAGRAPHS,
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
  const panel = screen.getByRole("region", { name: "Cue" });
  return { client, transport, panel };
}

const composer = (panel: HTMLElement) =>
  within(panel).queryByRole("textbox", { name: "Message Cue" });

describe("the assistant's disclosure (GRV-8)", () => {
  async function openNotice(retention: AssistantRetentionClient) {
    const rendered = await renderPanel(retention);
    const disclosure = await within(rendered.panel).findByRole("region", {
      name: "About Cue",
    });
    const notice = within(disclosure).getByRole("group", { name: NOTICE_HEADING });
    return { ...rendered, disclosure, notice };
  }

  async function composerOnceShown(panel: HTMLElement) {
    return waitFor(() => {
      const found = composer(panel);
      if (!found) throw new Error("no composer yet");
      return found;
    });
  }

  it("is a notice that Groove keeps conversations, shown in place of the composer until it is answered (GRV-97)", async () => {
    const retention = createFakeRetentionClient();
    const { panel, client, disclosure, notice } = await openNotice(retention);
    expect(composer(panel)).toBeNull();
    expect(client.turns).toHaveLength(0);

    // What is sent, the provider's posture, what Groove keeps and for how long.
    for (const paragraph of DISCLOSURE_PARAGRAPHS) {
      expect(disclosure).toHaveTextContent(paragraph);
    }
    expect(disclosure).toHaveTextContent(`for ${TRANSCRIPT_RETENTION_DAYS} days`);
    expect(disclosure).toHaveTextContent("The team may read them");
    expect(disclosure).toHaveTextContent(
      "Anthropic does not use anything we send it to train",
    );
    expect(disclosure).not.toHaveTextContent("[provider]");

    // A notice, not a question: it says what happens, how to change it, and
    // the control's scope travels with it (ADR 0007 decision 8).
    expect(notice).toHaveTextContent(NOTICE_HEADING);
    expect(notice).not.toHaveTextContent("?");
    expect(notice).toHaveAccessibleDescription(`${NOTICE_CHANGE} ${RETENTION_SCOPE}`);
    const ok = within(notice).getByRole("button", { name: ACCEPT_ANSWER });
    const decline = within(notice).getByRole("button", { name: DECLINE_ANSWER });
    // "Don't keep them" is as clear as "OK": the same style, right beside it.
    expect(ok.className).toBe(decline.className);
    expect(ok.nextElementSibling).toBe(decline);
  });

  it("keeps them on OK, and opens the composer", async () => {
    const retention = createFakeRetentionClient();
    const { panel, transport, notice } = await openNotice(retention);
    fireEvent.click(within(notice).getByRole("button", { name: ACCEPT_ANSWER }));
    expect(await composerOnceShown(panel)).toHaveFocus();
    expect(await retention.get()).toMatchObject({ preference: { retain: true } });
    expect(transport.named("assistant_retention_changed")).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ state: "on" }) }),
    ]);
  });

  it('stops keeping them on "Don\'t keep them", and opens the composer', async () => {
    const retention = createFakeRetentionClient();
    const { panel, transport, notice } = await openNotice(retention);
    fireEvent.click(within(notice).getByRole("button", { name: DECLINE_ANSWER }));
    expect(await composerOnceShown(panel)).toHaveFocus();
    expect(await retention.get()).toMatchObject({ preference: { retain: false } });
    expect(transport.named("assistant_retention_changed")).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ state: "off" }) }),
    ]);
  });

  it("is not shown again to an account that has answered", async () => {
    const { panel } = await renderPanel(createFakeRetentionClient({ answered: true }));
    await waitFor(() => expect(composer(panel)).not.toBeNull());
    expect(within(panel).queryByRole("region", { name: "About Cue" })).toBeNull();
  });

  it("shows neither the disclosure nor the composer until the answer is known", async () => {
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
    await within(panel).findByText(RETENTION_LOADING);
    expect(within(panel).queryByRole("region", { name: "About Cue" })).toBeNull();
    expect(composer(panel)).toBeNull();

    release();
    await waitFor(() => expect(composer(panel)).not.toBeNull());
    expect(within(panel).queryByRole("region", { name: "About Cue" })).toBeNull();
  });
});

describe("the assistant's settings (GRV-8)", () => {
  it("shows the stored answer without changing it, with its scope on the control", async () => {
    const retention = createFakeRetentionClient({ answered: true });
    const { panel } = await renderPanel(retention);
    await waitFor(() => expect(composer(panel)).not.toBeNull());
    clickAndFlush(within(panel).getByRole("button", { name: "Cue settings" }));

    const box = within(panel).getByRole("checkbox", { name: RETENTION_LABEL });
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
    await waitFor(() => expect(composer(panel)).not.toBeNull());
    clickAndFlush(within(panel).getByRole("button", { name: "Cue settings" }));
    fireEvent.click(within(panel).getByRole("checkbox", { name: RETENTION_LABEL }));
    const confirmation = await within(panel).findByText(OPTED_IN_CONFIRMATION);
    expect(confirmation).toHaveTextContent(RETENTION_SCOPE);
    expect(await retention.get()).toMatchObject({ preference: { retain: true } });
  });

  it("keeps showing what is stored when a change cannot be saved", async () => {
    const retention = createFakeRetentionClient({ answered: false });
    const { panel } = await renderPanel(retention);
    await waitFor(() => expect(composer(panel)).not.toBeNull());
    clickAndFlush(within(panel).getByRole("button", { name: "Cue settings" }));
    retention.failCalls(true);
    const box = within(panel).getByRole("checkbox", { name: RETENTION_LABEL });
    fireEvent.click(box);
    await within(panel).findByRole("alert");
    expect(box).not.toBeChecked();
  });
});
