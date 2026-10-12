import { beforeEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import {
  createRecordingTransport,
  type RecordingTransport,
} from "../analytics/transport";
import type { Clip, Project } from "../domain/entities";
import { createSliceFixtureProject } from "../domain/fixtures";
import type { ClipId, EventId, PlacementId } from "../domain/ids";
import type { Ticks } from "../domain/time";
import { createManualClock } from "../shared/clock";
import { createManualScheduler, type ManualScheduler } from "../shared/scheduler";
import { memoryStorage } from "../testing/storage";
import { ProjectAutosave, type SaveStatus } from "./autosave";
import { clipDocumentPath, songDocumentPath } from "./documents";
import { InMemoryProjectRepository } from "./inMemoryProjectRepository";
import { type ProjectRepository, saveFailure } from "./projectRepository";

function createTestAnalytics(): {
  analytics: Analytics;
  transport: RecordingTransport;
} {
  const transport = createRecordingTransport();
  const analytics = new Analytics({
    transport,
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  analytics.setAccountType("anonymous");
  return { analytics, transport };
}

/**
 * Wraps a repository so the first song write blocks until the test releases it.
 * It stands in for network latency: the value handed to the repository is the
 * one captured when the write started, so an edit made during the await is a
 * genuinely newer value that must still reach the store.
 */
function gateFirstSongSave(inner: ProjectRepository): {
  repository: ProjectRepository;
  release: () => void;
} {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let gated = true;
  const repository: ProjectRepository = {
    createProject: (project) => inner.createProject(project),
    loadProject: (projectId) => inner.loadProject(projectId),
    listProjects: (ownerId) => inner.listProjects(ownerId),
    loadProjectMetadata: (projectId) => inner.loadProjectMetadata(projectId),
    saveMetadata: (projectId, patch, base) => inner.saveMetadata(projectId, patch, base),
    saveSong: async (projectId, song, base) => {
      if (gated) {
        gated = false;
        await gate;
      }
      return inner.saveSong(projectId, song, base);
    },
    saveClip: (projectId, clip, base) => inner.saveClip(projectId, clip, base),
    deleteClip: (projectId, clipId, base) => inner.deleteClip(projectId, clipId, base),
    saveChanges: async (projectId, changes, base) => {
      if (changes.song && gated) {
        gated = false;
        await gate;
      }
      return inner.saveChanges(projectId, changes, base);
    },
    deleteProject: (projectId) => inner.deleteProject(projectId),
    watchProject: (projectId, listener) => inner.watchProject(projectId, listener),
  };
  return { repository, release: () => release() };
}

const WRITE_METHODS = new Set([
  "saveMetadata",
  "saveSong",
  "saveClip",
  "deleteClip",
  "saveChanges",
]);

/**
 * Lets the first `allowed` repository writes through and fails every one after
 * them, as a tab that unloads mid-drain does: the writes already committed
 * stay committed, and nothing queued behind them ever lands (#965).
 */
function interruptAfter(inner: ProjectRepository, allowed: number): ProjectRepository {
  let remaining = allowed;
  return new Proxy(inner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (!WRITE_METHODS.has(String(property))) return value.bind(target);
      return (...args: unknown[]) => {
        if (remaining <= 0) {
          return Promise.resolve(saveFailure("unavailable", "The page unloaded"));
        }
        remaining -= 1;
        return value.apply(target, args);
      };
    },
  });
}

/** The fixture with its one clip duplicated `count` times along the arrangement. */
function withDuplicatedClip(project: Project, count: number): Project {
  const [clip] = project.clips;
  const [placement] = project.song.placements;
  // Prefixed IDs carry a 21-character suffix.
  const suffix = (index: number) => `duplicate${index}`.padEnd(21, "x");
  const copyClip = (index: number): Clip => {
    if (clip.content.kind !== "notes") throw new Error("Expected a note clip");
    return {
      ...clip,
      id: `clp_${suffix(index)}` as ClipId,
      content: {
        ...clip.content,
        events: clip.content.events.map((event, at) => ({
          ...event,
          id: `evt_${suffix(index * 100 + at)}` as EventId,
        })),
      },
    };
  };
  const copies = Array.from({ length: count }, (_, index) => ({
    clip: copyClip(index),
    placement: {
      ...placement,
      id: `plc_${suffix(index)}` as PlacementId,
      clipId: `clp_${suffix(index)}` as ClipId,
      startTicks: (placement.startTicks + (index + 1) * placement.durationTicks) as Ticks,
    },
  }));
  return {
    ...project,
    song: {
      ...project.song,
      placements: [...project.song.placements, ...copies.map((copy) => copy.placement)],
    },
    clips: [...project.clips, ...copies.map((copy) => copy.clip)],
  };
}

describe("ProjectAutosave", () => {
  let repository: InMemoryProjectRepository;
  let scheduler: ManualScheduler;
  let project: Project;
  let autosave: ProjectAutosave;
  let statuses: SaveStatus[];

  beforeEach(async () => {
    repository = new InMemoryProjectRepository({
      clock: createManualClock(1_700_000_100_000),
    });
    scheduler = createManualScheduler();
    project = createSliceFixtureProject();
    await repository.createProject(project);
    repository.clearWrites();
    statuses = [];
    autosave = new ProjectAutosave({
      repository,
      projectId: project.metadata.id,
      revision: project.metadata.revision,
      coalesceMs: 400,
      scheduler,
      onStatus: (status) => statuses.push(status),
    });
  });

  function renamedSong(tempo: number) {
    return { ...project.song, tempo };
  }

  it("starts idle and reports pending work as soon as an edit is queued", () => {
    expect(autosave.status.state).toBe("idle");

    autosave.queueSong(renamedSong(121));

    expect(autosave.status).toMatchObject({ state: "pending", pending: 1 });
  });

  it("coalesces rapid edits to the same entity into one write", async () => {
    for (let tempo = 121; tempo <= 140; tempo += 1) {
      autosave.queueSong(renamedSong(tempo));
    }
    expect(repository.writes).toHaveLength(0);

    scheduler.runAll();
    await autosave.flush();

    expect(
      repository.writes.filter(
        (write) => write.path === songDocumentPath(project.metadata.id),
      ),
    ).toHaveLength(1);
    const loaded = await repository.loadProject(project.metadata.id);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // The final value survives coalescing — only the intermediate ones are lost.
    expect(loaded.value.song.tempo).toBe(140);
  });

  it("keeps an edit made while a write is in flight instead of dropping it", async () => {
    const { repository: gated, release } = gateFirstSongSave(repository);
    const songPath = songDocumentPath(project.metadata.id);
    // Sampled whenever a status is published, so a "saved" that was announced
    // before the final value reached the store is visible to the assertions.
    const savedWith: Array<number | undefined> = [];
    const controller = new ProjectAutosave({
      repository: gated,
      projectId: project.metadata.id,
      revision: project.metadata.revision,
      coalesceMs: 400,
      scheduler,
      onStatus: (status) => {
        if (status.state === "saved") {
          savedWith.push(repository.readDocument(songPath)?.tempo as number);
        }
      },
    });

    controller.queueSong(renamedSong(121));
    const firstFlush = controller.flush();
    // Let drain() reach the awaited write before the next edit arrives.
    await Promise.resolve();
    controller.queueSong(renamedSong(140));
    release();
    await firstFlush;
    scheduler.runAll();
    await controller.flush();

    const loaded = await repository.loadProject(project.metadata.id);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.song.tempo).toBe(140);
    expect(controller.status).toMatchObject({ state: "saved", pending: 0 });
    // Every "saved" the UI could have shown was backed by the final value.
    expect(savedWith.length).toBeGreaterThan(0);
    expect(savedWith).toEqual(savedWith.map(() => 140));
  });

  it("does not report a conflict against a write it just made itself", async () => {
    autosave.queueSong(renamedSong(140));
    // The first write fails, so the entry stays queued and every flush that
    // wakes afterwards finds work to do.
    repository.failNextWrites({ count: 1 });

    // Three flushes with nothing awaited between them. This is ordinary use,
    // not a test-only contrivance: every edit re-arms the coalescing timer, so
    // a user who keeps editing through one slow write produces exactly this.
    // All three park on the same in-flight drain.
    await Promise.all([autosave.flush(), autosave.flush(), autosave.flush()]);

    const loaded = await repository.loadProject(project.metadata.id);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.song.tempo).toBe(140);
    // Two drains racing the same queue at the same base revision would both
    // write; one wins and the other comes back `revision_conflict`. That is a
    // conflict with this controller's own write, and it would surface as a
    // permanent "save failed" over a project that is in fact fully saved —
    // unclearable, because `retry()` finds an empty queue and returns early.
    expect(autosave.status).toMatchObject({
      state: "saved",
      pending: 0,
      failure: null,
    });
    expect(
      repository.writes.filter(
        (write) => write.path === songDocumentPath(project.metadata.id),
      ),
    ).toHaveLength(1);
  });

  it("never reports failure with an empty queue, whatever the flush interleaving", async () => {
    // A clip queued behind the song gives the racing drains different entries
    // to pick up, which is how the inconsistency showed as a stale `failure`
    // hanging off an otherwise-"saved" status rather than as a failed state.
    autosave.queueSong(renamedSong(141));
    autosave.queueClip(project.clips[0]);
    repository.failNextWrites({ count: 1 });

    await Promise.all([
      autosave.flush(),
      autosave.flush(),
      autosave.flush(),
      autosave.retry(),
    ]);

    // The invariant a consumer reads: a failure means something is still
    // queued to retry. Anything else cannot be rendered coherently — there is
    // nothing for a "retry" affordance to act on.
    const status = autosave.status;
    if (status.failure !== null || status.state === "failed") {
      expect(status.pending).toBeGreaterThan(0);
    } else {
      expect(status).toMatchObject({ state: "saved", pending: 0 });
    }
  });

  it("writes every queued entity once, as one revision", async () => {
    autosave.queueMetadata({ name: "Renamed" });
    autosave.queueClip(project.clips[0]);
    autosave.queueSong(renamedSong(126));

    await autosave.flush();

    // Clips land ahead of the song that places them, and the metadata
    // document's revision bump closes the one write.
    expect(repository.writes.map((write) => write.path)).toEqual([
      clipDocumentPath(project.metadata.id, project.clips[0].id),
      songDocumentPath(project.metadata.id),
      `projects/${project.metadata.id}`,
    ]);
    expect(autosave.status).toMatchObject({
      state: "saved",
      pending: 0,
      revision: project.metadata.revision + 1,
    });
  });

  describe("never stores a song that references unwritten clips (#965)", () => {
    // `EditorSession` queues the song before the clips a structural edit
    // created, which is the order a run of Ctrl+D duplicates produces.
    for (const allowed of [0, 1, 2, 3, 4]) {
      it(`leaves a loadable project when the page unloads after ${allowed} write(s)`, async () => {
        const next = withDuplicatedClip(project, 3);
        const controller = new ProjectAutosave({
          repository: interruptAfter(repository, allowed),
          projectId: project.metadata.id,
          revision: project.metadata.revision,
          scheduler,
        });
        controller.queueSong(next.song);
        for (const clip of next.clips.slice(1)) {
          controller.queueClip(clip);
        }

        await controller.flush();

        const loaded = await repository.loadProject(project.metadata.id);
        expect(loaded.ok ? [] : loaded.issues).toEqual([]);
      });
    }

    it("writes clips ahead of the song when there are too many for one write", async () => {
      // 250 new clips is more than one backend transaction takes, so the
      // queue is split. Every split point must still be a loadable project.
      const next = withDuplicatedClip(project, 250);
      for (const allowed of [1, 2]) {
        const store = new InMemoryProjectRepository({
          clock: createManualClock(1_700_000_100_000),
        });
        await store.createProject(project);
        const saveChanges = vi.spyOn(store, "saveChanges");
        const controller = new ProjectAutosave({
          repository: interruptAfter(store, allowed),
          projectId: project.metadata.id,
          revision: project.metadata.revision,
          scheduler,
        });
        controller.queueSong(next.song);
        for (const clip of next.clips.slice(1)) {
          controller.queueClip(clip);
        }

        await controller.flush();

        expect(saveChanges.mock.calls[0]?.[1].song).toBeUndefined();
        const loaded = await store.loadProject(project.metadata.id);
        expect(loaded.ok ? [] : loaded.issues).toEqual([]);
        if (!loaded.ok) continue;
        expect(loaded.value.song.placements).toHaveLength(allowed === 1 ? 1 : 251);
        expect(loaded.value.clips).toHaveLength(allowed === 1 ? 201 : 251);
      }
    });

    it("never stores a clip whose track the stored song has removed", async () => {
      // A track deletion removes the track and its clip together: the song
      // write and the clip deletion must land as one.
      const controller = new ProjectAutosave({
        repository: interruptAfter(repository, 1),
        projectId: project.metadata.id,
        revision: project.metadata.revision,
        scheduler,
      });
      controller.queueSong({ ...project.song, tracks: [], placements: [] });
      controller.queueClipDeletion(project.clips[0].id);

      await controller.flush();

      const loaded = await repository.loadProject(project.metadata.id);
      expect(loaded.ok ? [] : loaded.issues).toEqual([]);
    });
  });

  it("merges successive metadata patches instead of overwriting them", async () => {
    autosave.queueMetadata({ name: "First" });
    autosave.queueMetadata({ genre: "house" });

    await autosave.flush();

    const loaded = await repository.loadProjectMetadata(project.metadata.id);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value).toMatchObject({ name: "First", genre: "house" });
  });

  it("exposes saving and saved states around a write", async () => {
    autosave.queueSong(renamedSong(122));
    await autosave.flush();

    expect(statuses.map((status) => status.state)).toEqual([
      "pending",
      "saving",
      "saved",
    ]);
  });

  it("writes automatically once the coalescing window elapses", async () => {
    autosave.queueSong(renamedSong(123));

    scheduler.advance(399);
    expect(repository.writes).toHaveLength(0);
    scheduler.advance(1);
    await autosave.flush();

    expect(repository.writes.length).toBeGreaterThan(0);
  });

  it("keeps a failed write queued and retries it with the same value", async () => {
    repository.failNextWrites({ count: 1 });
    autosave.queueSong(renamedSong(124));

    await autosave.flush();

    expect(autosave.status).toMatchObject({ state: "failed", pending: 1 });
    expect(autosave.status.failure?.retryable).toBe(true);

    await autosave.retry();

    expect(autosave.status).toMatchObject({ state: "saved", pending: 0 });
    const loaded = await repository.loadProject(project.metadata.id);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.song.tempo).toBe(124);
  });

  it("stops at the failing write rather than burning revisions on later ones", async () => {
    repository.failNextWrites({ count: 1 });
    autosave.queueSong(renamedSong(125));
    autosave.queueClip(project.clips[0]);

    await autosave.flush();

    expect(autosave.status).toMatchObject({ state: "failed", pending: 2 });
  });

  it("surfaces a revision conflict instead of silently retrying forever", async () => {
    // Another client writes first, so the local base revision is stale.
    await repository.saveMetadata(
      project.metadata.id,
      { name: "Other client" },
      project.metadata.revision,
    );

    autosave.queueSong(renamedSong(127));
    await autosave.flush();

    expect(autosave.status.state).toBe("failed");
    expect(autosave.status.failure).toMatchObject({
      reason: "revision_conflict",
      retryable: false,
      currentRevision: project.metadata.revision + 1,
    });
  });

  it("ignores a remote echo of its own write", async () => {
    autosave.queueMetadata({ name: "Local" });
    await autosave.flush();
    const localRevision = autosave.status.revision;

    const echo = await repository.loadProjectMetadata(project.metadata.id);
    expect(echo.ok).toBe(true);
    if (!echo.ok) return;

    expect(autosave.applyRemote({ kind: "metadata", metadata: echo.value })).toBe(
      "ignored_stale",
    );
    expect(autosave.status.revision).toBe(localRevision);
  });

  it("ignores a newer remote snapshot while a local edit is still queued", async () => {
    autosave.queueSong(renamedSong(128));

    const remote = await repository.loadProjectMetadata(project.metadata.id);
    expect(remote.ok).toBe(true);
    if (!remote.ok) return;

    expect(
      autosave.applyRemote({
        kind: "metadata",
        metadata: { ...remote.value, revision: 99 },
      }),
    ).toBe("ignored_local_pending");
  });

  it("adopts a newer remote snapshot when nothing is queued locally", async () => {
    const adopted: number[] = [];
    const controller = new ProjectAutosave({
      repository,
      projectId: project.metadata.id,
      revision: project.metadata.revision,
      scheduler,
      onRemoteMetadata: (metadata) => adopted.push(metadata.revision),
    });

    const remote = await repository.loadProjectMetadata(project.metadata.id);
    expect(remote.ok).toBe(true);
    if (!remote.ok) return;

    expect(
      controller.applyRemote({
        kind: "metadata",
        metadata: { ...remote.value, revision: 4 },
      }),
    ).toBe("adopted");
    expect(controller.status.revision).toBe(4);
    expect(adopted).toEqual([4]);
  });

  describe("rebase (GRV-88)", () => {
    it("drops the queue and writes what is queued next at the new revision", async () => {
      autosave.queueSong(renamedSong(128));
      // Another tab saves first, moving the store to the next revision.
      const elsewhere = await repository.saveChanges(
        project.metadata.id,
        { song: renamedSong(140), clips: [], deletedClipIds: [] },
        project.metadata.revision,
      );
      if (!elsewhere.ok) throw new Error("expected the other tab's write to land");

      autosave.rebase(elsewhere.revision);
      expect(autosave.status).toMatchObject({
        state: "saved",
        pending: 0,
        revision: elsewhere.revision,
        failure: null,
      });
      expect(scheduler.pending).toBe(0);

      autosave.queueSong(renamedSong(141));
      scheduler.runAll();
      const status = await autosave.flush();
      expect(status.state).toBe("saved");
      expect(status.revision).toBeGreaterThan(elsewhere.revision);
      const loaded = await repository.loadProject(project.metadata.id);
      if (!loaded.ok) throw new Error("expected the project to load");
      expect(loaded.value.song.tempo).toBe(141);
    });

    it("clears a conflict, so the next write is not refused again", async () => {
      autosave.queueSong(renamedSong(128));
      const elsewhere = await repository.saveChanges(
        project.metadata.id,
        { song: renamedSong(140), clips: [], deletedClipIds: [] },
        project.metadata.revision,
      );
      if (!elsewhere.ok) throw new Error("expected the other tab's write to land");
      const failed = await autosave.flush();
      expect(failed.failure?.reason).toBe("revision_conflict");

      autosave.rebase(elsewhere.revision);
      autosave.queueSong(renamedSong(128));
      const status = await autosave.flush();
      expect(status).toMatchObject({ state: "saved", failure: null, pending: 0 });
    });

    it("refuses while a write is in flight", async () => {
      const { repository: gated, release } = gateFirstSongSave(repository);
      const controller = new ProjectAutosave({
        repository: gated,
        projectId: project.metadata.id,
        revision: project.metadata.revision,
        scheduler,
      });
      controller.queueSong(renamedSong(128));
      const writing = controller.flush();
      expect(() => controller.rebase(5)).toThrow(/in flight/);
      release();
      await writing;
    });
  });

  it("stops writing after disposal and cancels the pending timer", async () => {
    autosave.queueSong(renamedSong(129));
    autosave.dispose();

    scheduler.runAll();
    await autosave.flush();

    expect(scheduler.pending).toBe(0);
    expect(repository.writes).toHaveLength(0);
  });

  describe("analytics (PRD OPS-02)", () => {
    it("logs save_failed once per failing write, with the error code and retry count", async () => {
      const { analytics, transport } = createTestAnalytics();
      const controller = new ProjectAutosave({
        repository,
        projectId: project.metadata.id,
        revision: project.metadata.revision,
        scheduler,
        analytics,
      });
      repository.failNextWrites({ count: 1 });

      controller.queueSong(renamedSong(150));
      await controller.flush();

      expect(transport.named("save_failed")).toHaveLength(1);
      expect(transport.named("save_failed")[0]?.params).toMatchObject({
        error_code: "unavailable",
        retry_count: 0,
      });
    });

    it("does not log save_failed again for the same in-flight retry racing itself", async () => {
      // Mirrors "does not report a conflict against a write it just made
      // itself" above: several flushes park on one drain, so this asserts
      // the coalescing guarantee — one event per failure episode, not one
      // per attempt — holds for the analytics event too.
      const { analytics, transport } = createTestAnalytics();
      const controller = new ProjectAutosave({
        repository,
        projectId: project.metadata.id,
        revision: project.metadata.revision,
        scheduler,
        analytics,
      });
      repository.failNextWrites({ count: 1 });
      controller.queueSong(renamedSong(151));

      await Promise.all([controller.flush(), controller.flush(), controller.flush()]);

      expect(transport.named("save_failed")).toHaveLength(1);
    });

    it("logs save_recovered exactly once when a retry after a failure succeeds", async () => {
      const { analytics, transport } = createTestAnalytics();
      const controller = new ProjectAutosave({
        repository,
        projectId: project.metadata.id,
        revision: project.metadata.revision,
        scheduler,
        analytics,
      });
      repository.failNextWrites({ count: 1 });
      controller.queueSong(renamedSong(152));

      await controller.flush();
      expect(controller.status.state).toBe("failed");
      expect(transport.named("save_recovered")).toHaveLength(0);

      await controller.retry();

      expect(controller.status.state).toBe("saved");
      expect(transport.named("save_recovered")).toHaveLength(1);
      expect(transport.named("save_recovered")[0]?.params).toMatchObject({
        retry_count: 1,
      });
    });

    it("does not log save_recovered for an ordinary save with no prior failure", async () => {
      const { analytics, transport } = createTestAnalytics();
      const controller = new ProjectAutosave({
        repository,
        projectId: project.metadata.id,
        revision: project.metadata.revision,
        scheduler,
        analytics,
      });

      controller.queueSong(renamedSong(153));
      await controller.flush();

      expect(controller.status.state).toBe("saved");
      expect(transport.named("save_recovered")).toHaveLength(0);
    });

    it("counts every failed attempt in the episode's retry_count, and reports exactly one recovery", async () => {
      const { analytics, transport } = createTestAnalytics();
      const controller = new ProjectAutosave({
        repository,
        projectId: project.metadata.id,
        revision: project.metadata.revision,
        scheduler,
        analytics,
      });
      repository.failNextWrites({ count: 2 });
      controller.queueSong(renamedSong(154));

      await controller.flush();
      await controller.retry();
      expect(controller.status.state).toBe("failed");
      await controller.retry();

      expect(controller.status.state).toBe("saved");
      expect(transport.named("save_failed")).toHaveLength(2);
      expect(transport.named("save_failed").map((e) => e.params.retry_count)).toEqual([
        0, 1,
      ]);
      expect(transport.named("save_recovered")).toHaveLength(1);
      expect(transport.named("save_recovered")[0]?.params).toMatchObject({
        retry_count: 2,
      });
    });
  });
});
