import { describe, expect, it } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { createProposalExecutor } from "../../assistant/proposalExecutor";
import { toolNameFor } from "../../assistant/tools";
import { type RawCommandInput, setParameter, setTrackFlag } from "../../commands";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { TRACK_VOLUME } from "../../domain/parameters";
import { createInMemoryProjectRepository } from "../../persistence/inMemoryProjectRepository";
import { createManualClock } from "../../shared/clock";
import { memoryStorage } from "../../testing/storage";
import { assistantProposalTarget } from "./assistantProposalTarget";
import { EditorSession } from "./EditorSession";

function call(command: RawCommandInput) {
  return { name: toolNameFor(command.type), input: command.payload };
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
  const clock = createManualClock(1_000);
  const session = new EditorSession({
    repository,
    project,
    clock,
    analytics,
    deviceStorage: memoryStorage(),
  });
  const executor = createProposalExecutor({
    target: assistantProposalTarget(session),
    analytics,
    clock,
  });
  return { repository, project, session, executor, transport };
}

async function loadTrack(
  repository: ReturnType<typeof createInMemoryProjectRepository>,
  project: ReturnType<typeof createSliceFixtureProject>,
) {
  const loaded = await repository.loadProject(project.metadata.id);
  if (!loaded.ok) throw new Error("expected the project to load");
  return { revision: loaded.value.metadata.revision, track: loaded.value.song.tracks[0] };
}

describe("the editor session as the assistant's proposal target", () => {
  it("autosaves an applied proposal, and its undo", async () => {
    const { repository, project, session, executor, transport } = await setUp();
    const track = project.song.tracks[0];
    const proposed = executor.propose({
      baseRevision: project.metadata.revision,
      calls: [
        call(
          setParameter(
            { scope: "track", trackId: track.id, parameterId: TRACK_VOLUME.id },
            -12,
          ),
        ),
        call(setTrackFlag(track.id, "muted", !track.mixer.muted)),
      ],
    });
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.issues));

    expect(proposed.handle.apply().ok).toBe(true);
    expect(session.autosave.status.pending).toBeGreaterThan(0);
    await session.autosave.flush();
    const applied = await loadTrack(repository, project);
    expect(applied.revision).toBe(project.metadata.revision + 1);
    expect(applied.track.mixer.volume).toBe(-12);
    expect(applied.track.mixer.muted).toBe(!track.mixer.muted);
    expect(transport.named("first_edit")).toHaveLength(1);

    expect(proposed.handle.undo().ok).toBe(true);
    expect(session.autosave.status.pending).toBeGreaterThan(0);
    await session.autosave.flush();
    const undone = await loadTrack(repository, project);
    expect(undone.revision).toBe(project.metadata.revision + 2);
    expect(undone.track.mixer).toEqual(track.mixer);
    expect(transport.named("assistant_proposal_undone")).toHaveLength(1);
  });

  it("validates against the committed project, not an open preview", async () => {
    const { project, session, executor } = await setUp();
    const track = project.song.tracks[0];
    const preview = session.beginPreview(setTrackFlag(track.id, "soloed", true));
    expect(preview.ok).toBe(true);
    const proposed = executor.propose({
      baseRevision: project.metadata.revision,
      calls: [call(setTrackFlag(track.id, "muted", true))],
    });
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.issues));
    expect(proposed.handle.apply().ok).toBe(true);
    // The commit moved the project under the preview, which ends it.
    expect(session.activePreview).toBeNull();
    expect(session.committedProject.song.tracks[0].mixer.muted).toBe(true);
    expect(session.committedProject.song.tracks[0].mixer.soloed).toBe(track.mixer.soloed);
  });
});
