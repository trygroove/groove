import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import {
  createRecordingTransport,
  type RecordingTransport,
} from "../analytics/transport";
import { LAYOUT_STORAGE_KEY, loadLayout } from "../editor/assistant/assistantPanelLayout";
import {
  CONVERSATION_STORAGE_PREFIX,
  conversationStorageKey,
  parseConversation,
} from "../editor/assistant/conversationStore";
import { InMemoryProfileRepository } from "../persistence/inMemoryProfileRepository";
import { createInMemoryProjectRepository } from "../persistence/inMemoryProjectRepository";
import { emptyProfile } from "../persistence/profileDocuments";
import { profileFailure } from "../persistence/profileRepository";
import { clickAndFlush, fireAndFlush } from "../testing/events";
import { memoryStorage } from "../testing/storage";
import Welcome, { OPEN_STUDIO_LABEL, SKIP_LABEL } from "./Welcome";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ user: { uid: "user-1" }, loading: false, isAnonymous: false }),
}));

const navigate = vi.fn();
vi.mock("@solidjs/router", () => ({ useNavigate: () => navigate }));

let profiles: InMemoryProfileRepository;
let transport: RecordingTransport;

beforeEach(() => {
  profiles = new InMemoryProfileRepository();
  sessionStorage.clear();
  localStorage.removeItem(LAYOUT_STORAGE_KEY);
});

afterEach(() => {
  cleanup();
  navigate.mockReset();
  vi.restoreAllMocks();
});

function renderWelcome(replyDelayMs = 0) {
  transport = createRecordingTransport();
  const analytics = new Analytics({
    transport,
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  const projects = createInMemoryProjectRepository();
  render(() => (
    <Welcome
      analytics={analytics}
      profiles={() => Promise.resolve(profiles)}
      projects={() => Promise.resolve(projects)}
      replyDelayMs={replyDelayMs}
    />
  ));
  return { projects };
}

const card = () => screen.getByRole("region", { name: "Cue asks" });
const option = (label: string) => within(card()).getByRole("button", { name: label });
const send = () =>
  clickAndFlush(within(card()).getByRole("button", { name: "Send the answer" }));

function type(name: string, value: string) {
  const box = within(card()).getByRole("textbox", { name });
  fireAndFlush(() => {
    (box as HTMLInputElement).value = value;
    box.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
}

/** Answers all five questions, skipping the goal. */
function answerEverything() {
  clickAndFlush(option("House"));
  clickAndFlush(option("Techno"));
  type("Artists you love", "Four Tet");
  send();
  clickAndFlush(option("Played around"));
  clickAndFlush(within(card()).getByRole("button", { name: "Skip this question" }));
  clickAndFlush(option("Drums and beats"));
  send();
  clickAndFlush(option("Ableton Move"));
  send();
}

describe("the welcome (GRV-25)", () => {
  it("introduces Cue under its name and asks what music you love, with a way out", async () => {
    renderWelcome();
    expect(screen.getByRole("heading", { level: 1, name: "Cue" })).toBeInTheDocument();
    expect(screen.getByRole("log", { name: "Conversation" })).toHaveTextContent(
      /I'm Cue/,
    );
    expect(card()).toHaveTextContent(/What music do you love/);
    expect(
      within(card()).getByRole("textbox", { name: "Artists you love" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: SKIP_LABEL })).toBeInTheDocument();
    await waitFor(() => expect(transport.named("onboarding_started")).toHaveLength(1));
    // The editor's keys are not listening here, so the card does not offer them.
    expect(card()).not.toHaveTextContent(/Enter sends|picks/);
    expect(card().querySelector(".assistant-ask-key")).toBeNull();
    expect(option("House")).not.toHaveAttribute("aria-keyshortcuts");
  });

  it("sends the typed answer when Enter is pressed in the text box", () => {
    renderWelcome();
    clickAndFlush(option("House"));
    type("Artists you love", "Four Tet");
    const box = within(card()).getByRole("textbox", { name: "Artists you love" });
    box.focus();
    fireAndFlush(() => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    expect(screen.getByRole("log", { name: "Conversation" })).toHaveTextContent(
      "House · Four Tet",
    );
    expect(card()).toHaveTextContent(/How much music have you made/);
    expect(
      transport.named("shortcut_used").map(({ params }) => params.action_id),
    ).toEqual(["assistant.send"]);
  });

  it("asks one question at a time and shows each answer in the conversation", () => {
    renderWelcome();
    clickAndFlush(option("House"));
    type("Artists you love", "Four Tet");
    send();
    const log = screen.getByRole("log", { name: "Conversation" });
    expect(log).toHaveTextContent("House · Four Tet");
    expect(card()).toHaveTextContent(/How much music have you made/);
  });

  it("saves memory and shows it on the card once every question is settled", async () => {
    renderWelcome();
    answerEverything();

    const memory = await screen.findByRole("region", { name: "Saved to memory" });
    for (const said of [
      "House, Techno",
      "Four Tet",
      "Played around",
      "Drums and beats",
      "Ableton Move",
    ]) {
      expect(memory).toHaveTextContent(said);
    }
    expect(within(memory).getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("log", { name: "Conversation" })).toHaveTextContent(
      /first lesson/,
    );

    await waitFor(async () => {
      const loaded = await profiles.loadProfile("user-1");
      expect(loaded.ok && loaded.profile?.onboarding).toBe("completed");
    });
    const loaded = await profiles.loadProfile("user-1");
    expect(loaded.ok && loaded.profile).toMatchObject({
      memory: {
        taste: ["House", "Techno"],
        artists: "Four Tet",
        experience: "played_around",
        goal: null,
        learn: ["Drums and beats"],
        gear: ["Ableton Move"],
      },
      laterQuestions: ["goal"],
      validationConsent: false,
    });
  });

  it("logs each question once, by how it was answered, and never what was said", async () => {
    renderWelcome();
    answerEverything();
    await screen.findByRole("button", { name: OPEN_STUDIO_LABEL });

    expect(
      transport
        .named("onboarding_question_answered")
        .map(({ params }) => ({ question_id: params.question_id, how: params.how })),
    ).toEqual([
      { question_id: "taste", how: "pick" },
      { question_id: "experience", how: "pick" },
      { question_id: "goal", how: "skipped" },
      { question_id: "learn", how: "pick" },
      { question_id: "gear", how: "pick" },
    ]);
    expect(transport.named("onboarding_completed")).toHaveLength(1);
    expect(transport.named("onboarding_completed")[0]?.params).toMatchObject({
      answered_count: 4,
    });
    expect(transport.named("onboarding_validation")).toHaveLength(0);
    expect(JSON.stringify(transport.events)).not.toContain("Four Tet");
  });

  it("logs the validation event only once the box is ticked", async () => {
    renderWelcome();
    answerEverything();
    const memory = await screen.findByRole("region", { name: "Saved to memory" });
    await screen.findByRole("button", { name: OPEN_STUDIO_LABEL });
    expect(transport.named("onboarding_validation")).toHaveLength(0);

    clickAndFlush(within(memory).getByRole("checkbox"));
    await waitFor(() => expect(transport.named("onboarding_validation")).toHaveLength(1));
    expect(transport.named("onboarding_validation")[0]?.params).toMatchObject({
      experience: "played_around",
      goal: "unanswered",
    });
    const loaded = await profiles.loadProfile("user-1");
    expect(loaded.ok && loaded.profile?.validationConsent).toBe(true);
  });

  it("opens the studio with the conversation and Cue's panel waiting in it", async () => {
    const { projects } = renderWelcome();
    answerEverything();
    clickAndFlush(await screen.findByRole("button", { name: OPEN_STUDIO_LABEL }));

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const path = String(navigate.mock.calls[0]?.[0]);
    expect(path).toMatch(/^\/projects\/prj_/);
    const projectId = path.split("/").pop() ?? "";
    expect((await projects.listProjects("user-1")).map((project) => project.id)).toEqual([
      projectId,
    ]);

    const stored = parseConversation(
      sessionStorage.getItem(conversationStorageKey("user-1", projectId)),
    );
    expect(stored?.entries.some((entry) => entry.text.includes("Four Tet"))).toBe(true);
    expect(stored?.pendingAsk?.ask.question).toMatch(/first lesson/);
    expect(loadLayout().mode).not.toBe("closed");
    expect(transport.named("project_created")).toHaveLength(1);
  });
});

describe("what the welcome saves on (GRV-25)", () => {
  it("keeps what the profile already held when onboarding completes", async () => {
    await profiles.saveProfile("user-1", {
      ...emptyProfile(1),
      notes: [{ id: "note-1", text: "Likes swung hats", createdAt: 1 }],
      validationConsent: true,
      lastNudgeDay: "2026-10-01",
    });
    renderWelcome();
    await waitFor(() => expect(transport.named("onboarding_started")).toHaveLength(1));
    answerEverything();

    await waitFor(async () => {
      const loaded = await profiles.loadProfile("user-1");
      expect(loaded.ok && loaded.profile?.onboarding).toBe("completed");
    });
    const loaded = await profiles.loadProfile("user-1");
    expect(loaded.ok && loaded.profile).toMatchObject({
      notes: [{ id: "note-1", text: "Likes swung hats" }],
      lastNudgeDay: "2026-10-01",
      memory: { taste: ["House", "Techno"] },
    });
  });

  it("saves nothing over a profile it could not read", async () => {
    vi.spyOn(profiles, "loadProfile").mockResolvedValue(
      profileFailure("unavailable", "offline"),
    );
    const save = vi.spyOn(profiles, "saveProfile");
    renderWelcome();
    answerEverything();
    const memory = await screen.findByRole("region", { name: "Saved to memory" });
    await waitFor(() =>
      expect(within(memory).getByRole("button", { name: /try again/i })).toBeVisible(),
    );
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: OPEN_STUDIO_LABEL })).toBeVisible();
  });

  it("keeps a single-choice question answered only in words to ask later", async () => {
    renderWelcome();
    clickAndFlush(option("House"));
    send();
    type("Something else", "a bit of everything");
    send();
    clickAndFlush(within(card()).getByRole("button", { name: "Skip this question" }));
    clickAndFlush(option("Drums and beats"));
    send();
    clickAndFlush(option("Ableton Move"));
    send();

    await waitFor(async () => {
      const loaded = await profiles.loadProfile("user-1");
      expect(loaded.ok && loaded.profile?.onboarding).toBe("completed");
    });
    const loaded = await profiles.loadProfile("user-1");
    expect(loaded.ok && loaded.profile).toMatchObject({
      memory: { experience: null },
      laterQuestions: ["experience", "goal"],
    });
  });

  it("stops offering Skip once the last question is answered", async () => {
    renderWelcome(20);
    const next = async (text: RegExp) =>
      waitFor(() => expect(card()).toHaveTextContent(text));
    clickAndFlush(option("House"));
    send();
    await next(/How much music have you made/);
    clickAndFlush(option("Played around"));
    await next(/goal/i);
    clickAndFlush(within(card()).getByRole("button", { name: "Skip this question" }));
    await next(/learn/i);
    clickAndFlush(option("Drums and beats"));
    send();
    await next(/gear|make music with/i);
    clickAndFlush(option("Ableton Move"));
    send();

    // Cue is still writing its last reply, and Skip is already gone.
    expect(screen.queryByRole("button", { name: SKIP_LABEL })).not.toBeInTheDocument();
    await screen.findByRole("button", { name: OPEN_STUDIO_LABEL });
    await waitFor(async () => {
      const loaded = await profiles.loadProfile("user-1");
      expect(loaded.ok && loaded.profile?.onboarding).toBe("completed");
    });
    expect(transport.named("onboarding_skipped")).toHaveLength(0);
  });
});

describe("when memory will not save (GRV-25)", () => {
  it("still offers a way into the studio beside the retry", async () => {
    vi.spyOn(profiles, "saveProfile").mockResolvedValue(
      profileFailure("unavailable", "offline"),
    );
    renderWelcome();
    answerEverything();
    const memory = await screen.findByRole("region", { name: "Saved to memory" });
    await waitFor(() =>
      expect(within(memory).getByRole("button", { name: /try again/i })).toBeVisible(),
    );
    const open = screen.getByRole("button", { name: OPEN_STUDIO_LABEL });
    clickAndFlush(open);
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(String(navigate.mock.calls[0]?.[0])).toMatch(/^\/projects\/prj_/);
  });

  it("keeps a tick of the share box made while the profile is still saving", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = profiles.saveProfile.bind(profiles);
    vi.spyOn(profiles, "saveProfile").mockImplementation(async (uid, profile) => {
      await gate;
      return save(uid, profile);
    });
    renderWelcome();
    answerEverything();
    const memory = await screen.findByRole("region", { name: "Saved to memory" });
    expect(memory).toHaveTextContent(/Saving/);

    clickAndFlush(within(memory).getByRole("checkbox"));
    release();

    await waitFor(() => expect(transport.named("onboarding_validation")).toHaveLength(1));
    const loaded = await profiles.loadProfile("user-1");
    expect(loaded.ok && loaded.profile).toMatchObject({
      onboarding: "completed",
      validationConsent: true,
    });
  });
});

describe("skipping the welcome (GRV-25)", () => {
  it("saves onboarding as skipped and goes to the dashboard", async () => {
    renderWelcome();
    clickAndFlush(option("House"));
    send();
    clickAndFlush(screen.getByRole("button", { name: SKIP_LABEL }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/projects"));
    const loaded = await profiles.loadProfile("user-1");
    expect(loaded.ok && loaded.profile).toMatchObject({
      onboarding: "skipped",
      memory: { taste: ["House"] },
      laterQuestions: ["experience", "goal", "learn", "gear"],
    });
    expect(transport.named("onboarding_skipped")[0]?.params).toMatchObject({
      answered_count: 1,
    });
    expect(
      Object.keys(sessionStorage).some((key) =>
        key.startsWith(CONVERSATION_STORAGE_PREFIX),
      ),
    ).toBe(false);
  });

  it("sends someone who has been through it on to the dashboard", async () => {
    await profiles.saveProfile("user-1", { ...emptyProfile(1), onboarding: "completed" });
    renderWelcome();
    flush();
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/projects", { replace: true }),
    );
    // They are not starting onboarding, so it is not logged as started.
    expect(transport.named("onboarding_started")).toHaveLength(0);
  });
});
