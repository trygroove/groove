import { createRouter, memoryHistory, useLocation, useNavigate } from "@solidjs/router";
import { fireEvent, render, screen, within } from "@solidjs/testing-library";
import { expect, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import type { createRecordingTransport } from "../../analytics/transport";
import { ROW_METRICS } from "../../arrangement/ArrangementView";
import type { AssistantClient } from "../../assistant/assistantClient";
import type { AssistantRetentionClient } from "../../assistant/retentionClient";
import type { CapabilityReport } from "../../browser/capabilities";
import type { Project } from "../../domain/entities";
import {
  createDrumMachineInstrument,
  createDrumPad,
  createFactoryContext,
} from "../../domain/factories";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { fixturePackManifest } from "../../library/__fixtures__/fixtures";
import { LIBRARY_SAMPLE_MIME } from "../../library/assetDrag";
import type { PreviewEngine } from "../../library/audition";
import type { LibraryClient } from "../../library/libraryClient";
import { type LibraryAsset, packAssets, parsePackManifest } from "../../library/manifest";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import { createFakeRetentionClient } from "../../testing/fakeRetentionClient";
import { memoryStorage } from "../../testing/storage";
import type { UserLibraryRepository } from "../../userLibrary/userLibraryRepository";
import type { UserLibraryAccount } from "../../userLibrary/useUserLibrary";
import { editorViewFromPath, editorViewPath } from "./editorViews";

let EditorViewModule: typeof import("./EditorView");

/**
 * Loads `EditorView` once the Web Audio globals are installed. Every
 * `EditorView.<concern>.test.tsx` calls it from its `beforeAll`, because the
 * module must not be imported before the test file has installed them.
 */
export async function loadEditorView(): Promise<void> {
  EditorViewModule = await import("./EditorView");
}

/**
 * The slice fixture as a drum machine: one "BD" pad on the kick sample, the
 * four-on-the-floor clip re-pointed at that pad. A sampler note clip opens the
 * piano roll (#496), so the step grid is only reachable through a drum machine.
 */
export function createStepGridProject(): Project {
  const project = createSliceFixtureProject();
  const [track] = project.song.tracks;
  const [asset] = project.song.assets;
  const pad = createDrumPad(createFactoryContext(), { name: "BD", assetId: asset.id });
  return {
    ...project,
    song: {
      ...project.song,
      tracks: [{ ...track, instrument: createDrumMachineInstrument([pad]) }],
    },
    clips: project.clips.map((clip) =>
      clip.content.kind === "notes"
        ? {
            ...clip,
            content: {
              ...clip.content,
              events: clip.content.events.map((event) => ({
                ...event,
                trigger: { kind: "pad" as const, padId: pad.id },
              })),
            },
          }
        : clip,
    ),
  };
}

/**
 * Paints or erases one step-editor cell the way a pointer does: `pointerdown`
 * begins the stroke (add if the cell is empty, erase if filled), `pointerup`
 * commits it as one history entry. `fireEvent.click` is not enough — the step
 * editor drives painting from pointer events, not click, so a drag never starts
 * a text selection (CLP-02).
 */
export function paintStep(name: string): void {
  const cell = screen.getByRole("button", { name });
  fireEvent.pointerDown(cell, { button: 0 });
  fireEvent.pointerUp(cell);
}

/**
 * The header's save-status group. Save-failure assertions are scoped to it
 * rather than queried across the document: the library panel is open from the
 * first paint (#221) and reports its own failed load — with the same "Check
 * your connection." wording and its own Retry button — whenever its manifest
 * fetch fails, which it always does under jsdom.
 */
export function saveStatusGroup(): HTMLElement {
  const group = document.querySelector<HTMLElement>(".save-status-group");
  if (!group) throw new Error("expected the header's save-status group");
  return group;
}

/**
 * The mixer's "edit this track" control for one strip. Scoped to the mixer:
 * the arrangement's header column offers the identically named control for the
 * same track, which is the point — either surface selects it.
 */
export function mixerSelect(trackName: string): HTMLElement {
  return within(screen.getByRole("region", { name: "Mixer" })).getByRole("button", {
    name: `Edit ${trackName}`,
  });
}

/**
 * Opens the clip at bar 1 of the first arrangement row the way a producer does
 * — a double-click on the timeline (`UI-001`) — and waits for the sequence
 * editor it brings up. The coordinates mirror the renderer's own constants,
 * because a canvas has no DOM node to query for a hit.
 */
export async function openSequenceEditor(rowIndex = 0): Promise<HTMLElement> {
  await screen.findByTestId("arrangement-view-ready");
  const canvas = document.querySelector(".arrangement-layer-interactive");
  if (!canvas) throw new Error("no arrangement interaction canvas rendered");
  const PIXELS_PER_TICK = 0.08;
  const RULER_HEIGHT_PX = 22;
  // The arrangement's own row height, so aiming at row N keeps hitting row N
  // when the rows change size.
  const ROW_HEIGHT_PX = ROW_METRICS.trackHeightPx;
  const TICKS_PER_BAR = 768;
  fireAndFlush(() =>
    fireEvent.dblClick(canvas, {
      clientX: (TICKS_PER_BAR / 2) * PIXELS_PER_TICK,
      clientY: RULER_HEIGHT_PX + ROW_HEIGHT_PX * (rowIndex + 0.5),
    }),
  );
  return screen.findByRole("region", { name: "Sequence editor" });
}

/**
 * Presses `1`: from the sequence view back to the arrangement (`UI-002`), which
 * is what closing the old sequence modal became. Escape does not do it: a view
 * is not a dialog.
 */
export async function leaveForArrangement(): Promise<void> {
  fireAndFlush(() => fireEvent.keyDown(window, { key: "1" }));
  await screen.findByTestId("arrangement-view-ready");
  expect(screen.queryByRole("region", { name: "Sequence editor" })).toBeNull();
}

/**
 * Moves to a view through the dock, the way a person does (`UI-001`): the
 * editor shows exactly one, so a test wanting another has to go there.
 */
export async function goToView(
  label: "Arrangement" | "Instrument" | "Mixer",
): Promise<void> {
  // The dock exists only once the project is open, so this is also the wait.
  const dock = await screen.findByRole("navigation", { name: "Views" });
  clickAndFlush(within(dock).getByRole("link", { name: label }));
  await vi.waitFor(() =>
    expect(dock.querySelector("[aria-current='page']")).toHaveAccessibleName(label),
  );
}

/** Null when the save state offers no retry: non-retryable, or not failed. */
export function saveRetryButton(): HTMLElement | null {
  return within(saveStatusGroup()).queryByRole("button", { name: "Retry" });
}

// EditorView links back to the dashboard with a plain anchor, which the router
// only resolves from inside a matched route — so the editor is mounted over an
// in-memory history, which is Router 2's replacement for the old
// `<MemoryRouter><Route .../></MemoryRouter>` pair.
//
// The router carries the same three project paths the real table does
// (`src/router.tsx`) and derives the view from the address exactly as
// `routes/projects/Project.tsx` does, because the view *is* the address
// (`UI-001`): a harness that passed a view prop directly could not tell a
// working dock from one that navigates nowhere.
export function renderEditor(
  projectId: string,
  options: {
    createAuditionEngine?: () => PreviewEngine;
    libraryClient?: LibraryClient;
    analytics?: Analytics;
    capabilities?: CapabilityReport;
    account?: UserLibraryAccount | null;
    userLibraryRepository?: () => Promise<UserLibraryRepository>;
    assistantClient?: () => Promise<AssistantClient>;
    assistantRetentionClient?: () => Promise<AssistantRetentionClient>;
  } = {},
) {
  // Unless a test is about the disclosure, the account has already answered it.
  const retentionClient = createFakeRetentionClient({ answered: true });
  const EditorView = EditorViewModule.default;
  const location = memoryHistory(editorViewPath(projectId, "arrangement"));
  const Page = () => {
    const location = useLocation();
    const navigate = useNavigate();
    return (
      <EditorView
        projectId={projectId}
        view={editorViewFromPath(location.pathname)}
        viewHref={(view) => editorViewPath(projectId, view)}
        onSelectView={(view) => navigate(editorViewPath(projectId, view))}
        createAuditionEngine={options.createAuditionEngine}
        libraryClient={options.libraryClient}
        analytics={options.analytics}
        capabilities={options.capabilities}
        libraryAccount={options.account}
        userLibraryRepository={options.userLibraryRepository}
        assistantClient={options.assistantClient}
        assistantRetentionClient={
          options.assistantRetentionClient ?? (async () => retentionClient)
        }
      />
    );
  };
  const TestRouter = createRouter({
    history: location,
    // The real table's shape (`src/router.tsx`): one route, not one per view,
    // so a switch does not remount the editor.
    routes: [{ path: "/projects/:id/:view?", component: Page }],
  });
  return { ...render(() => <TestRouter />), location };
}

/** A library sound as a drag hands it over, already in its wire form (#225). */
export const DROPPED_HAT = {
  name: "Dropped Closed Hat",
  packId: "pak_SdlN_OazweXrwury0j27Y",
  packVersion: "1.0.0",
  kind: "sample",
  storageRef: "samples/starter-library/audio/sha256/ab/cd/abcd.wav",
  url: "/samples/starter-library/audio/sha256/ab/cd/abcd.wav",
  durationSeconds: 0.25,
  sampleRate: 48000,
  channelCount: 1,
  licence: "solid-groove-owned",
};

/** jsdom implements no `DataTransfer`; this is the slice a drop reads. */
export function transferCarrying(sample: unknown) {
  const payload = JSON.stringify(sample);
  return {
    types: [LIBRARY_SAMPLE_MIME],
    getData: (format: string) => (format === LIBRARY_SAMPLE_MIME ? payload : ""),
    setData: () => {},
  };
}

/**
 * The name of the first loop in a committed fixture pack.
 *
 * Read from the manifest rather than written down, so a test that needs "a
 * loop" keeps pointing at one when the delivered library changes underneath
 * it — the same reason CF-005 finds its loop by reading the rows.
 */
export function loopAssetName(slug: string): string {
  return assetNameOfType(slug, "loop");
}

/** The name of the first insertable one-shot in a committed fixture pack. */
export function oneShotAssetName(slug: string): string {
  return assetNameOfType(slug, "one-shot");
}

/** The insertable one-shots of the committed Core Electronic Drums fixture. */
export function drumOneShots(): LibraryAsset[] {
  const manifest = parsePackManifest(fixturePackManifest("core-electronic-drums"));
  return packAssets(manifest).filter((asset) => asset.type === "one-shot" && asset.url);
}

export function assetNameOfType(slug: string, type: "loop" | "one-shot"): string {
  const manifest = parsePackManifest(fixturePackManifest(slug));
  const found = packAssets(manifest).find((asset) => asset.type === type && asset.url);
  if (!found) throw new Error(`fixture pack "${slug}" ships no ${type}`);
  return found.name;
}

export function recordingAnalytics(
  transport: ReturnType<typeof createRecordingTransport>,
  consent: ConsentStore = new ConsentStore(memoryStorage()),
): Analytics {
  const analytics = new Analytics({
    transport,
    consent,
    storage: memoryStorage(),
  });
  analytics.setAccountType("anonymous");
  return analytics;
}

/**
 * Opens the library from the sampler's sample slot (`UI-001`), which is the
 * only way in now that the always-on column is gone.
 */
/**
 * The sampler's own panel. Its sound's name also shows in the instrument
 * header above it (#447), so a lookup by that name is scoped to the panel.
 */
export function sampler(): HTMLElement {
  return screen.getByRole("region", { name: "Sampler" });
}

/** Select a sound (auditioning it), then commit it with the modal's Insert (LIB-010). */
export async function insertSound(name: string): Promise<void> {
  // The shelf opens on the slot's family, so find the sound by name first.
  fireEvent.input(await screen.findByRole("searchbox", { name: "Search sounds" }), {
    target: { value: name },
  });
  fireEvent.click(await screen.findByRole("button", { name: `Audition ${name}` }));
  clickAndFlush(await screen.findByRole("button", { name: `Insert ${name}` }));
}

/** The sound a slot names, apart from the Library's key it also shows. */
export const slotSound = (label: string) =>
  screen.getByRole("button", { name: label }).querySelector(".sample-slot-name")
    ?.textContent;

/** Opens the Library from the drum machine's selected pad slot. */
export async function openLibraryFromPad(): Promise<HTMLElement> {
  await goToView("Instrument");
  clickAndFlush(await screen.findByRole("button", { name: /^Sample for / }));
  return screen.findByRole("region", { name: "Library" });
}

export async function openLibrary(): Promise<HTMLElement> {
  await goToView("Instrument");
  clickAndFlush(await screen.findByRole("button", { name: "Sample" }));
  return screen.findByRole("region", { name: "Library" });
}

/** Leaves the Library view by a view key: a view has no close (UI-002). */
/** The Library's Insert button has inserted and gone back (`UI-002`). */
export async function backFromInsert(): Promise<void> {
  await vi.waitFor(() =>
    expect(screen.queryByRole("region", { name: "Library" })).toBeNull(),
  );
}

export async function leaveLibrary(key = "3"): Promise<void> {
  fireAndFlush(() => fireEvent.keyDown(window, { key }));
  await vi.waitFor(() =>
    expect(screen.queryByRole("region", { name: "Library" })).toBeNull(),
  );
}

/** A pointer event at bar 1 of the first arrangement row, where the slice
 * fixture's only placement sits. The canvas has no DOM node to aim at. */
export function firePointerAtStarterClip(canvas: Element, type: string): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: (768 / 2) * 0.08,
    clientY: 22 + 28 / 2,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireAndFlush(() => fireEvent(canvas, event));
}
