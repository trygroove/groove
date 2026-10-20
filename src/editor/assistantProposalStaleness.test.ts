import { describe, expect, it } from "vitest";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import { createRecordingTransport } from "../analytics/transport";
import { createProposalExecutor } from "../assistant/proposalExecutor";
import { toolNameFor } from "../assistant/tools";
import {
  type RawCommandInput,
  setLoopEnabled,
  setLoopRange,
  setTrackFlag,
} from "../commands";
import { createSliceFixtureProject } from "../domain/fixtures";
import { barsToTicks } from "../domain/time";
import { createInMemoryProjectRepository } from "../persistence/inMemoryProjectRepository";
import { createManualClock } from "../shared/clock";
import { memoryStorage } from "../testing/storage";
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
  const analytics = new Analytics({
    transport: createRecordingTransport(),
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
  const track = project.song.tracks[0];
  const propose = (base = session.committedProject.metadata.revision) => {
    const proposed = executor.propose({
      baseRevision: base,
      calls: [call(setTrackFlag(track.id, "muted", !track.mixer.muted))],
    });
    return proposed;
  };
  return { session, track, propose };
}

describe("a proposal and edits that do not touch what it changes (GRV-132)", () => {
  it("stays pending and applies after the loop is toggled or moved", async () => {
    const { session, track, propose } = await setUp();
    const proposed = propose();
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.issues));

    session.dispatch(setLoopEnabled(!session.committedProject.song.loop.enabled));
    session.dispatch(setLoopRange(barsToTicks(0), barsToTicks(2)));
    expect(proposed.handle.isStale).toBe(false);

    const applied = proposed.handle.apply();
    expect(applied.ok).toBe(true);
    expect(session.committedProject.song.tracks[0].mixer.muted).toBe(!track.mixer.muted);
  });

  it("accepts a proposal built before a loop edit that landed during its turn", async () => {
    const { session, propose } = await setUp();
    const base = session.committedProject.metadata.revision;
    session.dispatch(setLoopEnabled(!session.committedProject.song.loop.enabled));
    const proposed = propose(base);
    expect(proposed.ok).toBe(true);
  });

  it("goes stale after an edit that could conflict, and cannot apply", async () => {
    const { session, track, propose } = await setUp();
    const proposed = propose();
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.issues));

    session.dispatch(setTrackFlag(track.id, "soloed", true));
    expect(proposed.handle.isStale).toBe(true);
    const applied = proposed.handle.apply();
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.reason).toBe("stale");
  });

  it("goes stale when a loop edit follows a change it cannot account for", async () => {
    const { session, track, propose } = await setUp();
    const proposed = propose();
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.issues));
    session.dispatch(setTrackFlag(track.id, "soloed", true));
    session.dispatch(setLoopEnabled(!session.committedProject.song.loop.enabled));
    expect(proposed.handle.isStale).toBe(true);
  });
});
