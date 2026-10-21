import { afterEach, describe, expect, it } from "vitest";
import { setParameter } from "../../commands";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { SONG_TEMPO } from "../../domain/parameters";
import { createInMemoryProjectRepository } from "../../persistence/inMemoryProjectRepository";
import { type ProjectRepository, saveFailure } from "../../persistence/projectRepository";
import { createManualClock } from "../../shared/clock";
import { createManualScheduler } from "../../shared/scheduler";
import { memoryStorage } from "../../testing/storage";
import { EditorSession } from "./EditorSession";
import { SAVE_RETRY_DELAYS_MS, saveRetryDelay } from "./saveRetry";

/**
 * A save the connection dropped is written again by itself (GRV-55 QA): the
 * browser's `online` event cannot be relied on to come, so nothing waits for
 * it or for Retry.
 */

const sessions: EditorSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

const tempo = (bpm: number) =>
  setParameter({ scope: "song", parameterId: SONG_TEMPO.id }, bpm);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setUp(
  wrap: (repository: ProjectRepository) => ProjectRepository = (r) => r,
) {
  const repository = createInMemoryProjectRepository();
  const project = createSliceFixtureProject();
  const created = await repository.createProject(project);
  if (!created.ok) throw new Error("fixture project failed to create");
  const scheduler = createManualScheduler();
  const session = new EditorSession({
    repository: wrap(repository),
    project,
    clock: createManualClock(1_000),
    deviceStorage: memoryStorage(),
    scheduler,
    coalesceMs: 400,
  });
  sessions.push(session);
  return { repository, scheduler, session };
}

describe("retrying a save the connection dropped (GRV-55)", () => {
  it("writes the queued edit once the connection is back, with no online event or Retry", async () => {
    const { repository, scheduler, session } = await setUp();
    repository.failNextWrites({ count: 3 });
    session.dispatch(tempo(125));
    await session.autosave.flush();
    expect(session.autosave.status.state).toBe("failed");

    // Still offline: each retry fails and the next waits longer.
    for (const delay of SAVE_RETRY_DELAYS_MS.slice(0, 2)) {
      scheduler.advance(delay - 1);
      await settle();
      expect(session.autosave.status.state).toBe("failed");
      scheduler.advance(1);
      await settle();
      expect(session.autosave.status.state).toBe("failed");
    }

    // Back online: the next retry lands it.
    scheduler.advance(SAVE_RETRY_DELAYS_MS[2]);
    await settle();
    expect(session.autosave.status.state).toBe("saved");
    expect(session.autosave.status.pending).toBe(0);
    expect(scheduler.pending).toBe(0);
  });

  it("keeps the edits made while it was failing, and writes them all", async () => {
    const { repository, scheduler, session } = await setUp();
    repository.failNextWrites({ count: 2 });
    session.dispatch(tempo(125));
    await session.autosave.flush();
    session.dispatch(tempo(127));
    scheduler.advance(400);
    await settle();
    expect(session.autosave.status.state).toBe("failed");

    scheduler.advance(saveRetryDelay(1));
    await settle();

    expect(session.autosave.status.state).toBe("saved");
    const loaded = await repository.loadProject(session.project.metadata.id);
    if (!loaded.ok) throw new Error("project failed to load");
    expect(loaded.value.song.tempo).toBe(127);
  });

  it("does not retry a failure no retry can clear", async () => {
    let writes = 0;
    const { scheduler, session } = await setUp((repository) => {
      const tooLarge: ProjectRepository = Object.create(repository);
      tooLarge.saveChanges = async () => {
        writes += 1;
        return saveFailure("document_too_large", "Injected persistence failure");
      };
      return tooLarge;
    });
    session.dispatch(tempo(128));
    await session.autosave.flush();
    expect(writes).toBe(1);

    scheduler.advance(60_000);
    await settle();

    expect(writes).toBe(1);
    expect(scheduler.pending).toBe(0);
  });

  it("stops retrying when the session closes and its edits are dropped", async () => {
    const { repository, scheduler, session } = await setUp();
    repository.failNextWrites({ count: 1 });
    session.dispatch(tempo(125));
    await session.autosave.flush();
    expect(scheduler.pending).toBe(1);

    session.dispose();

    expect(scheduler.pending).toBe(0);
  });

  it("backs off to a ceiling", () => {
    expect(saveRetryDelay(0)).toBe(SAVE_RETRY_DELAYS_MS[0]);
    expect(saveRetryDelay(99)).toBe(SAVE_RETRY_DELAYS_MS.at(-1));
  });
});
