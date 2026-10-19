import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import type { AssistantErrorDetails } from "../../assistant/protocol";
import type { AssistantVideo } from "../../assistant/video";
import type { Clip, Project } from "../../domain/entities";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import {
  createFakeAssistantClient,
  type FakeAssistantClient,
} from "../../testing/fakeAssistantClient";
import { memoryStorage } from "../../testing/storage";
import type { EditorViewName } from "../editorViews";
import { SIGN_IN_NOTE, WRITING_STATUS } from "./AssistantChatView";
import AssistantPanel from "./AssistantPanel";
import { ERROR_REASSURANCE } from "./assistantErrorCopy";
import { LAYOUT_STORAGE_KEY } from "./assistantPanelLayout";
import type { ScopeSelection } from "./assistantScope";
import { type AssistantAccount, useAssistantChat } from "./useAssistantChat";
import { useAssistantPanel } from "./useAssistantPanel";

afterEach(cleanup);

const VIDEO: AssistantVideo = {
  videoId: "tH9LHIyJ0c8",
  title: "Acid Basslines Explained",
  channel: "Underdog",
  reason: "Shows how resonance and envelope mod make the squelch.",
};

function recordingAnalytics() {
  const transport = createRecordingTransport();
  const analytics = new Analytics({
    transport,
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  analytics.setAccountType("registered");
  return { analytics, transport };
}

interface Options {
  readonly open?: boolean;
  readonly storage?: ReturnType<typeof memoryStorage>;
  readonly account?: AssistantAccount;
  readonly project?: Project;
}

/** The panel, open, over a conversation with a fake client. */
function renderChat(options: Options = {}) {
  const client: FakeAssistantClient = createFakeAssistantClient();
  const { analytics, transport } = recordingAnalytics();
  const project = options.project ?? createSliceFixtureProject();
  const [selection, setSelection] = createSignal<ScopeSelection | null>(null);
  const [view] = createSignal<EditorViewName>("arrangement");
  const [account, setAccount] = createSignal<AssistantAccount>(
    options.account ?? { registered: true },
  );
  const Harness = () => {
    const panel = useAssistantPanel({
      storage: options.storage ?? memoryStorage(),
      analytics: () => analytics,
    });
    const chat = useAssistantChat({
      project: () => project,
      view,
      sources: () => ({ selection: selection(), track: project.song.tracks[0] ?? null }),
      account,
      expanded: () => panel.layout().mode === "floating",
      client: async () => client,
      analytics: () => analytics,
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
  const { unmount } = render(() => <Harness />);
  if (options.open !== false) {
    clickAndFlush(screen.getByRole("button", { name: "Open it" }));
  }
  return { client, transport, project, setSelection, setAccount, unmount };
}

const panel = () => screen.getByRole("region", { name: "Coproducer" });
const composer = () =>
  within(panel()).getByRole("textbox", { name: "Message Coproducer" });
const log = () => within(panel()).getByRole("log", { name: "Conversation" });
const button = (name: string | RegExp) => within(panel()).getByRole("button", { name });
const scopeChip = () => button(/^Scope:/);
const status = () => panel().querySelector(".assistant-panel-status")?.textContent ?? "";

/** The client resolves on a microtask, so a turn is sent a tick after Send. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function type(text: string): Promise<void> {
  fireAndFlush(() => fireEvent.input(composer(), { target: { value: text } }));
}

async function send(text: string): Promise<void> {
  await type(text);
  clickAndFlush(button("Send"));
  await settle();
}

function clipOf(project: Project): Clip {
  const clip = project.clips[0];
  if (!clip) throw new Error("the fixture has no clip");
  return clip;
}

function noteIds(project: Project): string[] {
  const content = clipOf(project).content;
  return content.kind === "notes" ? content.events.map((event) => event.id) : [];
}

describe("the assistant's conversation", () => {
  it("opens ready to type into, scoped to the selected track", () => {
    renderChat();
    expect(composer()).toHaveFocus();
    expect(scopeChip()).toHaveAccessibleName("Scope: BD");
    expect(button("Send")).toBeDisabled();
  });

  it("does not take focus when the editor opens with the panel already open (GRV-130)", () => {
    const storage = memoryStorage();
    storage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ mode: "floating", home: "floating", height: 420, width: 360 }),
    );
    renderChat({ storage, open: false });
    expect(composer()).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });

  it("sends a message stamped with its scope, and streams the reply", async () => {
    const { client, project, transport } = renderChat();
    await send("Make it groove");

    expect(composer()).toHaveValue("");
    expect(log()).toHaveTextContent("Scope · BD");
    expect(log()).toHaveTextContent("Make it groove");
    const turn = client.last();
    expect(turn.request.messages).toEqual([{ role: "user", text: "Make it groove" }]);
    // The track in scope sends its notes (GRV-122).
    expect(turn.request.context.selectedNotes?.noteCount).toBe(noteIds(project).length);

    // Streaming: Stop replaces Send, the log holds its announcement, and the
    // header (and so the minimised bar) says it is writing.
    fireAndFlush(() => turn.text("Try a "));
    fireAndFlush(() => turn.text("shuffle."));
    expect(log()).toHaveTextContent("Try a shuffle.");
    expect(log()).toHaveAttribute("aria-busy", "true");
    expect(button("Stop")).toBeEnabled();
    expect(status()).toBe(WRITING_STATUS);

    fireAndFlush(() => turn.done());
    expect(log()).toHaveAttribute("aria-busy", "false");
    expect(button("Send")).toBeDisabled();
    expect(status()).toBe("");

    const sent = transport.named("assistant_message_sent");
    expect(sent.map((event) => event.params)).toEqual([
      expect.objectContaining({ scope: "track" }),
    ]);
    expect(transport.named("feature_first_use").map((e) => e.params?.feature)).toContain(
      "assistant_message",
    );
    // No message or reply text reaches analytics.
    expect(JSON.stringify(transport.events)).not.toMatch(/groove|shuffle/i);
  });

  it("resends the conversation so far with the next message", async () => {
    const { client } = renderChat();
    await send("First");
    fireAndFlush(() => client.last().text("Reply one"));
    fireAndFlush(() => client.last().done());
    await send("Second");
    expect(client.last().request.messages).toEqual([
      { role: "user", text: "First" },
      { role: "assistant", text: "Reply one" },
      { role: "user", text: "Second" },
    ]);
  });

  it("stops a streaming reply, keeps what it wrote, and gives focus back to the composer", async () => {
    const { client } = renderChat();
    await send("Write a lot");
    fireAndFlush(() => client.last().text("Here is"));
    button("Stop").focus();
    clickAndFlush(button("Stop"));
    expect(client.last().stopped).toBe(true);
    expect(log()).toHaveTextContent("Here is Stopped.");
    expect(log()).toHaveAttribute("aria-busy", "false");
    expect(composer()).toHaveFocus();
    expect(button("Send")).toBeInTheDocument();
  });

  it("stops the reply on its way when the editor goes away", async () => {
    const { client, unmount } = renderChat();
    await send("Write a lot");
    fireAndFlush(() => client.last().text("Here is"));
    unmount();
    expect(client.last().stopped).toBe(true);
  });

  it("will not send while a reply streams, or with nothing to say", async () => {
    const { client } = renderChat();
    await send("   ");
    expect(client.turns).toHaveLength(0);
    await send("One");
    await type("Two");
    expect(within(panel()).queryByRole("button", { name: "Send" })).toBeNull();
    expect(client.turns).toHaveLength(1);
  });

  it("shows a recommended video as its card, and lifts the panel while it fills the window (GRV-16)", async () => {
    const { client } = renderChat();
    await send("How do I get an acid bass?");
    fireAndFlush(() => client.last().text("This one shows it."));
    fireAndFlush(() => client.last().emit({ type: "videos", videos: [VIDEO] }));
    fireAndFlush(() => client.last().done());

    const card = within(log()).getByRole("region", {
      name: `Tutorial video: ${VIDEO.title}`,
    });
    expect(card).toHaveTextContent(VIDEO.reason);
    expect(panel()).not.toHaveClass("assistant-panel-video-expanded");
    clickAndFlush(within(card).getByRole("button", { name: /^Play / }));
    clickAndFlush(within(card).getByRole("button", { name: "Full screen" }));
    expect(panel()).toHaveClass("assistant-panel-video-expanded");
    clickAndFlush(within(card).getByRole("button", { name: "Close" }));
    expect(panel()).not.toHaveClass("assistant-panel-video-expanded");
  });

  it("puts a video card that cannot render in its place, and keeps the rest of the conversation (GRV-16)", async () => {
    const { client } = renderChat();
    const broken = {
      ...VIDEO,
      get title(): string {
        throw new Error("a card that cannot render");
      },
    };
    await send("Show me a tutorial");
    fireAndFlush(() => client.last().text("Here are two."));
    fireAndFlush(() => client.last().emit({ type: "videos", videos: [broken, VIDEO] }));
    fireAndFlush(() => client.last().done());

    expect(log()).toHaveTextContent("Show me a tutorial");
    expect(log()).toHaveTextContent("Here are two.");
    expect(
      within(log()).getByRole("region", { name: "Tutorial video" }),
    ).toHaveTextContent("A video was recommended");
    expect(
      within(log()).getByRole("region", { name: `Tutorial video: ${VIDEO.title}` }),
    ).toBeInTheDocument();
  });

  it("lists a proposal with no editor to apply it to, and changes nothing", async () => {
    const { client, project } = renderChat();
    const before = JSON.stringify(project);
    await send("Change the tempo");
    fireAndFlush(() => client.last().text("Here is a change."));
    fireAndFlush(() =>
      client.last().emit({
        type: "proposal",
        proposal: {
          baseRevision: project.metadata.revision,
          toolsetVersion: 1,
          calls: [{ id: "toolu_1", name: "parameter_set", input: {} }],
        },
      }),
    );
    fireAndFlush(() => client.last().done());
    const card = within(log()).getByRole("region", { name: "Proposal" });
    expect(card).toHaveTextContent("A change was proposed");
    expect(JSON.stringify(project)).toBe(before);
  });
});

describe("the assistant's inline errors", () => {
  const cases: readonly {
    name: string;
    error: AssistantErrorDetails;
    says: RegExp;
    retry: boolean;
  }[] = [
    {
      name: "a provider failure",
      error: { code: "provider_unavailable", retryable: true },
      says: /busy or can't be reached/,
      retry: true,
    },
    {
      name: "a timeout",
      error: { code: "timeout", retryable: true },
      says: /took too long/,
      retry: true,
    },
    {
      name: "a quota limit",
      error: {
        code: "quota_exceeded",
        retryable: false,
        resetsAt: Date.now() + 60_000,
      },
      says: /used all your requests to Coproducer.*frees up (at|tomorrow at) \d/,
      retry: false,
    },
    {
      name: "the kill switch",
      error: { code: "assistant_disabled", retryable: false },
      says: /switched off/,
      retry: false,
    },
  ];

  for (const { name, error, says, retry } of cases) {
    it(`says what ${name} was, leaves the song alone, and ${retry ? "offers" : "does not offer"} Try again`, async () => {
      const { client, project } = renderChat();
      const before = JSON.stringify(project);
      await send("Help");
      fireAndFlush(() => client.last().fail(error));
      const alert = within(log()).getByRole("alert");
      expect(alert).toHaveTextContent("Coproducer couldn't reply.");
      expect(alert).toHaveTextContent(says);
      expect(alert).toHaveTextContent(ERROR_REASSURANCE);
      expect(within(alert).queryByRole("button", { name: "Try again" }) !== null).toBe(
        retry,
      );
      expect(JSON.stringify(project)).toBe(before);
      // The composer is usable again at once.
      expect(composer()).toBeEnabled();
    });
  }

  it("tries the same turn again, and the reply takes the error's place", async () => {
    const { client, transport } = renderChat();
    await send("Help");
    fireAndFlush(() => client.last().fail({ code: "timeout", retryable: true }));
    const first = client.last().request;
    clickAndFlush(within(log()).getByRole("button", { name: "Try again" }));
    await settle();
    expect(client.turns).toHaveLength(2);
    expect(client.last().request).toEqual(first);
    expect(within(log()).queryByRole("alert")).toBeNull();
    expect(composer()).toHaveFocus();
    fireAndFlush(() => client.last().text("Better now"));
    fireAndFlush(() => client.last().done());
    expect(log()).toHaveTextContent("Better now");
    // A retry is not a new message.
    expect(transport.named("assistant_message_sent")).toHaveLength(1);
  });

  it("replaces a reply that failed part-way, so the next turn resends only the real one", async () => {
    const { client } = renderChat();
    await send("Q");
    fireAndFlush(() => client.last().text("Here is one idea. "));
    fireAndFlush(() =>
      client.last().fail({ code: "provider_unavailable", retryable: true }),
    );
    // What it wrote stays on screen above the error until Try again.
    expect(log()).toHaveTextContent("Here is one idea.");
    clickAndFlush(within(log()).getByRole("button", { name: "Try again" }));
    await settle();
    expect(client.last().request.messages).toEqual([{ role: "user", text: "Q" }]);
    fireAndFlush(() => client.last().text("Here is one idea. Full reply."));
    fireAndFlush(() => client.last().done());
    const replies = log().querySelectorAll(".assistant-reply");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toHaveTextContent("Here is one idea. Full reply.");

    await send("Next");
    expect(client.last().request.messages).toEqual([
      { role: "user", text: "Q" },
      { role: "assistant", text: "Here is one idea. Full reply." },
      { role: "user", text: "Next" },
    ]);
  });

  it("marks a reply that failed part-way as interrupted, and a finished one not", async () => {
    const { client } = renderChat();
    await send("First");
    fireAndFlush(() => client.last().text("All of it."));
    fireAndFlush(() => client.last().done());
    await send("Second");
    fireAndFlush(() => client.last().text("Half an"));
    fireAndFlush(() => client.last().fail({ code: "timeout", retryable: true }));
    const replies = log().querySelectorAll(".assistant-reply");
    expect(replies).toHaveLength(2);
    expect(replies[0]).not.toHaveTextContent("Interrupted.");
    expect(replies[1]).toHaveTextContent("Half an Interrupted.");
    expect(replies[1]).not.toHaveTextContent("Stopped.");
  });

  it("does not resend a reply that failed part-way when the producer moves on", async () => {
    const { client } = renderChat();
    await send("Q");
    fireAndFlush(() => client.last().text("Half an "));
    fireAndFlush(() => client.last().fail({ code: "timeout", retryable: true }));
    await send("Something else");
    expect(client.last().request.messages).toEqual([
      { role: "user", text: "Something else" },
    ]);
  });

  it("offers Try again only on the error that ended the conversation", async () => {
    const { client } = renderChat();
    await send("Help");
    fireAndFlush(() => client.last().fail({ code: "timeout", retryable: true }));
    expect(within(log()).getByRole("button", { name: "Try again" })).toBeInTheDocument();

    await send("Something else");
    // Not while a reply streams, and not on the old error after it.
    expect(within(log()).queryByRole("button", { name: "Try again" })).toBeNull();
    fireAndFlush(() => client.last().text("Sure."));
    fireAndFlush(() => client.last().done());
    expect(within(log()).getByRole("alert")).toBeInTheDocument();
    expect(within(log()).queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

describe("the scope chip", () => {
  it("follows the selection, widens to the track and the song, and resets when the selection changes", async () => {
    const { client, project, setSelection, transport } = renderChat();
    const ids = noteIds(project).slice(0, 3);
    fireAndFlush(() => setSelection({ kind: "notes", eventIds: ids as never }));
    expect(scopeChip()).toHaveAccessibleName("Scope: 3 notes");

    await send("Shift these");
    expect(log()).toHaveTextContent("Scope · 3 notes");
    expect(client.last().request.context.selectedNotes?.noteCount).toBe(3);
    fireAndFlush(() => client.last().done());

    clickAndFlush(scopeChip());
    expect(scopeChip()).toHaveAccessibleName("Scope: BD");
    await send("Now the track");
    // The track scope names its track and sends all its notes (GRV-122).
    expect(client.last().request.context.selectedNotes?.noteCount).toBe(
      noteIds(project).length,
    );
    expect(client.last().request.context.selection?.description).toContain("BD");
    fireAndFlush(() => client.last().done());

    clickAndFlush(scopeChip());
    expect(scopeChip()).toHaveAccessibleName("Scope: Whole song");
    await send("Now the song");
    expect(client.last().request.context.selection).toBeNull();
    expect(client.last().request.context.selectedNotes).toBeNull();
    fireAndFlush(() => client.last().done());

    // Round again, then a new selection lets the choice go.
    clickAndFlush(scopeChip());
    expect(scopeChip()).toHaveAccessibleName("Scope: 3 notes");
    clickAndFlush(scopeChip());
    expect(scopeChip()).toHaveAccessibleName("Scope: BD");
    fireAndFlush(() =>
      setSelection({
        kind: "clips",
        placementIds: [project.song.placements[0]?.id] as never,
      }),
    );
    expect(scopeChip()).toHaveAccessibleName("Scope: 1 clip");
    await send("These clips");

    expect(
      transport.named("assistant_message_sent").map((event) => event.params?.scope),
    ).toEqual(["clip", "track", "song", "section"]);
  });
});

describe("the suggestion chips", () => {
  it("sends a chip's words, logs which one it was, and hides while a reply streams", async () => {
    const { client, transport } = renderChat();
    const chips = within(panel()).getByRole("group", { name: "Suggestions" });
    const chip = within(chips).getByRole("button", { name: "Create an arrangement" });
    clickAndFlush(chip);
    await settle();
    expect(client.last().request.messages.at(-1)?.text).toBe("Create an arrangement");
    expect(
      transport.named("assistant_suggestion_clicked").map((e) => e.params?.suggestion_id),
    ).toEqual(["create_arrangement"]);
    expect(transport.named("assistant_message_sent")).toHaveLength(1);
    expect(within(panel()).queryByRole("group", { name: "Suggestions" })).toBeNull();
  });
});

describe("without an account", () => {
  it("offers a sign-in in place of the composer, and sends nothing", () => {
    const signIn = vi.fn();
    const { client } = renderChat({ account: { registered: false, signIn } });
    expect(within(panel()).queryByRole("textbox")).toBeNull();
    expect(panel()).toHaveTextContent(SIGN_IN_NOTE);
    expect(panel()).toHaveFocus();
    clickAndFlush(button("Sign in"));
    expect(signIn).toHaveBeenCalledOnce();
    expect(client.turns).toHaveLength(0);
  });
});
