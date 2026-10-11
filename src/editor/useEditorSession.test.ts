import { cleanup, renderHook } from "@solidjs/testing-library";
import { createMemo, createRoot, DEV, flush, getOwner, type Owner } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROW_METRICS } from "../arrangement/ArrangementView";
import { buildArrangementProjection } from "../arrangement/projection";
import { removeNotes } from "../commands";
import type { Project } from "../domain/entities";
import { createReferenceProject, createSliceFixtureProject } from "../domain/fixtures";
import type { ClipId } from "../domain/ids";
import { createInMemoryProjectRepository } from "../persistence/inMemoryProjectRepository";
import { estimateStereoBytes, exportFacts } from "./export/exportFacts";
import { planStemsFiles } from "./export/stemsExport";
import { useEditorSession } from "./useEditorSession";

afterEach(() => {
  cleanup();
});

/**
 * The PRD `PRJ-03` navigation-flush half of `LOOP-002`: a queued-but-not-yet-
 * written edit must reach the repository when the browser signals the page
 * might not run again, not only when the in-app router tears the session
 * down (that half is `useEditorSession`'s existing `onCleanup`, exercised by
 * the "changing projects" test below).
 */
describe("useEditorSession navigation flush", () => {
  it("flushes a queued edit on pagehide, before the coalescing window elapses", async () => {
    const repository = createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    repository.clearWrites();

    const clip = project.clips[0];
    if (clip.content.kind !== "notes") throw new Error("expected a note clip");
    const clipId = clip.id as ClipId;
    const eventId = clip.content.events[0].id;

    const { result } = renderHook(
      () =>
        useEditorSession(
          () => project.metadata.id,
          () => repository,
        ),
      {},
    );

    await vi.waitFor(() => expect(result.state.loading).toBe(false));

    result.dispatch(removeNotes(clipId, [eventId]));
    // Solid 2 batches writes: the autosave subscription has already written
    // the queued status into the store, but a read only sees it once the
    // batch flushes. `flush()` is that synchronous catch-up point, and a test
    // asserting immediately after an action is exactly what it is for.
    flush();
    expect(result.state.saveStatus?.pending).toBe(1);
    // Nothing has reached the repository yet — the default coalescing
    // window (400ms) has not elapsed and no real time has passed in this
    // test.
    expect(repository.writes).toHaveLength(0);

    window.dispatchEvent(new Event("pagehide"));
    // `flush()` writes are async even once started; let the promise chain it
    // kicked off actually settle.
    await vi.waitFor(() => expect(repository.writes.length).toBeGreaterThan(0));

    const loaded = await repository.loadProject(project.metadata.id);
    if (!loaded.ok) throw new Error("expected the project to load");
    const savedClip = loaded.value.clips.find((c) => c.id === clipId);
    if (savedClip?.content.kind !== "notes") throw new Error("expected notes");
    expect(savedClip.content.events.some((event) => event.id === eventId)).toBe(false);
  });

  it("flushes a queued edit on visibilitychange to hidden", async () => {
    const repository = createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    repository.clearWrites();

    const clip = project.clips[0];
    if (clip.content.kind !== "notes") throw new Error("expected a note clip");
    const clipId = clip.id as ClipId;
    const eventId = clip.content.events[0].id;

    const { result } = renderHook(
      () =>
        useEditorSession(
          () => project.metadata.id,
          () => repository,
        ),
      {},
    );

    await vi.waitFor(() => expect(result.state.loading).toBe(false));

    result.dispatch(removeNotes(clipId, [eventId]));
    expect(repository.writes).toHaveLength(0);

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => expect(repository.writes.length).toBeGreaterThan(0));
    vi.restoreAllMocks();
  });

  it("asks before unloading while an edit is unsaved, and starts writing it (GRV-60)", async () => {
    const repository = createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    repository.clearWrites();

    const clip = project.clips[0];
    if (clip.content.kind !== "notes") throw new Error("expected a note clip");
    const clipId = clip.id as ClipId;
    const eventId = clip.content.events[0].id;

    const { result } = renderHook(
      () =>
        useEditorSession(
          () => project.metadata.id,
          () => repository,
        ),
      {},
    );

    await vi.waitFor(() => expect(result.state.loading).toBe(false));

    const idle = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false);

    result.dispatch(removeNotes(clipId, [eventId]));
    const unsaved = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unsaved);
    expect(unsaved.defaultPrevented).toBe(true);

    await vi.waitFor(() => expect(repository.writes.length).toBeGreaterThan(0));
  });

  it("still flushes on unmount (in-app navigation away from the project)", async () => {
    const repository = createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    repository.clearWrites();

    const clip = project.clips[0];
    if (clip.content.kind !== "notes") throw new Error("expected a note clip");
    const clipId = clip.id as ClipId;
    const eventId = clip.content.events[0].id;

    const { result, cleanup: cleanupHook } = renderHook(
      () =>
        useEditorSession(
          () => project.metadata.id,
          () => repository,
        ),
      {},
    );

    await vi.waitFor(() => expect(result.state.loading).toBe(false));

    result.dispatch(removeNotes(clipId, [eventId]));
    expect(repository.writes).toHaveLength(0);

    cleanupHook();

    await vi.waitFor(() => expect(repository.writes.length).toBeGreaterThan(0));
  });
});

describe("useEditorSession when the repository itself fails to load", () => {
  it("surfaces an error instead of sitting on the loading state for ever", async () => {
    // `EditorView` hands this hook an async `createMemo` over
    // `getProjectRepository()`, whose dynamic imports can reject -- a chunk
    // that 404s after a redeploy is the realistic trigger. A rejected read
    // arrives as a *compute-phase* error, so the effect body never runs: with
    // no error arm on the effect, `loading` stayed true and the editor showed
    // its spinner for ever, with no error surface and nothing reported. Solid
    // 1's `createResource` propagated a rejected read to the app's error
    // boundary, so this keeps that failure visible rather than silent.
    const failing = () => {
      throw new Error("repository chunk failed to load");
    };

    const { result } = renderHook(
      () => useEditorSession(() => "prj_whatever", failing as never),
      {},
    );

    await Promise.resolve();
    flush();

    expect(result.state.loading).toBe(false);
    expect(result.state.error).not.toBeNull();
    expect(result.state.notFound).toBe(false);
  });
});

describe("useEditorSession preview (UI-005)", () => {
  it("shows the previewed project while a preview is open, and the committed one after", async () => {
    const repository = createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");

    const clip = project.clips[0];
    if (clip.content.kind !== "notes") throw new Error("expected a note clip");
    const clipId = clip.id as ClipId;

    const { result } = renderHook(
      () =>
        useEditorSession(
          () => project.metadata.id,
          () => repository,
        ),
      {},
    );
    await vi.waitFor(() => expect(result.state.loading).toBe(false));
    const committed = result.state.project;
    expect(result.state.previewing).toBe(false);

    const started = result.beginPreview(removeNotes(clipId, [clip.content.events[0].id]));
    if (!started?.ok) throw new Error("expected the preview to open");
    flush();

    expect(result.state.previewing).toBe(true);
    expect(result.state.project?.clips[0].content).toEqual(
      started.preview.project.clips[0].content,
    );
    expect(result.state.canUndo).toBe(false);

    started.preview.cancel();
    flush();

    expect(result.state.previewing).toBe(false);
    expect(result.state.project?.clips[0].content).toEqual(committed?.clips[0].content);
  });
});

/**
 * #856: the project a session exposes is one immutable value per revision, so
 * a derivation over it should depend on that value, not on every store node
 * inside it. Reading it through a deep store proxy made the arrangement's
 * projection memo and the Export dialog's three memos each track thousands of
 * nodes (Solid's dev `HUGE_FAN_IN`), re-subscribing to every note per edit.
 */
describe("useEditorSession project reads (#856)", () => {
  /** A memo over `derive(project)`, and how many sources it ended up tracking. */
  function sourcesOf(read: () => Project, derive: (project: Project) => unknown): number {
    let node: Owner | null = null;
    const dispose = createRoot((dispose) => {
      const memo = createMemo(() => {
        node = getOwner();
        return derive(read());
      });
      memo();
      return dispose;
    });
    const count = DEV?.getSources(node as never).length ?? Number.NaN;
    dispose();
    return count;
  }

  it("lets the arrangement and Export derivations track the project, not its every node", async () => {
    // Ten tracks of note clips: just past the size where the issue's
    // 7-track, 4-bar project crossed Solid's 2,000-source warning.
    const project = createReferenceProject({
      trackCount: 10,
      minutes: 1,
      placementCount: 7 * 16,
      automationLaneCount: 0,
    });
    const repository = createInMemoryProjectRepository();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");

    const { result } = renderHook(
      () =>
        useEditorSession(
          () => project.metadata.id,
          () => repository,
        ),
      {},
    );
    await vi.waitFor(() => expect(result.state.loading).toBe(false));
    const read = () => {
      const current = result.state.project;
      if (!current) throw new Error("expected a loaded project");
      return current;
    };

    const capture = DEV?.diagnostics.capture();
    const counts = {
      arrangement: sourcesOf(read, (p) => buildArrangementProjection(p, ROW_METRICS)),
      facts: sourcesOf(read, exportFacts),
      plan: sourcesOf(read, (p) => planStemsFiles(p)),
      stereoBytes: sourcesOf(read, estimateStereoBytes),
    };
    const fanIn = (capture?.stop() ?? []).filter(
      (diagnostic) => diagnostic.code === "HUGE_FAN_IN",
    );

    expect({ counts, fanIn: fanIn.map((diagnostic) => diagnostic.message) }).toEqual({
      counts: { arrangement: 1, facts: 1, plan: 1, stereoBytes: 1 },
      fanIn: [],
    });
  });
});
