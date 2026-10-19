import { afterEach, describe, expect, it } from "vitest";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import { createRecordingTransport } from "../analytics/transport";
import { setParameter } from "../commands";
import type { Project } from "../domain/entities";
import { createSliceFixtureProject } from "../domain/fixtures";
import { SONG_TEMPO } from "../domain/parameters";
import { createInMemoryProjectRepository } from "../persistence/inMemoryProjectRepository";
import { type ProjectRepository, saveFailure } from "../persistence/projectRepository";
import { createManualClock } from "../shared/clock";
import { expectNoContent, recordErrorReports } from "../testing/errorReports";
import { memoryStorage } from "../testing/storage";
import { EditorSession } from "./EditorSession";

/**
 * A failed save, as monitoring and analytics see it (GRV-55): one Sentry
 * event per failure with the failure's stable code and whether the browser
 * was online, and none of the project's content.
 */

const sessions: EditorSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

const tempo = (bpm: number) =>
  setParameter({ scope: "song", parameterId: SONG_TEMPO.id }, bpm);

async function setUp(options: { online?: boolean } = {}) {
  const repository = createInMemoryProjectRepository();
  const project = createSliceFixtureProject();
  const created = await repository.createProject(project);
  if (!created.ok) throw new Error("fixture project failed to create");
  let now = 0;
  const recorded = recordErrorReports({ now: () => now });
  const later = () => {
    now += 60_000;
  };
  const transport = createRecordingTransport();
  const analytics = new Analytics({
    transport,
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  analytics.setAccountType("anonymous");
  const open = (repo: ProjectRepository, opened: Project, withAnalytics = true) => {
    const session = new EditorSession({
      repository: repo,
      project: opened,
      clock: createManualClock(1_000),
      analytics: withAnalytics ? analytics : undefined,
      deviceStorage: memoryStorage(),
      coalesceMs: 60_000,
      saveFailures: { report: recorded.report, online: () => options.online ?? true },
    });
    sessions.push(session);
    return session;
  };
  const session = open(repository, project);
  /** Everything a payload must not carry: the project's names and the backend's text. */
  const content = [
    project.metadata.name,
    ...project.song.tracks.map((track) => track.name),
    ...project.clips.map((clip) => clip.name),
    "Injected persistence failure",
  ];
  const saveFailedEvents = () =>
    transport.events.filter((event) => event.name === "save_failed");
  return {
    repository,
    project,
    recorded,
    session,
    open,
    content,
    saveFailedEvents,
    later,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("a failed save (GRV-55)", () => {
  it("sends one scrubbed Sentry event with the failure's code when a write fails", async () => {
    const { repository, recorded, session, content, saveFailedEvents } = await setUp();
    repository.failNextWrites({ count: 1 });

    session.dispatch(tempo(128));
    await session.autosave.flush();

    expect(session.autosave.status.state).toBe("failed");
    expect(recorded.reports).toHaveLength(1);
    const [payload] = recorded.payloads();
    expect(payload.tags).toMatchObject({
      area: "persistence",
      error_code: "unavailable",
      fatal: false,
      online: true,
      browser_name: "chrome",
    });
    expectNoContent(payload, content);
    expect(saveFailedEvents()).toHaveLength(1);
    expect(saveFailedEvents()[0].params).toMatchObject({ error_code: "unavailable" });
  });

  it("says the browser was offline when it was", async () => {
    const { repository, recorded, session } = await setUp({ online: false });
    repository.failNextWrites({ count: 1 });

    session.dispatch(tempo(128));
    await session.autosave.flush();

    expect(recorded.payloads()[0].tags).toMatchObject({
      error_code: "unavailable",
      online: false,
    });
  });

  it("reports a failure once however many retries it costs, and a new one after a save lands", async () => {
    const { repository, recorded, session, saveFailedEvents, later } = await setUp();
    repository.failNextWrites({ count: 3 });

    session.dispatch(tempo(128));
    await session.autosave.flush();
    await session.autosave.retry();
    await session.autosave.retry();
    expect(recorded.reports).toHaveLength(1);
    // Analytics counts every attempt, with how many it has cost.
    expect(saveFailedEvents().map((event) => event.params.retry_count)).toEqual([
      0, 1, 2,
    ]);

    await session.autosave.retry();
    expect(session.autosave.status.state).toBe("saved");

    later();
    repository.failNextWrites({ count: 1 });
    session.dispatch(tempo(130));
    await session.autosave.flush();
    expect(recorded.reports).toHaveLength(2);
  });

  it("reports a revision conflict once, to Sentry and to analytics, and shows no conflict of its own", async () => {
    const { repository, project, recorded, open, content, saveFailedEvents } =
      await setUp();
    // This tab's write is held in flight while the other tab saves first, so
    // it reaches the store at a revision that is no longer current.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const gated: ProjectRepository = Object.create(repository);
    gated.saveChanges = async (...args) => {
      if (first) {
        first = false;
        await held;
      }
      return repository.saveChanges(...args);
    };
    const session = open(gated, project);
    const other = open(repository, project, false);

    session.dispatch(tempo(128));
    const writing = session.autosave.flush();
    other.dispatch(tempo(90));
    await other.autosave.flush();
    release();
    await writing;
    await settle();
    await session.autosave.flush();
    await settle();

    const conflicts = recorded.reports.filter(
      (report) => report.code === "revision_conflict",
    );
    expect(conflicts).toHaveLength(1);
    expect(recorded.reports).toHaveLength(1);
    expectNoContent(recorded.payloads()[0], content);
    expect(saveFailedEvents()).toHaveLength(1);
    expect(saveFailedEvents()[0].params).toMatchObject({
      error_code: "revision_conflict",
    });
    // GRV-88 owns the recovery: the edit was replayed over the other tab's and saved.
    expect(session.autosave.status.state).toBe("saved");
  });
});

describe("reconnecting (GRV-55)", () => {
  it("writes a save the connection dropped as soon as the browser is back online", async () => {
    const { repository, session } = await setUp();
    repository.failNextWrites({ count: 1 });
    session.dispatch(tempo(128));
    await session.autosave.flush();
    expect(session.autosave.status.state).toBe("failed");

    session.reconnected();
    await settle();

    expect(session.autosave.status.state).toBe("saved");
    expect(session.autosave.status.pending).toBe(0);
  });

  it("leaves a failure no retry can clear as it is", async () => {
    const { repository, project, open } = await setUp();
    let writes = 0;
    const tooLarge: ProjectRepository = Object.create(repository);
    tooLarge.saveChanges = async () => {
      writes += 1;
      return saveFailure("document_too_large", "Injected persistence failure");
    };
    const session = open(tooLarge, project);
    session.dispatch(tempo(128));
    await session.autosave.flush();
    expect(session.autosave.status.state).toBe("failed");
    expect(session.autosave.status.failure?.retryable).toBe(false);
    expect(writes).toBe(1);

    session.reconnected();
    await settle();

    expect(writes).toBe(1);
    expect(session.autosave.status.state).toBe("failed");
    expect(session.autosave.status.failure?.reason).toBe("document_too_large");
    expect(session.autosave.status.pending).toBeGreaterThan(0);
  });
});
