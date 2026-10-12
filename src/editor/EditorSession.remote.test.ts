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
  options: { analytics?: Analytics } = {},
): EditorSession {
  const session = new EditorSession({
    repository,
    project,
    clock: createManualClock(1_000),
    analytics: options.analytics,
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

describe("EditorSession, an unsaved edit when another tab saves (GRV-88)", () => {
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
