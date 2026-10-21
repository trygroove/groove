import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { createRecordingTransport } from "../../analytics/transport";
import { createSliceFixtureProject } from "../../domain/fixtures";
import type { PlacementId } from "../../domain/ids";
import { createFakeAssistantClient } from "../../testing/fakeAssistantClient";
import { memoryStorage } from "../../testing/storage";
import type { EditorViewName } from "../composition/editorViews";
import type { ScopeSources } from "./assistantScope";
import { type AssistantChat, useAssistantChat } from "./useAssistantChat";

const project = createSliceFixtureProject();
const track = project.song.tracks[0] ?? null;
const placementIds = project.song.placements
  .slice(0, 1)
  .map((p) => p.id) as PlacementId[];
const oneClip: ScopeSources = { selection: { kind: "clips", placementIds }, track };
const trackOnly: ScopeSources = { selection: null, track };

function chatOver(initial: ScopeSources, initialView: EditorViewName = "arrangement") {
  const [sources, setSources] = createSignal(initial);
  const [view, setView] = createSignal<EditorViewName>(initialView);
  const client = createFakeAssistantClient();
  const analytics = new Analytics({
    transport: createRecordingTransport(),
    storage: memoryStorage(),
  });
  let chat: AssistantChat | undefined;
  const dispose = createRoot((dispose) => {
    chat = useAssistantChat({
      project: () => project,
      view,
      sources,
      account: () => ({ registered: true }),
      expanded: () => true,
      client: async () => client,
      analytics: () => analytics,
    });
    return dispose;
  });
  flush();
  if (!chat) throw new Error("the chat did not start");
  const select = (next: ScopeSources) => {
    setSources(next);
    flush();
  };
  const show = (next: EditorViewName) => {
    setView(next);
    flush();
  };
  return { chat, select, show, dispose };
}

describe("the assistant's scope chip (GRV-26)", () => {
  it("forgets a widened choice when the selection changes, even back to the one it was made for", () => {
    // QA's F1: widen with nothing selected, pick a clip, click away again.
    const { chat, select, dispose } = chatOver(oneClip);
    select(trackOnly);
    expect(chat.scope().label).toBe("BD");
    chat.widenScope();
    flush();
    expect(chat.scope().label).toBe("Whole song");
    select(oneClip);
    expect(chat.scope().label).toBe("1 clip");
    select(trackOnly);
    expect(chat.scope().label).toBe("BD");
    dispose();
  });

  it("keeps the choice while the selection stays put", () => {
    const { chat, show, dispose } = chatOver(trackOnly);
    chat.widenScope();
    flush();
    show("mixer");
    expect(chat.scope().label).toBe("Whole song");
    dispose();
  });
});

describe("the assistant's suggestion chips (GRV-26)", () => {
  it("change with the view and with the scope", () => {
    // QA's F2: the chips were the same everywhere.
    const { chat, select, show, dispose } = chatOver(oneClip);
    const ids = () => chat.suggestions().map((suggestion) => suggestion.id);
    const seen = new Set<string>();
    const remember = () => seen.add(ids().join(","));
    remember();
    select(trackOnly);
    remember();
    for (const view of ["sequence", "instrument", "library", "mixer"] as const) {
      show(view);
      remember();
    }
    chat.widenScope();
    flush();
    remember();
    expect(seen.size).toBeGreaterThanOrEqual(6);
    dispose();
  });
});
