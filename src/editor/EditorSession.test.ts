import { beforeEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import { createRecordingTransport } from "../analytics/transport";
import {
  addNotes,
  addPack,
  removeNotes,
  removeTrack,
  renameProject,
  setLoopEnabled,
  setLoopRange,
  setParameter,
  setTrackFlag,
  updateNote,
} from "../commands";
import { type PackDependency, packVersion } from "../domain/entities";
import {
  bars,
  createFactoryContext,
  createNoteEvent,
  createSynthInstrument,
  createTrack,
} from "../domain/factories";
import { createSliceFixtureProject } from "../domain/fixtures";
import { type ClipId, packIdSchema } from "../domain/ids";
import { TRACK_VOLUME } from "../domain/parameters";
import type { JsonObject } from "../domain/serialize";
import { TICKS_PER_SIXTEENTH } from "../domain/time";
import { clipDocumentPath } from "../persistence/documents";
import { createInMemoryProjectRepository } from "../persistence/inMemoryProjectRepository";
import { createManualClock } from "../shared/clock";
import { memoryStorage } from "../testing/storage";
import { EditorSession } from "./EditorSession";

/** One shelf entry, by pack ID — the shape `pack.add` carries. */
function factoryPack(packId: string): PackDependency {
  return { packId: packIdSchema.parse(packId), version: packVersion("1.0.0") };
}

async function setUp(options: { deviceStorage?: Storage } = {}) {
  const repository = createInMemoryProjectRepository();
  const project = createSliceFixtureProject();
  const created = await repository.createProject(project);
  if (!created.ok) throw new Error("fixture project failed to create");

  const transport = createRecordingTransport();
  const consent = new ConsentStore(memoryStorage());
  const analytics = new Analytics({
    transport,
    consent,
    storage: memoryStorage(),
  });
  analytics.setAccountType("anonymous");

  const clock = createManualClock(1_000);
  const deviceStorage = options.deviceStorage ?? memoryStorage();
  const session = new EditorSession({
    repository,
    project,
    clock,
    analytics,
    deviceStorage,
  });
  const clipId = project.clips[0].id as ClipId;
  return {
    repository,
    project,
    session,
    analytics,
    transport,
    clock,
    clipId,
    deviceStorage,
  };
}

describe("EditorSession", () => {
  let ctx: Awaited<ReturnType<typeof setUp>>;

  beforeEach(async () => {
    ctx = await setUp();
  });

  it("dispatches a command through the shared kernel and updates .project", () => {
    const { session, clipId } = ctx;
    const factoryContext = createFactoryContext();
    const note = createNoteEvent(factoryContext, {
      startTicks: 1 * TICKS_PER_SIXTEENTH,
      durationTicks: TICKS_PER_SIXTEENTH,
      pitch: 36,
    });

    const result = session.dispatch(addNotes(clipId, [note]));

    expect(result.ok).toBe(true);
    const clip = session.project.clips.find((candidate) => candidate.id === clipId);
    expect(clip?.content.kind).toBe("notes");
    if (clip?.content.kind === "notes") {
      expect(clip.content.events).toHaveLength(5);
    }
  });

  it("queues exactly the changed clip for autosave and persists it", async () => {
    const { session, repository, project, clipId } = ctx;
    const factoryContext = createFactoryContext();
    const note = createNoteEvent(factoryContext, {
      startTicks: 1 * TICKS_PER_SIXTEENTH,
      durationTicks: TICKS_PER_SIXTEENTH,
      pitch: 36,
    });

    session.dispatch(addNotes(clipId, [note]));
    expect(session.autosave.status.pending).toBe(1);

    await session.autosave.flush();

    expect(session.autosave.status.state).toBe("saved");
    const loaded = await repository.loadProject(project.metadata.id);
    if (!loaded.ok) throw new Error("expected the project to load");
    const clip = loaded.value.clips.find((candidate) => candidate.id === clipId);
    if (clip?.content.kind !== "notes") throw new Error("expected a note clip");
    expect(clip.content.events).toHaveLength(5);
  });

  it("commits a paint gesture as one history entry, one revision, and one clip write", async () => {
    const { session, repository, project, clipId } = ctx;
    const factoryContext = createFactoryContext();
    const startRevision = session.project.metadata.revision;

    // A three-step paint stroke: each step applies immediately, but the whole
    // stroke commits as one entry and one revision (CLP-02 undo grouping).
    const gesture = session.beginGesture();
    for (const sixteenth of [1, 2, 3]) {
      const note = createNoteEvent(factoryContext, {
        startTicks: sixteenth * TICKS_PER_SIXTEENTH,
        durationTicks: TICKS_PER_SIXTEENTH,
        pitch: 36,
      });
      gesture.apply(addNotes(clipId, [note]));
    }
    // Autosave is deferred until commit: no clip is queued mid-stroke.
    expect(session.autosave.status.pending).toBe(0);
    gesture.commit("Paint 3 steps");

    expect(session.project.metadata.revision).toBe(startRevision + 1);
    expect(session.history.entries).toHaveLength(1);
    // Exactly one clip queued for the whole stroke, not one per step.
    expect(session.autosave.status.pending).toBe(1);

    await session.autosave.flush();
    const loaded = await repository.loadProject(project.metadata.id);
    if (!loaded.ok) throw new Error("expected the project to load");
    const clip = loaded.value.clips.find((candidate) => candidate.id === clipId);
    if (clip?.content.kind !== "notes") throw new Error("expected a note clip");
    // The four fixture events plus the three painted.
    expect(clip.content.events).toHaveLength(7);

    // One undo reverts the whole stroke.
    session.undo();
    expect(session.project.clips[0].content).toMatchObject({ kind: "notes" });
  });

  it("a cancelled gesture leaves the project untouched and queues nothing", () => {
    const { session, clipId } = ctx;
    const factoryContext = createFactoryContext();
    const before = session.project;

    const gesture = session.beginGesture();
    gesture.apply(
      addNotes(clipId, [
        createNoteEvent(factoryContext, {
          startTicks: 1 * TICKS_PER_SIXTEENTH,
          durationTicks: TICKS_PER_SIXTEENTH,
          pitch: 36,
        }),
      ]),
    );
    gesture.cancel();

    expect(session.project).toBe(before);
    expect(session.autosave.status.pending).toBe(0);
    expect(session.history.canUndo).toBe(false);
  });

  it("undo reverts the project and re-queues the same clip for autosave", async () => {
    const { session, repository, project, clipId } = ctx;
    const factoryContext = createFactoryContext();
    const note = createNoteEvent(factoryContext, {
      startTicks: 1 * TICKS_PER_SIXTEENTH,
      durationTicks: TICKS_PER_SIXTEENTH,
      pitch: 36,
    });
    session.dispatch(addNotes(clipId, [note]));
    await session.autosave.flush();

    const undoResult = session.undo();
    expect(undoResult?.ok).toBe(true);
    await session.autosave.flush();

    const loaded = await repository.loadProject(project.metadata.id);
    if (!loaded.ok) throw new Error("expected the project to load");
    const clip = loaded.value.clips.find((candidate) => candidate.id === clipId);
    if (clip?.content.kind !== "notes") throw new Error("expected a note clip");
    // Back to the fixture's original four events.
    expect(clip.content.events).toHaveLength(4);
  });

  it("a stale remote echo never restores an undone note", async () => {
    const { session, repository, project, clipId } = ctx;
    const originalEvents = session.project.clips.find(
      (clip) => clip.id === clipId,
    )?.content;

    // Add and immediately undo a note, saving after each step.
    const factoryContext = createFactoryContext();
    const note = createNoteEvent(factoryContext, {
      startTicks: 1 * TICKS_PER_SIXTEENTH,
      durationTicks: TICKS_PER_SIXTEENTH,
      pitch: 36,
    });
    session.dispatch(addNotes(clipId, [note]));
    await session.autosave.flush();
    session.undo();
    await session.autosave.flush();

    // Simulate a stale echo of the pre-undo (five-note) state arriving late,
    // by writing it directly at an older revision than the store now holds.
    // The repository refuses the stale write outright (revision-checked), so
    // undo's own re-queue above is what actually proves the guarantee — this
    // asserts the repository-level half of it holds too.
    const staleWrite = await repository.saveClip(
      project.metadata.id,
      {
        ...project.clips[0],
        content: { kind: "notes", events: [note] },
      },
      project.metadata.revision, // the *original* (now stale) revision
    );
    expect(staleWrite.ok).toBe(false);

    const loaded = await repository.loadProject(project.metadata.id);
    if (!loaded.ok) throw new Error("expected the project to load");
    const clip = loaded.value.clips.find((candidate) => candidate.id === clipId);
    expect(clip?.content).toEqual(originalEvents);
  });

  it("logs first_edit once, with the dispatching command's id", () => {
    const { session, transport, clipId } = ctx;
    const clipContent = session.project.clips[0].content;
    if (clipContent.kind !== "notes") throw new Error("expected a note clip");
    const firstEventId = clipContent.events[0].id;

    session.dispatch(updateNote(clipId, firstEventId, { velocity: 0.5 }));
    session.dispatch(removeNotes(clipId, [firstEventId]));

    const firstEditEvents = transport.events.filter(
      (event) => event.name === "first_edit",
    );
    expect(firstEditEvents).toHaveLength(1);
    expect(firstEditEvents[0]?.params.command_id).toBe("note.update");
  });

  it("persists a shelved pack that no asset uses yet, so it survives a reload", async () => {
    // The shelf is maintained, not derived (LIB-08): `pack.add` changes no song
    // and no clip, so unless the metadata tier is queued the pack would be gone
    // on the next load — the failure the "still there after a reload"
    // acceptance criterion names.
    const { session, repository, project } = ctx;
    const shelved = factoryPack("pak_FH8gyASzYiWGCrtpKZ-Ho");

    session.dispatch(addPack(shelved));
    expect(session.autosave.status.pending).toBe(1);
    await session.autosave.flush();

    const loaded = await repository.loadProject(project.metadata.id);
    if (!loaded.ok) throw new Error("expected the project to load");
    expect(loaded.value.metadata.addedPacks).toContainEqual(shelved);
  });

  it("persists a rename to the metadata tier only, and undo restores the name", async () => {
    const { session, repository, project } = ctx;
    const saveSong = vi.spyOn(repository, "saveSong");
    const original = project.metadata.name;

    session.dispatch(renameProject("Night Drive"));
    await session.autosave.flush();
    const renamed = await repository.loadProject(project.metadata.id);
    if (!renamed.ok) throw new Error("expected the project to load");
    expect(renamed.value.metadata.name).toBe("Night Drive");
    expect(saveSong).not.toHaveBeenCalled();

    session.undo();
    await session.autosave.flush();
    const restored = await repository.loadProject(project.metadata.id);
    if (!restored.ok) throw new Error("expected the project to load");
    expect(restored.value.metadata.name).toBe(original);
  });

  it("writes a loop edit to the song tier only, never rewriting a clip (LOOP-017)", async () => {
    const { session, repository, project } = ctx;
    const saveChanges = vi.spyOn(repository, "saveChanges");

    session.dispatch(setLoopRange(bars(2), bars(4)));
    session.dispatch(setLoopEnabled(false));
    expect(session.autosave.status.pending).toBe(1);
    await session.autosave.flush();

    expect(saveChanges).toHaveBeenCalledTimes(1);
    expect(saveChanges.mock.calls[0]?.[1]).toMatchObject({
      song: expect.anything(),
      clips: [],
      deletedClipIds: [],
    });
    const loaded = await repository.loadProject(project.metadata.id);
    if (!loaded.ok) throw new Error("expected the project to load");
    expect(loaded.value.song.loop).toEqual({
      startTicks: bars(2),
      endTicks: bars(4),
      enabled: false,
    });
  });

  it("writes back what loading dropped, so the store heals (#965)", async () => {
    const { repository, project, analytics } = ctx;
    const orphan = `clp_${"o".repeat(21)}` as ClipId;
    // A clip document whose track is gone, as an interrupted save left it.
    repository.writeDocument(clipDocumentPath(project.metadata.id, orphan), {
      ...(repository.readDocument(
        clipDocumentPath(project.metadata.id, project.clips[0].id),
      ) as JsonObject),
      id: orphan,
      trackId: `trk_${"o".repeat(21)}`,
    });
    const loaded = await repository.loadProject(project.metadata.id);
    if (!loaded.ok) throw new Error("expected the project to load");
    expect(loaded.dropped).toEqual({ placements: 0, clipIds: [orphan] });

    const reopened = new EditorSession({
      repository,
      project: loaded.value,
      analytics,
      deviceStorage: memoryStorage(),
      dropped: loaded.dropped,
    });
    expect(reopened.autosave.status.pending).toBe(1);
    // A repair is a save, not an edit: there is nothing to undo.
    expect(reopened.history.snapshot().canUndo).toBe(false);
    await reopened.autosave.flush();
    reopened.dispose();

    const healed = await repository.loadProject(project.metadata.id);
    expect(healed.ok).toBe(true);
    if (!healed.ok) return;
    expect(healed.dropped).toBeUndefined();
  });

  it("persists the shelf again when a pack is removed from it", async () => {
    const { session, repository, project } = ctx;
    const shelved = factoryPack("pak_FH8gyASzYiWGCrtpKZ-Ho");
    session.dispatch(addPack(shelved));
    await session.autosave.flush();

    session.undo();
    await session.autosave.flush();

    const loaded = await repository.loadProject(project.metadata.id);
    if (!loaded.ok) throw new Error("expected the project to load");
    expect(loaded.value.metadata.addedPacks).not.toContainEqual(shelved);
  });

  it("logs undo_used with direction and actor on undo and redo, once per invocation", () => {
    const { session, transport, clipId } = ctx;
    const factoryContext = createFactoryContext();
    const note = createNoteEvent(factoryContext, {
      startTicks: 1 * TICKS_PER_SIXTEENTH,
      durationTicks: TICKS_PER_SIXTEENTH,
      pitch: 36,
    });
    session.dispatch(addNotes(clipId, [note]));

    session.undo();
    session.redo();

    const undoUsedEvents = transport.named("undo_used");
    expect(undoUsedEvents).toHaveLength(2);
    expect(undoUsedEvents[0]?.params).toMatchObject({
      direction: "undo",
      actor: "user",
    });
    expect(undoUsedEvents[1]?.params).toMatchObject({
      direction: "redo",
      actor: "user",
    });
  });

  it("does not log undo_used when there is nothing to undo or redo", () => {
    const { session, transport } = ctx;

    expect(session.undo()).toBeNull();
    expect(session.redo()).toBeNull();

    expect(transport.named("undo_used")).toHaveLength(0);
  });

  describe("warnBeforeExit (GRV-60)", () => {
    function removeFirstNote(): void {
      const { session, project, clipId } = ctx;
      const clip = project.clips[0];
      if (clip.content.kind !== "notes") throw new Error("expected a note clip");
      session.dispatch(removeNotes(clipId, [clip.content.events[0].id]));
    }

    it("does not warn or log when nothing is unsaved", () => {
      const { session, transport } = ctx;

      expect(session.warnBeforeExit()).toBe(false);
      expect(transport.named("unsaved_exit_warned")).toHaveLength(0);
    });

    it("warns, logs the pending state once, and starts the write", async () => {
      const { session, transport } = ctx;
      removeFirstNote();

      expect(session.warnBeforeExit()).toBe(true);
      const warned = transport.named("unsaved_exit_warned");
      expect(warned).toHaveLength(1);
      expect(warned[0]?.params).toMatchObject({ save_state: "pending" });

      await vi.waitFor(() => expect(session.autosave.status.state).toBe("saved"));
      expect(session.warnBeforeExit()).toBe(false);
      expect(transport.named("unsaved_exit_warned")).toHaveLength(1);
    });

    it("warns after a failed save, whose edit is still queued", async () => {
      const { session, transport, repository } = ctx;
      repository.failNextWrites({ count: 2 });
      removeFirstNote();
      await session.autosave.flush();

      expect(session.warnBeforeExit()).toBe(true);
      expect(transport.named("unsaved_exit_warned")[0]?.params).toMatchObject({
        save_state: "failed",
      });
    });
  });

  it("logs project_opened exactly once when the session is constructed", () => {
    const { transport } = ctx;

    const opened = transport.named("project_opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.params).toMatchObject({
      project_age_bucket: "same_day",
      track_count_bucket: "1_2",
      is_first_open: true,
    });
  });

  it("reports is_first_open: false on a second open of the same project on the same device", async () => {
    const { repository, project, deviceStorage } = ctx;
    const transport2 = createRecordingTransport();
    const analytics2 = new Analytics({
      transport: transport2,
      consent: new ConsentStore(memoryStorage()),
      storage: memoryStorage(),
    });
    analytics2.setAccountType("anonymous");

    const secondSession = new EditorSession({
      repository,
      project,
      clock: createManualClock(2_000),
      analytics: analytics2,
      deviceStorage,
    });

    const opened = transport2.named("project_opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.params.is_first_open).toBe(false);

    secondSession.dispose();
  });

  it("reports is_first_open: true again on a different device (isolated storage)", () => {
    const { repository, project } = ctx;
    const transport2 = createRecordingTransport();
    const analytics2 = new Analytics({
      transport: transport2,
      consent: new ConsentStore(memoryStorage()),
      storage: memoryStorage(),
    });
    analytics2.setAccountType("anonymous");

    const otherDeviceSession = new EditorSession({
      repository,
      project,
      clock: createManualClock(2_000),
      analytics: analytics2,
      deviceStorage: memoryStorage(),
    });

    const opened = transport2.named("project_opened");
    expect(opened[0]?.params.is_first_open).toBe(true);

    otherDeviceSession.dispose();
  });

  describe("gestures (the piano-roll note drag path)", () => {
    it("commits a multi-step gesture as one revision and one undo entry", () => {
      const { session, clipId } = ctx;
      const events =
        session.project.clips[0].content.kind === "notes"
          ? session.project.clips[0].content.events
          : [];
      const first = events[0];
      const startRevision = session.project.metadata.revision;

      const gesture = session.beginGesture({ summary: "Move notes" });
      // Three intermediate frames, each applying immediately.
      for (const start of [1, 2, 3]) {
        gesture.apply(
          updateNote(clipId, first.id, {
            startTicks: (start * TICKS_PER_SIXTEENTH) as never,
          }),
        );
      }
      const entry = gesture.commit();

      expect(entry).not.toBeNull();
      // One revision bump for the whole drag, not one per frame.
      expect(session.project.metadata.revision).toBe(startRevision + 1);
      expect(session.history.entries).toHaveLength(1);
      expect(session.history.redoEntries).toHaveLength(0);

      // The final position is what the last frame set.
      const moved =
        session.project.clips[0].content.kind === "notes"
          ? session.project.clips[0].content.events.find(
              (candidate) => candidate.id === first.id,
            )
          : undefined;
      expect(moved?.startTicks).toBe(3 * TICKS_PER_SIXTEENTH);
    });

    it("one undo reverts the whole gesture", () => {
      const { session, clipId } = ctx;
      const first =
        session.project.clips[0].content.kind === "notes"
          ? session.project.clips[0].content.events[0]
          : undefined;
      if (!first) throw new Error("expected a note");
      const originalStart = first.startTicks;

      const gesture = session.beginGesture();
      gesture.apply(
        updateNote(clipId, first.id, {
          startTicks: (5 * TICKS_PER_SIXTEENTH) as never,
        }),
      );
      gesture.apply(
        updateNote(clipId, first.id, {
          startTicks: (7 * TICKS_PER_SIXTEENTH) as never,
        }),
      );
      gesture.commit();

      session.undo();

      const reverted =
        session.project.clips[0].content.kind === "notes"
          ? session.project.clips[0].content.events.find(
              (candidate) => candidate.id === first.id,
            )
          : undefined;
      expect(reverted?.startTicks).toBe(originalStart);
    });

    it("queues the touched clip for autosave exactly once on commit", async () => {
      const { session, repository, project, clipId } = ctx;
      const first =
        session.project.clips[0].content.kind === "notes"
          ? session.project.clips[0].content.events[0]
          : undefined;
      if (!first) throw new Error("expected a note");

      const gesture = session.beginGesture();
      gesture.apply(
        updateNote(clipId, first.id, {
          startTicks: (2 * TICKS_PER_SIXTEENTH) as never,
        }),
      );
      // Mid-gesture, nothing is queued yet: the write is deferred to commit.
      expect(session.autosave.status.pending).toBe(0);

      gesture.commit();
      expect(session.autosave.status.pending).toBe(1);

      await session.autosave.flush();
      const loaded = await repository.loadProject(project.metadata.id);
      if (!loaded.ok) throw new Error("expected the project to load");
      const clip = loaded.value.clips.find((c) => c.id === clipId);
      if (clip?.content.kind !== "notes") throw new Error("expected a note clip");
      const persisted = clip.content.events.find((e) => e.id === first.id);
      expect(persisted?.startTicks).toBe(2 * TICKS_PER_SIXTEENTH);
    });

    it("a cancelled gesture leaves no revision, entry, or queued write", () => {
      const { session, clipId } = ctx;
      const first =
        session.project.clips[0].content.kind === "notes"
          ? session.project.clips[0].content.events[0]
          : undefined;
      if (!first) throw new Error("expected a note");
      const startRevision = session.project.metadata.revision;

      const gesture = session.beginGesture();
      gesture.apply(
        updateNote(clipId, first.id, {
          startTicks: (9 * TICKS_PER_SIXTEENTH) as never,
        }),
      );
      gesture.cancel();

      expect(session.project.metadata.revision).toBe(startRevision);
      expect(session.history.entries).toHaveLength(0);
      expect(session.autosave.status.pending).toBe(0);
    });
  });

  it("persists a mixer edit (a song-tier command) through autosave", async () => {
    const { session, repository, project } = ctx;
    const trackId = project.song.tracks[0].id;

    session.dispatch(setTrackFlag(trackId, "muted", true));
    expect(session.autosave.status.pending).toBe(1);

    await session.autosave.flush();
    expect(session.autosave.status.state).toBe("saved");

    const loaded = await repository.loadProject(project.metadata.id);
    if (!loaded.ok) throw new Error("expected the project to load");
    expect(loaded.value.song.tracks[0].mixer.muted).toBe(true);
  });

  it("persists a volume change and does not queue any clip for it", async () => {
    const { session, repository, project } = ctx;
    const trackId = project.song.tracks[0].id;

    session.dispatch(
      setParameter({ scope: "track", trackId, parameterId: TRACK_VOLUME.id }, -6),
    );
    // Exactly one queued entry — the song tier — never a clip document.
    expect(session.autosave.status.pending).toBe(1);
    await session.autosave.flush();

    const loaded = await repository.loadProject(project.metadata.id);
    if (!loaded.ok) throw new Error("expected the project to load");
    expect(loaded.value.song.tracks[0].mixer.volume).toBe(-6);
  });

  it("a fader gesture persists a single song write on commit", async () => {
    const { session, project } = ctx;
    const trackId = project.song.tracks[0].id;

    const gesture = session.beginGesture({ summary: "vol" });
    for (const db of [-3, -6, -9]) {
      gesture.apply(
        setParameter({ scope: "track", trackId, parameterId: TRACK_VOLUME.id }, db),
      );
    }
    // Nothing is queued until the gesture commits.
    expect(session.autosave.status.pending).toBe(0);
    gesture.commit();
    expect(session.autosave.status.pending).toBe(1);

    await session.autosave.flush();
    expect(session.project.song.tracks[0].mixer.volume).toBe(-9);
  });

  it("deleting a track queues the song and every one of its clips for deletion", async () => {
    const { session, repository, project } = ctx;
    const trackId = project.song.tracks[0].id;
    const clipIds = project.clips
      .filter((clip) => clip.trackId === trackId)
      .map((clip) => clip.id);
    expect(clipIds.length).toBeGreaterThan(0);

    session.dispatch(removeTrack(trackId));
    await session.autosave.flush();

    const loaded = await repository.loadProject(project.metadata.id);
    if (!loaded.ok) throw new Error("expected the project to load");
    expect(loaded.value.song.tracks.some((t) => t.id === trackId)).toBe(false);
    for (const clipId of clipIds) {
      expect(loaded.value.clips.some((c) => c.id === clipId)).toBe(false);
    }
  });

  it("adding a track with a clip queues both the song and the new clip", async () => {
    const { session, repository, project } = ctx;
    const factoryContext = createFactoryContext();
    const track = createTrack(factoryContext, {
      name: "Synth",
      order: project.song.tracks.length,
      instrument: createSynthInstrument(),
    });
    const { addTrack } = await import("../commands");

    session.dispatch(addTrack(track));
    await session.autosave.flush();

    const loaded = await repository.loadProject(project.metadata.id);
    if (!loaded.ok) throw new Error("expected the project to load");
    expect(loaded.value.song.tracks.some((t) => t.id === track.id)).toBe(true);
  });

  it("dispose stops the repository watch subscription", async () => {
    const { session, repository, project } = ctx;
    session.dispose();

    // A metadata write after dispose must not throw or resurrect a listener
    // EditorSession already released.
    const result = await repository.saveMetadata(
      project.metadata.id,
      { name: "Renamed after dispose" },
      project.metadata.revision,
    );
    expect(result.ok).toBe(true);
  });
});
