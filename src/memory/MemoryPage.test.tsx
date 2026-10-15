import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import {
  createRecordingTransport,
  type RecordingTransport,
} from "../analytics/transport";
import { InMemoryProfileRepository } from "../persistence/inMemoryProfileRepository";
import {
  emptyProfile,
  MAX_MEMORY_LIST,
  type ProducerProfile,
} from "../persistence/profileDocuments";
import { clickAndFlush, fireAndFlush } from "../testing/events";
import { memoryStorage } from "../testing/storage";
import MemoryPage from "./MemoryPage";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ user: { uid: "user-1" }, loading: false, isAnonymous: false }),
}));

const PROFILE: ProducerProfile = {
  ...emptyProfile(1),
  onboarding: "completed",
  onboardedAt: 1,
  memory: {
    taste: ["Techno"],
    artists: "Four Tet",
    experience: "played_around",
    goal: "first_track",
    learn: ["Mixing"],
    gear: ["Ableton Move"],
  },
  notes: [
    { id: "n1", text: "Making more trap lately", createdAt: 1 },
    { id: "n2", text: "Works late at night", createdAt: 2 },
  ],
  laterQuestions: [],
};

let profiles: InMemoryProfileRepository;
let transport: RecordingTransport;

beforeEach(async () => {
  profiles = new InMemoryProfileRepository();
  await profiles.saveProfile("user-1", PROFILE);
});

afterEach(cleanup);

async function renderPage() {
  transport = createRecordingTransport();
  const analytics = new Analytics({
    transport,
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  render(() => <MemoryPage analytics={analytics} profiles={async () => profiles} />);
  await screen.findByRole("heading", { name: "About you" });
}

async function stored(): Promise<ProducerProfile> {
  const loaded = await profiles.loadProfile("user-1");
  if (!loaded.ok || !loaded.profile) throw new Error("no profile");
  return loaded.profile;
}

describe("the Memory page (GRV-25)", () => {
  it("shows every field and note, editable", async () => {
    await renderPage();
    expect(screen.getByLabelText("Music you love")).toHaveValue("Techno");
    expect(screen.getByLabelText("Artists")).toHaveValue("Four Tet");
    expect(screen.getByLabelText("Experience")).toHaveValue("played_around");
    expect(screen.getByLabelText("Gear")).toHaveValue("Ableton Move");
    expect(screen.getByLabelText("Note 1")).toHaveValue("Making more trap lately");
    expect(screen.getByLabelText("Note 2")).toHaveValue("Works late at night");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("saves an edit to a field and a note", async () => {
    await renderPage();
    fireAndFlush(() =>
      fireEvent.input(screen.getByLabelText("Gear"), {
        target: { value: "Ableton Move, OP-1" },
      }),
    );
    fireAndFlush(() =>
      fireEvent.input(screen.getByLabelText("Note 2"), {
        target: { value: "Works early now" },
      }),
    );
    clickAndFlush(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(async () =>
      expect((await stored()).memory.gear).toEqual(["Ableton Move", "OP-1"]),
    );
    expect((await stored()).notes.map((note) => note.text)).toEqual([
      "Making more trap lately",
      "Works early now",
    ]);
    expect(transport.named("onboarding_validation")).toHaveLength(0);
  });

  it("saves a list without repeats and no longer than memory keeps", async () => {
    await renderPage();
    const many = Array.from({ length: MAX_MEMORY_LIST + 4 }, (_, i) => `Synth ${i}`);
    fireAndFlush(() =>
      fireEvent.input(screen.getByLabelText("Gear"), {
        target: { value: ["OP-1", "op-1", ...many].join(", ") },
      }),
    );
    clickAndFlush(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(async () => expect((await stored()).memory.gear[0]).toBe("OP-1"));
    const gear = (await stored()).memory.gear;
    expect(gear).toHaveLength(MAX_MEMORY_LIST);
    expect(gear.filter((item) => item.toLowerCase() === "op-1")).toHaveLength(1);
  });

  it("forgets one field, one note, and logs which without what it said", async () => {
    await renderPage();
    clickAndFlush(screen.getByRole("button", { name: "Forget Artists" }));
    await waitFor(async () => expect((await stored()).memory.artists).toBe(""));
    clickAndFlush(screen.getByRole("button", { name: "Forget note 1" }));
    await waitFor(async () =>
      expect((await stored()).notes.map((note) => note.id)).toEqual(["n2"]),
    );
    expect(transport.named("memory_forgotten").map((event) => event.params.what)).toEqual(
      ["field", "note"],
    );
    expect(JSON.stringify(transport.events)).not.toContain("Four Tet");
  });

  it("keeps an unsaved edit elsewhere when one field or note is forgotten", async () => {
    await renderPage();
    fireAndFlush(() =>
      fireEvent.input(screen.getByLabelText("Gear"), {
        target: { value: "Ableton Move, OP-1" },
      }),
    );
    fireAndFlush(() =>
      fireEvent.input(screen.getByLabelText("Note 2"), {
        target: { value: "Works early now" },
      }),
    );
    clickAndFlush(screen.getByRole("button", { name: "Forget Artists" }));
    await waitFor(async () => expect((await stored()).memory.artists).toBe(""));
    clickAndFlush(screen.getByRole("button", { name: "Forget note 1" }));
    await waitFor(async () =>
      expect((await stored()).notes.map((note) => note.id)).toEqual(["n2"]),
    );
    expect(screen.getByLabelText("Artists")).toHaveValue("");
    expect(screen.getByLabelText("Gear")).toHaveValue("Ableton Move, OP-1");
    expect(screen.getByLabelText("Note 1")).toHaveValue("Works early now");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    // Saving the rest does not bring the forgotten field back.
    clickAndFlush(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(async () =>
      expect((await stored()).memory.gear).toEqual(["Ableton Move", "OP-1"]),
    );
    expect((await stored()).memory.artists).toBe("");
    expect((await stored()).notes.map((note) => note.text)).toEqual(["Works early now"]);
  });

  it("forgets everything once it is confirmed", async () => {
    await renderPage();
    clickAndFlush(screen.getByRole("button", { name: "Forget everything" }));
    const dialog = screen.getByRole("alertdialog");
    clickAndFlush(
      [...dialog.querySelectorAll("button")].find(
        (button) => button.textContent === "Forget everything",
      ) as HTMLButtonElement,
    );
    await waitFor(async () => expect((await stored()).notes).toEqual([]));
    const profile = await stored();
    expect(profile.memory).toEqual(emptyProfile(1).memory);
    expect(profile.onboarding).toBe("completed");
    expect(transport.named("memory_forgotten")[0]?.params.what).toBe("everything");
  });

  it("logs the validation event only when the share box is ticked", async () => {
    await renderPage();
    expect(transport.named("onboarding_validation")).toHaveLength(0);
    clickAndFlush(screen.getByRole("checkbox"));
    await waitFor(() => expect(transport.named("onboarding_validation")).toHaveLength(1));
    expect((await stored()).validationConsent).toBe(true);
    expect(
      transport.named("onboarding_validation_chip").map((event) => event.params),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: "learn", chip: "mixing" }),
        expect.objectContaining({ group: "gear", chip: "ableton_move" }),
      ]),
    );
  });
});
