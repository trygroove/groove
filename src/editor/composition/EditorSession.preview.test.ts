import { beforeEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import {
  addNotes,
  type RawCommandInput,
  renameProject,
  setParameter,
} from "../../commands";
import type { Project } from "../../domain/entities";
import { createFactoryContext, createNoteEvent } from "../../domain/factories";
import { createSliceFixtureProject } from "../../domain/fixtures";
import type { ClipId } from "../../domain/ids";
import { TRACK_VOLUME } from "../../domain/parameters";
import { stringifyProject } from "../../domain/serialize";
import { TICKS_PER_SIXTEENTH } from "../../domain/time";
import { createInMemoryProjectRepository } from "../../persistence/inMemoryProjectRepository";
import type { ProjectRepository } from "../../persistence/projectRepository";
import { createManualClock } from "../../shared/clock";
import { memoryStorage } from "../../testing/storage";
import { EditorSession, type EditorSessionSnapshot } from "./EditorSession";

/** Every repository method a session could write or read through. */
const REPOSITORY_METHODS = [
  "createProject",
  "loadProject",
  "listProjects",
  "loadProjectMetadata",
  "saveMetadata",
  "saveSong",
  "saveClip",
  "deleteClip",
  "deleteProject",
  "watchProject",
] as const satisfies readonly (keyof ProjectRepository)[];

async function setUp() {
  const repository = createInMemoryProjectRepository();
  const project = createSliceFixtureProject();
  const created = await repository.createProject(project);
  if (!created.ok) throw new Error("fixture project failed to create");
  repository.clearWrites();

  const analytics = new Analytics({
    transport: createRecordingTransport(),
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  analytics.setAccountType("anonymous");

  const session = new EditorSession({
    repository,
    project,
    clock: createManualClock(1_000),
    analytics,
    deviceStorage: memoryStorage(),
  });
  const snapshots: EditorSessionSnapshot[] = [];
  session.subscribe((snapshot) => snapshots.push(snapshot));
  const clipId = project.clips[0].id as ClipId;
  const trackId = project.song.tracks[0].id;
  return { repository, project, session, snapshots, clipId, trackId };
}

function aNote(sixteenth: number) {
  return createNoteEvent(createFactoryContext(), {
    startTicks: sixteenth * TICKS_PER_SIXTEENTH,
    durationTicks: TICKS_PER_SIXTEENTH,
    pitch: 36,
  });
}

function noteCount(project: Project, clipId: ClipId): number {
  const clip = project.clips.find((candidate) => candidate.id === clipId);
  if (clip?.content.kind !== "notes") throw new Error("expected a note clip");
  return clip.content.events.length;
}

function openPreview(session: EditorSession, commands: RawCommandInput[]) {
  const result = session.beginPreview(commands);
  if (!result.ok) throw new Error(`preview refused: ${result.issues[0]?.message}`);
  return result.preview;
}

describe("EditorSession preview (UI-005)", () => {
  let ctx: Awaited<ReturnType<typeof setUp>>;

  beforeEach(async () => {
    ctx = await setUp();
  });

  it("shows the previewed project without a revision, history entry, autosave or repository call", async () => {
    const { session, repository, project, snapshots, clipId } = ctx;
    const calls = REPOSITORY_METHODS.map((method) => vi.spyOn(repository, method));

    const preview = openPreview(session, [addNotes(clipId, [aNote(1)])]);

    // What the editor shows is the previewed project...
    expect(preview.status).toBe("open");
    expect(session.project).toBe(preview.project);
    expect(noteCount(session.project, clipId)).toBe(5);
    const last = snapshots.at(-1);
    expect(last?.previewing).toBe(true);
    expect(last?.project).toBe(preview.project);
    // ...and what is committed is exactly what was there before.
    expect(session.committedProject).toBe(project);
    expect(last?.committedProject).toBe(project);
    expect(session.project.metadata.revision).toBe(project.metadata.revision);
    expect(session.history.entries).toHaveLength(0);
    expect(session.autosave.status.pending).toBe(0);

    await session.autosave.flush();
    for (const call of calls) expect(call).not.toHaveBeenCalled();
    expect(repository.writes).toHaveLength(0);
  });

  it("cancel restores the committed project object itself", () => {
    const { session, project, snapshots, clipId } = ctx;
    const preview = openPreview(session, [addNotes(clipId, [aNote(1)])]);

    preview.cancel();

    expect(preview.status).toBe("cancelled");
    expect(preview.endReason).toBe("cancelled");
    expect(session.project).toBe(project);
    expect(snapshots.at(-1)?.project).toBe(project);
    expect(snapshots.at(-1)?.previewing).toBe(false);
    expect(session.activePreview).toBeNull();
    // A second cancel is a no-op, not a second notification.
    const count = snapshots.length;
    preview.cancel();
    expect(snapshots.length).toBe(count);
  });

  it("commit makes one history entry and one revision, with the given actor, and one undo restores the song", async () => {
    const { session, repository, project, clipId, trackId } = ctx;
    const before = stringifyProject(project);
    const preview = openPreview(session, [
      addNotes(clipId, [aNote(1), aNote(2)]),
      setParameter({ scope: "track", trackId, parameterId: TRACK_VOLUME.id }, -12),
    ]);

    const result = preview.commit("assistant");

    expect(result?.ok).toBe(true);
    expect(preview.status).toBe("committed");
    expect(preview.endReason).toBe("committed");
    expect(session.history.entries).toHaveLength(1);
    expect(session.history.entries[0].actor).toBe("assistant");
    expect(session.project.metadata.revision).toBe(project.metadata.revision + 1);
    expect(session.project).toBe(session.committedProject);
    expect(noteCount(session.project, clipId)).toBe(6);
    // The commit autosaves like any dispatch: the song (volume) and the clip.
    expect(session.autosave.status.pending).toBe(2);
    await session.autosave.flush();
    expect(repository.writes.length).toBeGreaterThan(0);

    session.undo();
    const undone = JSON.parse(stringifyProject(session.project));
    const original = JSON.parse(before);
    // Revision and modifiedAt move on; the canonical song state does not.
    expect(undone.song).toEqual(original.song);
    expect(undone.clips).toEqual(original.clips);
    expect(JSON.stringify(undone.song)).toBe(JSON.stringify(original.song));
    expect(JSON.stringify(undone.clips)).toBe(JSON.stringify(original.clips));
  });

  it("a local edit goes to the committed project and makes the preview stale", () => {
    const { session, project, snapshots, clipId } = ctx;
    const preview = openPreview(session, [addNotes(clipId, [aNote(1)])]);

    const edit = session.dispatch(renameProject("Edited under a preview"));

    expect(edit.ok).toBe(true);
    expect(preview.status).toBe("stale");
    expect(preview.endReason).toBe("local_edit");
    expect(session.project).toBe(session.committedProject);
    expect(session.project.metadata.name).toBe("Edited under a preview");
    // Not edited into the preview: the previewed note is gone.
    expect(noteCount(session.project, clipId)).toBe(noteCount(project, clipId));
    // No listener ever saw the preview over the moved committed project.
    for (const snapshot of snapshots) {
      if (snapshot.previewing) expect(snapshot.committedProject).toBe(project);
    }
    // Apply is never offered on a stale preview.
    expect(preview.commit("assistant")).toBeNull();
    expect(session.history.entries).toHaveLength(1);
  });

  it("a gesture step is a local edit too", () => {
    const { session, clipId } = ctx;
    const preview = openPreview(session, [addNotes(clipId, [aNote(1)])]);

    const gesture = session.beginGesture();
    // Opening the gesture changes nothing yet.
    expect(preview.status).toBe("open");
    gesture.apply(addNotes(clipId, [aNote(3)]));
    gesture.commit();

    expect(preview.status).toBe("stale");
    expect(preview.endReason).toBe("local_edit");
  });

  it("an invalid edit while previewing leaves the preview open", () => {
    const { session, clipId } = ctx;
    const preview = openPreview(session, [addNotes(clipId, [aNote(1)])]);

    const edit = session.dispatch(addNotes("clp_missing" as ClipId, [aNote(2)]));

    expect(edit.ok).toBe(false);
    expect(preview.status).toBe("open");
    expect(session.project).toBe(preview.project);
  });

  it("a remote change makes the preview stale", async () => {
    const { session, repository, project, clipId } = ctx;
    const preview = openPreview(session, [addNotes(clipId, [aNote(1)])]);

    // Another client renames the project, which moves the revision.
    const remote = await repository.saveMetadata(
      project.metadata.id,
      { name: "Renamed elsewhere" },
      project.metadata.revision,
    );
    expect(remote.ok).toBe(true);

    await vi.waitFor(() => expect(preview.status).toBe("stale"));
    expect(preview.endReason).toBe("remote_change");
    // The session shows the project as it was saved elsewhere, never the preview.
    expect(session.project.metadata.name).toBe("Renamed elsewhere");
    expect(noteCount(session.project, clipId)).toBe(noteCount(project, clipId));
    expect(preview.commit("assistant")).toBeNull();
  });

  it("an echo at the committed revision leaves the preview open", async () => {
    const { session, clipId } = ctx;
    const preview = openPreview(session, [addNotes(clipId, [aNote(1)])]);
    session.autosave.applyRemote({
      kind: "metadata",
      metadata: session.committedProject.metadata,
    });
    expect(preview.status).toBe("open");
  });

  it("undo cancels the preview first, then undoes the committed history", () => {
    const { session, project, clipId } = ctx;
    session.dispatch(renameProject("Committed"));
    const preview = openPreview(session, [addNotes(clipId, [aNote(1)])]);

    const result = session.undo();

    expect(preview.status).toBe("stale");
    expect(preview.endReason).toBe("undo");
    expect(result?.ok).toBe(true);
    expect(session.project.metadata.name).toBe(project.metadata.name);
    expect(noteCount(session.project, clipId)).toBe(noteCount(project, clipId));
  });

  it("redo cancels the preview first, then redoes the committed history", () => {
    const { session, clipId } = ctx;
    session.dispatch(renameProject("Committed"));
    session.undo();
    const preview = openPreview(session, [addNotes(clipId, [aNote(1)])]);

    const result = session.redo();

    expect(preview.status).toBe("stale");
    expect(preview.endReason).toBe("redo");
    expect(result?.ok).toBe(true);
    expect(session.project.metadata.name).toBe("Committed");
  });

  it("invalid commands return the issues a dispatch would and change nothing", () => {
    const { session, project, snapshots } = ctx;
    const invalid = addNotes("clp_missing" as ClipId, [aNote(1)]);

    const result = session.beginPreview([invalid]);
    const dispatched = new EditorSession({
      repository: createInMemoryProjectRepository(),
      project,
      deviceStorage: memoryStorage(),
    }).dispatch([invalid]);

    expect(result.ok).toBe(false);
    if (result.ok || dispatched.ok) throw new Error("expected both to fail");
    expect(result.issues).toEqual(dispatched.issues);
    expect(result.project).toBe(project);
    expect(session.project).toBe(project);
    expect(session.activePreview).toBeNull();
    expect(snapshots).toHaveLength(0);
  });

  it("an invalid second preview leaves the first one open", () => {
    const { session, clipId } = ctx;
    const first = openPreview(session, [addNotes(clipId, [aNote(1)])]);

    const second = session.beginPreview([addNotes("clp_missing" as ClipId, [aNote(2)])]);

    expect(second.ok).toBe(false);
    expect(first.status).toBe("open");
    expect(session.project).toBe(first.project);
  });

  it("starting another preview cancels the first", () => {
    const { session, clipId } = ctx;
    const first = openPreview(session, [addNotes(clipId, [aNote(1)])]);
    const second = openPreview(session, [addNotes(clipId, [aNote(2), aNote(3)])]);

    expect(first.status).toBe("cancelled");
    expect(first.endReason).toBe("superseded");
    expect(first.commit("assistant")).toBeNull();
    expect(second.status).toBe("open");
    expect(session.activePreview).toBe(second);
    expect(noteCount(session.project, clipId)).toBe(6);
  });

  it("disposing the session cancels an open preview", () => {
    const { session, clipId } = ctx;
    const preview = openPreview(session, [addNotes(clipId, [aNote(1)])]);

    session.dispose();

    expect(preview.status).toBe("cancelled");
    expect(preview.endReason).toBe("disposed");
  });
  it("is refused while a gesture is open, so nothing can join the gesture", () => {
    const { session, project, clipId, trackId } = ctx;
    const gesture = session.beginGesture();
    gesture.apply(
      setParameter({ scope: "track", trackId, parameterId: TRACK_VOLUME.id }, -6),
    );
    const committed = session.committedProject;

    const result = session.beginPreview([addNotes(clipId, [aNote(1)])]);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.issues[0]?.code).toBe("rejected");
    expect(session.activePreview).toBeNull();
    expect(session.committedProject).toBe(committed);
    gesture.commit();
    expect(session.history.entries).toHaveLength(1);
    expect(session.history.entries[0].actor).toBe("user");
    expect(noteCount(session.project, clipId)).toBe(noteCount(project, clipId));
  });

  it("commit while a gesture is open is refused without applying, and the preview stays open", () => {
    const { session, project, clipId } = ctx;
    const preview = openPreview(session, [addNotes(clipId, [aNote(1)])]);
    const gesture = session.beginGesture();

    const refused = preview.commit("assistant");

    expect(refused?.ok).toBe(false);
    if (!refused || refused.ok) throw new Error("expected a refusal");
    expect(refused.issues[0]?.code).toBe("rejected");
    expect(preview.status).toBe("open");
    expect(session.committedProject).toBe(project);
    expect(session.history.entries).toHaveLength(0);

    // The gesture is abandoned: the preview is still valid and now commits
    // as its own entry, under its own actor.
    gesture.cancel();
    const result = preview.commit("assistant");
    expect(result?.ok).toBe(true);
    expect(session.history.entries).toHaveLength(1);
    expect(session.history.entries[0].actor).toBe("assistant");
    expect(noteCount(session.project, clipId)).toBe(noteCount(project, clipId) + 1);
  });

  it("a gesture step after the preview opened makes it stale, so it never folds into the gesture", () => {
    const { session, project, clipId, trackId } = ctx;
    const preview = openPreview(session, [addNotes(clipId, [aNote(1)])]);
    const gesture = session.beginGesture();
    gesture.apply(
      setParameter({ scope: "track", trackId, parameterId: TRACK_VOLUME.id }, -6),
    );

    expect(preview.status).toBe("stale");
    expect(preview.commit("assistant")).toBeNull();
    gesture.commit();

    expect(session.history.entries).toHaveLength(1);
    expect(session.history.entries[0].actor).toBe("user");
    expect(noteCount(session.project, clipId)).toBe(noteCount(project, clipId));
  });

  it("an undo or redo refused mid-gesture leaves the preview open", () => {
    const { session, clipId } = ctx;
    session.dispatch(renameProject("Committed"));
    const preview = openPreview(session, [addNotes(clipId, [aNote(1)])]);
    const gesture = session.beginGesture();

    expect(() => session.undo()).toThrow();
    expect(() => session.redo()).toThrow();

    expect(preview.status).toBe("open");
    gesture.cancel();
  });

  it("a disposed session opens no preview", () => {
    const { session, clipId } = ctx;
    session.dispose();

    const result = session.beginPreview([addNotes(clipId, [aNote(1)])]);

    expect(result.ok).toBe(false);
    expect(session.activePreview).toBeNull();
  });

  it("a commit the history refuses ends the preview as commit_failed and changes nothing", () => {
    const { session, project, snapshots, clipId } = ctx;
    const preview = openPreview(session, [addNotes(clipId, [aNote(1)])]);
    vi.spyOn(session.history, "execute").mockReturnValueOnce({
      ok: false,
      project,
      issues: [
        {
          code: "revision_conflict",
          commandType: "note.add",
          commandIndex: 0,
          message: "moved on",
        },
      ],
    });

    const result = preview.commit("assistant");

    expect(result?.ok).toBe(false);
    expect(preview.status).toBe("cancelled");
    expect(preview.endReason).toBe("commit_failed");
    expect(session.activePreview).toBeNull();
    expect(session.project).toBe(project);
    expect(snapshots.at(-1)?.previewing).toBe(false);
    expect(session.history.entries).toHaveLength(0);
    expect(session.autosave.status.pending).toBe(0);
  });
});
