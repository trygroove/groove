import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryTranscriptStore } from "../../assistant/inMemoryTranscriptStore";
import { recordOutcome, recordRating } from "../../assistant/retention";
import { handleTranscriptAdminRequest } from "../../assistant/transcriptAdmin";
import { createTranscriptAdminClient } from "../../assistant/transcriptAdminClient";
import { type TranscriptRecord, transcriptRecordFor } from "../../assistant/transcripts";
import TranscriptAdmin from "./TranscriptAdmin";

afterEach(cleanup);

const AT = Date.UTC(2026, 9, 10, 12);

function record(
  turnId: string,
  message: string,
  overrides: { uid?: string; internal?: boolean; at?: number } = {},
): TranscriptRecord {
  return transcriptRecordFor({
    uid: overrides.uid ?? "producer-uid",
    session: {
      conversationId: "conversation-1",
      turnId,
      projectId: "prj_one",
      internal: overrides.internal ?? false,
    },
    internalAccount: false,
    projectRevision: 4,
    userMessage: message,
    reply: "Here is a noise pad on a new track.",
    stopReason: "tool_use",
    proposal: {
      baseRevision: 4,
      toolsetVersion: 6,
      calls: [
        {
          id: "toolu_1",
          name: "track_create",
          input: { track: { name: "Noise", instrument: { assetId: "pad-noise" } } },
        },
      ],
    },
    model: "claude-sonnet-5",
    promptVersion: "7",
    receivedAt: overrides.at ?? AT,
  });
}

async function setUp() {
  const store = createInMemoryTranscriptStore();
  await store.writeIfPermitted(
    record("turn-0001", "Add an atmospheric layer"),
    () => true,
  );
  await store.writeIfPermitted(
    record("turn-0002", "Make the kick louder", { at: AT + 60_000, internal: true }),
    () => true,
  );
  await recordOutcome(store, "producer-uid", "turn-0001", "rejected", AT + 1, [
    {
      code: "invalid_payload",
      callId: "toolu_1",
      callName: "track_create",
      path: null,
      message: 'track.instrument.assetId: Expected a "ast_" prefixed id',
    },
  ]);
  await recordRating(store, "producer-uid", "turn-0002", "down", AT + 2);
  const requests: unknown[] = [];
  const client = createTranscriptAdminClient((request) => {
    requests.push(request);
    return handleTranscriptAdminRequest(store, { admin: true }, request);
  });
  const download = vi.fn();
  render(() => <TranscriptAdmin client={async () => client} download={download} />);
  await screen.findByRole("table", { name: "Turns" });
  return { requests, download };
}

const rows = () =>
  within(screen.getByRole("table", { name: "Turns" }))
    .getAllByRole("row")
    .slice(1);

describe("TranscriptAdmin (GRV-98)", () => {
  it("lists the newest kept turns with their outcome and issue codes", async () => {
    await setUp();
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Make the kick louder"),
      expect.stringContaining("Add an atmospheric layer"),
    ]);
    expect(rows()[0]).toHaveTextContent("Internal");
    expect(rows()[0]).toHaveTextContent("None");
    expect(rows()[1]).toHaveTextContent("Rejected");
    expect(rows()[1]).toHaveTextContent("invalid_payload");
  });

  it("narrows by outcome and traffic through the callable", async () => {
    const { requests } = await setUp();
    fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "rejected" } });
    fireEvent.change(screen.getByLabelText("Traffic"), { target: { value: "external" } });
    fireEvent.input(screen.getByLabelText("Account"), {
      target: { value: " producer-uid " },
    });
    flush();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent("Add an atmospheric layer");
    expect(requests.at(-1)).toEqual({
      op: "list",
      uid: "producer-uid",
      outcome: "rejected",
      internal: false,
    });
  });

  it("narrows to replies rated down, and shows each turn's rating (GRV-103)", async () => {
    const { requests } = await setUp();
    expect(rows()[0]).toHaveTextContent("Down");
    fireEvent.change(screen.getByLabelText("Rating"), { target: { value: "down" } });
    flush();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent("Make the kick louder");
    expect(requests.at(-1)).toEqual({ op: "list", rating: "down" });
  });

  it("opens a turn: message, reply, tool calls with input, and the rejection's issues side by side", async () => {
    const { download } = await setUp();
    fireEvent.click(rows()[1]?.querySelector("button") as HTMLButtonElement);
    const turn = await screen.findByRole("article", { name: "Turn" });
    expect(turn).toHaveTextContent("Add an atmospheric layer");
    expect(turn).toHaveTextContent("Here is a noise pad on a new track.");
    expect(turn).toHaveTextContent("track_create toolu_1");
    expect(turn).toHaveTextContent('"assetId": "pad-noise"');
    const issues = within(turn).getByRole("list", { name: "Issues" });
    expect(issues).toHaveTextContent("invalid_payload in track_create (toolu_1)");
    expect(issues).toHaveTextContent('Expected a "ast_" prefixed id');

    fireEvent.click(within(turn).getByRole("button", { name: "Download eval case" }));
    expect(download).toHaveBeenCalledTimes(1);
    const [fileName, contents] = download.mock.calls[0] as [string, string];
    expect(fileName).toBe("transcript-turn-0001.json");
    expect(JSON.parse(contents)).toMatchObject({
      kind: "groove-assistant-transcript-case",
      request: "Add an atmospheric layer",
    });
  });

  it("marks only the opened account's row, and clears the opened turn when the next one fails to open", async () => {
    const store = createInMemoryTranscriptStore();
    await store.writeIfPermitted(record("turn-0001", "Mine"), () => true);
    await store.writeIfPermitted(
      record("turn-0001", "Theirs", { uid: "other-uid", at: AT + 60_000 }),
      () => true,
    );
    let failGets = false;
    const client = createTranscriptAdminClient((request) =>
      failGets && (request as { op: string }).op === "get"
        ? Promise.reject(new Error("unavailable"))
        : handleTranscriptAdminRequest(store, { admin: true }, request),
    );
    render(() => <TranscriptAdmin client={async () => client} />);
    await screen.findByRole("table", { name: "Turns" });
    const [theirs, mine] = rows();

    fireEvent.click(mine?.querySelector("button") as HTMLButtonElement);
    await screen.findByRole("article", { name: "Turn" });
    expect(mine).toHaveClass("transcripts-row-open");
    expect(theirs).not.toHaveClass("transcripts-row-open");

    vi.spyOn(console, "error").mockImplementation(() => {});
    failGets = true;
    fireEvent.click(theirs?.querySelector("button") as HTMLButtonElement);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't open that turn.",
    );
    expect(screen.queryByRole("article", { name: "Turn" })).not.toBeInTheDocument();
    expect(mine).not.toHaveClass("transcripts-row-open");
  });

  it("says so when nothing matches, and when the transcripts cannot load", async () => {
    const store = createInMemoryTranscriptStore();
    const empty = createTranscriptAdminClient((request) =>
      handleTranscriptAdminRequest(store, { admin: true }, request),
    );
    render(() => <TranscriptAdmin client={async () => empty} />);
    expect(await screen.findByText("No kept turns match.")).toBeInTheDocument();
    cleanup();

    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = createTranscriptAdminClient(() =>
      Promise.reject(new Error("permission-denied")),
    );
    render(() => <TranscriptAdmin client={async () => failing} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load the transcripts.",
    );
  });
});
