import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { clickAndFlush } from "../../testing/events";
import { createFakeAssistantClient } from "../../testing/fakeAssistantClient";
import { createFakeRetentionClient } from "../../testing/fakeRetentionClient";
import { memoryStorage } from "../../testing/storage";
import AssistantPanel from "./AssistantPanel";
import { useAssistantChat } from "./useAssistantChat";
import { useAssistantPanel } from "./useAssistantPanel";

afterEach(cleanup);

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The open panel over a conversation whose account kept (or declined) transcripts. */
async function renderRated(retain: boolean) {
  const client = createFakeAssistantClient();
  const retention = createFakeRetentionClient({ answered: retain });
  const transport = createRecordingTransport();
  const analytics = new Analytics({
    transport,
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  analytics.setAccountType("registered");
  const project = createSliceFixtureProject();
  let send: (text: string) => boolean = () => false;
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
      expanded: () => panel.layout().mode === "floating",
      client: async () => client,
      analytics: () => analytics,
      retention: { client: async () => retention, internal: () => false },
    });
    send = (text) => chat.conversation.send(text);
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
  await settle();
  expect(send("Make the bass punchier")).toBe(true);
  await settle();
  client.last().text("Try a shorter decay.");
  client.last().done();
  await settle();
  const thumbs = () =>
    within(screen.getByRole("group", { name: "Rate this reply" })).getAllByRole("button");
  const thumb = (name: "Good reply" | "Bad reply") =>
    within(screen.getByRole("group", { name: "Rate this reply" })).getByRole("button", {
      name,
    });
  const rates = () => retention.requests.filter((request) => request.op === "rate");
  return { transport, thumb, thumbs, rates };
}

describe("rating a reply (GRV-103)", () => {
  it("offers a thumb up and a thumb down on a finished reply, neither pressed", async () => {
    const { thumbs } = await renderRated(true);
    expect(thumbs().map((button) => button.getAttribute("aria-label"))).toEqual([
      "Good reply",
      "Bad reply",
    ]);
    expect(thumbs().map((button) => button.getAttribute("aria-pressed"))).toEqual([
      "false",
      "false",
    ]);
  });

  it("logs each change once, and its first use once", async () => {
    const { transport, thumb } = await renderRated(true);
    clickAndFlush(thumb("Bad reply"));
    expect(thumb("Bad reply")).toHaveAttribute("aria-pressed", "true");
    clickAndFlush(thumb("Good reply"));
    expect(thumb("Good reply")).toHaveAttribute("aria-pressed", "true");
    expect(thumb("Bad reply")).toHaveAttribute("aria-pressed", "false");
    // The same thumb again clears it, and a clear is not a rating.
    clickAndFlush(thumb("Good reply"));
    expect(thumb("Good reply")).toHaveAttribute("aria-pressed", "false");
    expect(
      transport.named("assistant_reply_rated").map((event) => event.params.rating),
    ).toEqual(["down", "up"]);
    expect(
      transport
        .named("feature_first_use")
        .filter((event) => event.params.feature === "assistant_rating"),
    ).toHaveLength(1);
  });

  it("counts a down towards a sad session, and a later up does not take it back", async () => {
    const { transport, thumb } = await renderRated(true);
    expect(transport.named("assistant_session_started")).toHaveLength(1);
    clickAndFlush(thumb("Bad reply"));
    clickAndFlush(thumb("Good reply"));
    expect(
      transport
        .named("assistant_session_sad")
        .map((event) => [event.params.counts_for, event.params.reason]),
    ).toEqual([
      ["full", "rated_down"],
      ["hard", "rated_down"],
    ]);
  });

  it("tells a kept transcript each change when the account keeps them", async () => {
    const { thumb, rates } = await renderRated(true);
    clickAndFlush(thumb("Bad reply"));
    clickAndFlush(thumb("Bad reply"));
    await settle();
    expect(rates()).toEqual([
      { op: "rate", turnId: expect.any(String), rating: "down" },
      { op: "rate", turnId: expect.any(String), rating: null },
    ]);
  });

  it("writes nothing to a transcript when the account said no", async () => {
    const { transport, thumb, rates } = await renderRated(false);
    clickAndFlush(thumb("Bad reply"));
    await settle();
    expect(rates()).toEqual([]);
    expect(transport.named("assistant_reply_rated")).toHaveLength(1);
  });
});
