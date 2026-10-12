import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import { createRecordingTransport } from "../analytics/transport";
import { addNotes, removeTrack, setParameter } from "../commands";
import type { Project } from "../domain/entities";
import { createFactoryContext, createNoteEvent } from "../domain/factories";
import { createSliceFixtureProject } from "../domain/fixtures";
import type { ClipId } from "../domain/ids";
import { SONG_TEMPO, TRACK_VOLUME } from "../domain/parameters";
import { TICKS_PER_SIXTEENTH } from "../domain/time";
import {
  createInMemoryProjectRepository,
  type InMemoryProjectRepository,
} from "../persistence/inMemoryProjectRepository";
import type { ProjectRepository } from "../persistence/projectRepository";
import { createManualClock } from "../shared/clock";
import { createManualScheduler, type Scheduler } from "../shared/scheduler";
import { memoryStorage } from "../testing/storage";
import { EditorSession, type SessionNotice } from "./EditorSession";

/**
 * Two tabs on one project (GRV-88). Tab A's coalescing window is long, so an
 * edit stays queued (unsaved) until the test flushes it.
 */
const sessions: EditorSession[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

function openTab(
  repository: ProjectRepository,
  project: Project,
  options: { analytics?: Analytics; scheduler?: Scheduler } = {},
): EditorSession {
  const session = new EditorSession({
    repository,
    project,
    clock: createManualClock(1_000),
    analytics: options.analytics,
    scheduler: options.scheduler,
    deviceStorage: memoryStorage(),
    coalesceMs: 60_000,
  });
  sessions.push(session);
  return session;
}

async function setUp() {
  const repository = createInMemoryProjectRepository();
  const project = createSliceFixtureProject();
  const created = await repository.createProject(project);
  if (!created.ok) throw new Error("fixture project failed to create");
  const transport = createRecordingTransport();
  const analytics = new Analytics({
    transport,
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  analytics.setAccountType("anonymous");
  const tabA = openTab(repository, project, { analytics });
  const tabB = openTab(repository, project);
  const notices: SessionNotice[] = [];
  tabA.subscribeNotices((notice) => notices.push(notice));
  const track = project.song.tracks[0];
  if (!track) throw new Error("expected a track");
  const clipId = project.clips[0]?.id as ClipId;
  const tempo = (value: number) =>
    setParameter({ scope: "song", parameterId: SONG_TEMPO.id }, value);
  const volume = (value: number) =>
    setParameter(
      { scope: "track", trackId: track.id, parameterId: TRACK_VOLUME.id },
      value,
    );
  const note = () =>
    addNotes(clipId, [
      createNoteEvent(createFactoryContext(), {
        startTicks: TICKS_PER_SIXTEENTH,
        durationTicks: TICKS_PER_SIXTEENTH,
        pitch: 36,
      }),
    ]);
  return {
    repository,
    project,
    tabA,
    tabB,
    transport,
    notices,
    trackId: track.id,
    clipId,
    tempo,
    volume,
    note,
  };
}

async function stored(repository: ProjectRepository, project: Project): Promise<Project> {
  const loaded = await repository.loadProject(project.metadata.id);
  if (!loaded.ok) throw new Error("expected the project to load");
  return loaded.value;
}

function notesIn(project: Project, clipId: ClipId): number {
  const clip = project.clips.find((candidate) => candidate.id === clipId);
  return clip?.content.kind === "notes" ? clip.content.events.length : -1;
}

/** Holds every write tab A makes until `release` is called. */
function holdWrites(repository: InMemoryProjectRepository): {
  repository: ProjectRepository;
  release: () => void;
} {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gated: ProjectRepository = Object.create(repository);
  gated.saveChanges = async (...args) => {
    await held;
    return repository.saveChanges(...args);
  };
  return { repository: gated, release };
}

/**
 * Holds tab A's first `held` writes, each until its own `release(i)`; later
 * writes go straight through. Counts every write, and stops writing (the call
 * never settles) past `cap`, so a session that loops on its own writes ends
 * the test with a count rather than starving the event loop.
 */
function gateWrites(
  repository: InMemoryProjectRepository,
  held: number,
  cap = 20,
): {
  repository: ProjectRepository;
  release: (index: number) => void;
  readonly writes: number;
} {
  const releases: Array<() => void> = [];
  const gates = Array.from(
    { length: held },
    (_, index) =>
      new Promise<void>((resolve) => {
        releases[index] = resolve;
      }),
  );
  let writes = 0;
  const gated: ProjectRepository = Object.create(repository);
  gated.saveChanges = async (...args) => {
    const index = writes++;
    if (index >= cap) return new Promise(() => {});
    if (index < held) await gates[index];
    return repository.saveChanges(...args);
  };
  return {
    repository: gated,
    release: (index) => releases[index]?.(),
    get writes() {
      return writes;
    },
  };
}

/** Lets every pending promise and the in-memory store's notifications settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("EditorSession, its own write echoing back mid-write (GRV-88)", () => {
  it("does not mistake its own echo for another tab's change when it edits during a write", async () => {
    const { repository, project, volume, note, clipId } = await setUp();
    const gate = gateWrites(repository, 1);
    const tab = openTab(gate.repository, project);
    const notices: SessionNotice[] = [];
    tab.subscribeNotices((notice) => notices.push(notice));

    tab.dispatch(note());
    const writing = tab.autosave.flush();
    tab.dispatch(volume(-12));
    // An edit made during a write sets the state to pending; the write is
    // still in flight.
    expect(tab.autosave.status.state).toBe("pending");
    expect(tab.autosave.writing).toBe(true);

    gate.release(0);
    await writing;
    await tab.autosave.flush();
    await settle();

    expect(gate.writes).toBeLessThanOrEqual(2);
    expect(notices).toEqual([]);
    expect(tab.history.entries).toHaveLength(2);
    expect(tab.autosave.status.state).toBe("saved");
    const reloaded = await stored(repository, project);
    expect(reloaded.metadata.revision).toBe(tab.autosave.status.revision);
    expect(notesIn(reloaded, clipId)).toBe(notesIn(project, clipId) + 1);
    expect(reloaded.song.tracks[0]?.mixer.volume).toBe(-12);
  });
});

describe("EditorSession, an unsaved edit when another tab saves (GRV-88)", () => {
  it("does not replay an edit whose write landed before a later write was refused", async () => {
    const base = await setUp();
    const { repository, project, tempo, volume, note, clipId } = base;
    const gate = gateWrites(repository, 2);
    const transport = createRecordingTransport();
    const analytics = new Analytics({
      transport,
      consent: new ConsentStore(memoryStorage()),
      storage: memoryStorage(),
    });
    analytics.setAccountType("anonymous");
    const tabA = openTab(gate.repository, project, { analytics });
    const notices: SessionNotice[] = [];
    tabA.subscribeNotices((notice) => notices.push(notice));
    const start = project.metadata.revision;

    // Edit 1 goes out; edit 2 is made while it is in flight.
    tabA.dispatch(note());
    const writing = tabA.autosave.flush();
    tabA.dispatch(volume(-12));
    gate.release(0);
    // Edit 1 lands at start + 1, and the same drain writes edit 2 (held).
    await vi.waitFor(() => expect(gate.writes).toBe(2));

    // Tab B takes in edit 1 and saves its own change on top of it.
    await vi.waitFor(() =>
      expect(notesIn(base.tabB.committedProject, clipId)).toBe(
        notesIn(project, clipId) + 1,
      ),
    );
    base.tabB.dispatch(tempo(140));
    await base.tabB.autosave.flush();
    expect(base.tabB.autosave.status.revision).toBe(start + 2);

    // Edit 2's write at start + 1 is refused; only edit 2 is replayed.
    gate.release(1);
    await writing;
    await vi.waitFor(() => expect(tabA.committedProject.song.tempo).toBe(140));
    const saved = await tabA.autosave.flush();
    expect(saved.state).toBe("saved");
    expect(notices).toEqual([]);
    expect(tabA.history.entries).toHaveLength(2);
    expect(transport.named("unsaved_edits_replayed")[0]?.params).toMatchObject({
      replayed_count: 1,
      dropped_count: 0,
    });

    const reloaded = await stored(repository, project);
    expect(reloaded.song.tempo).toBe(140);
    expect(reloaded.song.tracks[0]?.mixer.volume).toBe(-12);
    expect(notesIn(reloaded, clipId)).toBe(notesIn(project, clipId) + 1);
  });

  it("tries the load again when it fails, and then takes the other tab's change in", async () => {
    const base = await setUp();
    const { repository, project, tempo, volume } = base;
    const scheduler = createManualScheduler();
    let failLoads = 1;
    const flaky: ProjectRepository = Object.create(repository);
    flaky.loadProject = async (...args) => {
      if (failLoads > 0) {
        failLoads -= 1;
        return { ok: false, reason: "unavailable", message: "offline" };
      }
      return repository.loadProject(...args);
    };
    const tabA = openTab(flaky, project, { scheduler });

    tabA.dispatch(volume(-12));
    base.tabB.dispatch(tempo(140));
    await base.tabB.autosave.flush();
    await vi.waitFor(() => expect(failLoads).toBe(0));
    await settle();
    expect(tabA.committedProject.song.tempo).toBe(project.song.tempo);

    scheduler.runAll();
    await vi.waitFor(() => expect(tabA.committedProject.song.tempo).toBe(140));
    const saved = await tabA.autosave.flush();
    expect(saved.state).toBe("saved");
    const reloaded = await stored(repository, project);
    expect(reloaded.song.tempo).toBe(140);
    expect(reloaded.song.tracks[0]?.mixer.volume).toBe(-12);
  });

  it("replays a queued edit on top of the other tab's change and ends on Saved", async () => {
    const { repository, project, tabA, tabB, transport, notices, tempo, volume } =
      await setUp();

    tabA.dispatch(volume(-12));
    expect(tabA.autosave.status.pending).toBeGreaterThan(0);
    tabB.dispatch(tempo(140));
    await tabB.autosave.flush();

    await vi.waitFor(() => expect(tabA.committedProject.song.tempo).toBe(140));
    expect(tabA.committedProject.song.tracks[0]?.mixer.volume).toBe(-12);
    const saved = await tabA.autosave.flush();
    expect(saved.state).toBe("saved");
    expect(saved.failure).toBeNull();

    const reloaded = await stored(repository, project);
    expect(reloaded.song.tempo).toBe(140);
    expect(reloaded.song.tracks[0]?.mixer.volume).toBe(-12);
    expect(notices).toEqual([]);
    expect(transport.named("unsaved_edits_replayed")).toHaveLength(1);
    expect(transport.named("unsaved_edits_replayed")[0]?.params).toMatchObject({
      replayed_count: 1,
      dropped_count: 0,
    });

    // Undo stays: the replayed edit is still this tab's to take back.
    expect(tabA.undo()?.ok).toBe(true);
    expect(tabA.committedProject.song.tracks[0]?.mixer.volume).toBe(
      project.song.tracks[0]?.mixer.volume,
    );
    expect(tabA.committedProject.song.tempo).toBe(140);
  });

  it("replays an edit whose write was in flight once that write is refused", async () => {
    const base = await setUp();
    const { repository, project, tempo, volume } = base;
    const held = holdWrites(repository);
    const tabA = openTab(held.repository, project);

    tabA.dispatch(volume(-12));
    const writing = tabA.autosave.flush();
    expect(tabA.autosave.status.state).toBe("saving");
    base.tabB.dispatch(tempo(140));
    await base.tabB.autosave.flush();

    held.release();
    await writing;
    await vi.waitFor(() => expect(tabA.committedProject.song.tempo).toBe(140));
    const saved = await tabA.autosave.flush();
    expect(saved.state).toBe("saved");

    const reloaded = await stored(repository, project);
    expect(reloaded.song.tempo).toBe(140);
    expect(reloaded.song.tracks[0]?.mixer.volume).toBe(-12);
  });

  it("drops only the edit that no longer applies, with a notice, and ends on Saved", async () => {
    const {
      repository,
      project,
      tabA,
      tabB,
      transport,
      notices,
      trackId,
      clipId,
      note,
      tempo,
    } = await setUp();

    tabA.dispatch(tempo(150));
    tabA.dispatch(note());
    expect(tabA.history.entries).toHaveLength(2);
    tabB.dispatch(removeTrack(trackId));
    await tabB.autosave.flush();

    await vi.waitFor(() =>
      expect(notices).toEqual([{ kind: "edits_discarded", count: 1 }]),
    );
    expect(tabA.committedProject.song.tracks.some((track) => track.id === trackId)).toBe(
      false,
    );
    expect(notesIn(tabA.committedProject, clipId)).toBe(-1);
    expect(tabA.committedProject.song.tempo).toBe(150);
    // The dropped edit leaves nothing behind to undo; the kept one stays.
    expect(tabA.history.entries).toHaveLength(1);
    const saved = await tabA.autosave.flush();
    expect(saved.state).toBe("saved");

    const reloaded = await stored(repository, project);
    expect(reloaded.song.tempo).toBe(150);
    expect(reloaded.song.tracks.some((track) => track.id === trackId)).toBe(false);
    expect(transport.named("unsaved_edits_replayed")).toHaveLength(1);
    expect(transport.named("unsaved_edits_replayed")[0]?.params).toMatchObject({
      replayed_count: 1,
      dropped_count: 1,
    });
  });

  it("replays a committed gesture as the one edit it is", async () => {
    const { repository, project, tabA, tabB, tempo, volume } = await setUp();
    const drag = tabA.beginGesture();
    drag.apply(volume(-3));
    drag.apply(volume(-6));
    drag.commit();
    tabB.dispatch(tempo(140));
    await tabB.autosave.flush();

    await vi.waitFor(() => expect(tabA.committedProject.song.tempo).toBe(140));
    expect(tabA.committedProject.song.tracks[0]?.mixer.volume).toBe(-6);
    expect(tabA.history.entries).toHaveLength(1);
    await tabA.autosave.flush();
    const reloaded = await stored(repository, project);
    expect(reloaded.song.tempo).toBe(140);
    expect(reloaded.song.tracks[0]?.mixer.volume).toBe(-6);
  });

  it("raises no notice and logs no replay for a plain remote change", async () => {
    const { tabA, tabB, transport, notices, tempo } = await setUp();
    tabB.dispatch(tempo(140));
    await tabB.autosave.flush();
    await vi.waitFor(() => expect(tabA.committedProject.song.tempo).toBe(140));
    expect(notices).toEqual([]);
    expect(transport.named("unsaved_edits_replayed")).toHaveLength(0);
  });
});

describe("EditorSession, an undo that no longer applies (GRV-88)", () => {
  it("refuses the undo with a notice and leaves the project and the entry alone", async () => {
    const { tabA, tabB, transport, notices, trackId, note } = await setUp();
    tabA.dispatch(note());
    await tabA.autosave.flush();
    await vi.waitFor(() =>
      expect(tabB.autosave.status.revision).toBe(tabA.autosave.status.revision),
    );

    tabB.dispatch(removeTrack(trackId));
    await tabB.autosave.flush();
    await vi.waitFor(() =>
      expect(
        tabA.committedProject.song.tracks.some((track) => track.id === trackId),
      ).toBe(false),
    );

    const before = tabA.committedProject;
    const result = tabA.undo();
    expect(result?.ok).toBe(false);
    expect(tabA.committedProject).toBe(before);
    expect(tabA.history.entries).toHaveLength(1);
    expect(notices).toEqual([{ kind: "undo_refused", direction: "undo" }]);
    expect(transport.named("undo_refused")).toHaveLength(1);
    expect(transport.named("undo_refused")[0]?.params).toMatchObject({
      direction: "undo",
    });
    expect(transport.named("undo_used")).toHaveLength(0);
  });

  it("refuses a redo the same way", async () => {
    const { tabA, tabB, transport, notices, trackId, note } = await setUp();
    tabA.dispatch(note());
    tabA.undo();
    await tabA.autosave.flush();
    await vi.waitFor(() =>
      expect(tabB.autosave.status.revision).toBe(tabA.autosave.status.revision),
    );

    tabB.dispatch(removeTrack(trackId));
    await tabB.autosave.flush();
    await vi.waitFor(() =>
      expect(
        tabA.committedProject.song.tracks.some((track) => track.id === trackId),
      ).toBe(false),
    );

    expect(tabA.redo()?.ok).toBe(false);
    expect(tabA.history.redoEntries).toHaveLength(1);
    expect(notices).toEqual([{ kind: "undo_refused", direction: "redo" }]);
    expect(transport.named("undo_refused")).toHaveLength(1);
    expect(transport.named("undo_refused")[0]?.params).toMatchObject({
      direction: "redo",
    });
  });
});
