import type { Firestore } from "firebase/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSliceFixtureProject } from "../domain/fixtures";
import { stringifyProject } from "../domain/serialize";
import { createManualClock } from "../shared/clock";
import { encodeProject, projectDocumentPath, songDocumentPath } from "./documents";

/**
 * The Firestore repository against a small in-process stand-in for the SDK.
 *
 * The emulator suite (`tests/emulator/`) holds this class to the real backend's
 * contract, but it cannot make the network drop a commit's acknowledgement.
 * This fake can: it reproduces the one SDK behaviour these tests are about,
 * which is that `runTransaction` re-runs its update function after a commit
 * fails with a retryable code such as `unavailable` — even when that commit
 * actually reached the server (#891).
 */
const backend = vi.hoisted(() => {
  const documents = new Map<string, Record<string, unknown>>();
  const state = {
    lostAcknowledgements: 0,
    /**
     * Another writer's save, landing between a transaction's read and its
     * commit. The emulator's rules then refuse the stale commit with
     * `permission-denied` before its preconditions are checked (GRV-7), which
     * is what this reproduces.
     */
    racingWrite: null as null | (() => void),
  };

  class FakeFirestoreError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }

  /** The codes the SDK's transaction runner retries on. */
  const RETRYABLE = new Set(["aborted", "unavailable", "deadline-exceeded"]);

  type Ref = { path: string };
  const snapshot = (path: string) => ({
    exists: () => documents.has(path),
    data: () => documents.get(path),
  });

  /** A commit that lands, then loses its acknowledgement on the way back. */
  function commit(writes: Array<[string, Record<string, unknown>]>): void {
    for (const [path, data] of writes) {
      documents.set(path, structuredClone(data));
    }
    if (state.lostAcknowledgements > 0) {
      state.lostAcknowledgements -= 1;
      throw new FakeFirestoreError("unavailable", "Commit failed: net::ERR_FAILED");
    }
  }

  const module = {
    doc: (_db: unknown, ...segments: string[]): Ref => ({ path: segments.join("/") }),
    collection: (_db: unknown, path: string) => ({ path }),
    getDoc: async (ref: Ref) => snapshot(ref.path),
    getDocs: async (ref: Ref) => ({
      docs: [...documents.keys()]
        .filter(
          (path) =>
            path.startsWith(`${ref.path}/`) &&
            !path.slice(ref.path.length + 1).includes("/"),
        )
        .map((path) => snapshot(path)),
    }),
    deleteDoc: async (ref: Ref) => {
      documents.delete(ref.path);
    },
    writeBatch: () => {
      const writes: Array<[string, Record<string, unknown>]> = [];
      return {
        set: (ref: Ref, data: Record<string, unknown>) => writes.push([ref.path, data]),
        commit: async () => commit(writes),
      };
    },
    runTransaction: async <T>(
      _db: unknown,
      update: (tx: unknown) => Promise<T>,
    ): Promise<T> => {
      for (let attempt = 1; ; attempt += 1) {
        const writes: Array<[string, Record<string, unknown>]> = [];
        const tx = {
          get: async (ref: Ref) => snapshot(ref.path),
          set: (ref: Ref, data: Record<string, unknown>) => {
            writes.push([ref.path, data]);
          },
          update: (ref: Ref, data: Record<string, unknown>) => {
            writes.push([ref.path, { ...documents.get(ref.path), ...data }]);
          },
        };
        const result = await update(tx);
        if (state.racingWrite) {
          const race = state.racingWrite;
          state.racingWrite = null;
          race();
          throw new FakeFirestoreError("permission-denied", "PERMISSION_DENIED");
        }
        try {
          commit(writes);
          return result;
        } catch (error) {
          const code = (error as { code?: string }).code ?? "";
          if (attempt >= 5 || !RETRYABLE.has(code)) throw error;
        }
      }
    },
    onSnapshot: () => () => {},
    orderBy: () => ({}),
    query: () => ({}),
    where: () => ({}),
  };

  return { documents, state, module };
});

vi.mock("firebase/firestore", () => backend.module);

const { FirestoreProjectRepository } = await import("./firestoreProjectRepository");

function repository() {
  return new FirestoreProjectRepository({} as Firestore, {
    clock: createManualClock(1_700_000_100_000),
  });
}

describe("FirestoreProjectRepository.createProject", () => {
  beforeEach(() => {
    backend.documents.clear();
    backend.state.lostAcknowledgements = 0;
  });

  it("creates the project when the metadata commit landed but its acknowledgement was lost", async () => {
    const project = createSliceFixtureProject();
    backend.state.lostAcknowledgements = 1;

    const created = await repository().createProject(project);

    expect(created).toEqual({
      ok: true,
      revision: project.metadata.revision,
      modifiedAt: project.metadata.modifiedAt,
    });
    // The rest of the project was written too, so the editor can open it.
    expect(backend.documents.has(songDocumentPath(project.metadata.id))).toBe(true);
    const loaded = await repository().loadProject(project.metadata.id);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(stringifyProject(loaded.value)).toBe(stringifyProject(project));
  });

  it("still refuses a project whose ID was already taken before this call", async () => {
    const project = createSliceFixtureProject();
    expect((await repository().createProject(project)).ok).toBe(true);

    const again = await repository().createProject(project);

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe("already_exists");
  });

  it("still refuses an ID that a different project already holds", async () => {
    const project = createSliceFixtureProject();
    const squatter = createSliceFixtureProject({ seed: "squatter" });
    backend.documents.set(projectDocumentPath(project.metadata.id), {
      ...encodeProject(squatter).metadata.data,
      id: project.metadata.id,
    });

    const created = await repository().createProject(project);

    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.reason).toBe("already_exists");
  });
});

describe("FirestoreProjectRepository revision-checked writes", () => {
  beforeEach(() => {
    backend.documents.clear();
    backend.state.lostAcknowledgements = 0;
    backend.state.racingWrite = null;
  });

  it("reports a conflict when the rules refuse a commit another save overtook", async () => {
    const project = createSliceFixtureProject();
    const id = project.metadata.id;
    expect((await repository().createProject(project)).ok).toBe(true);
    backend.state.racingWrite = () => {
      const path = projectDocumentPath(id);
      const stored = backend.documents.get(path) as Record<string, number>;
      backend.documents.set(path, { ...stored, revision: stored.revision + 1 });
    };

    const saved = await repository().saveClip(
      id,
      project.clips[0],
      project.metadata.revision,
    );

    expect(saved).toMatchObject({ ok: false, reason: "revision_conflict" });
  });

  it("still reports a refusal as one when the revision has not moved", async () => {
    const project = createSliceFixtureProject();
    expect((await repository().createProject(project)).ok).toBe(true);
    backend.state.racingWrite = () => {};

    const saved = await repository().saveClip(
      project.metadata.id,
      project.clips[0],
      project.metadata.revision,
    );

    expect(saved).toMatchObject({ ok: false, reason: "unavailable", retryable: false });
  });

  it("reports a saved clip when the commit landed but its acknowledgement was lost", async () => {
    const project = createSliceFixtureProject();
    expect((await repository().createProject(project)).ok).toBe(true);
    backend.state.lostAcknowledgements = 1;

    const saved = await repository().saveClip(
      project.metadata.id,
      project.clips[0],
      project.metadata.revision,
    );

    expect(saved).toEqual({
      ok: true,
      revision: project.metadata.revision + 1,
      modifiedAt: 1_700_000_100_000,
    });
  });

  it("still reports a conflict when another writer moved the revision", async () => {
    const project = createSliceFixtureProject();
    expect((await repository().createProject(project)).ok).toBe(true);
    expect(
      (await repository().saveMetadata(project.metadata.id, { name: "Theirs" }, 0)).ok,
    ).toBe(true);

    const saved = await repository().saveClip(
      project.metadata.id,
      project.clips[0],
      project.metadata.revision,
    );

    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.reason).toBe("revision_conflict");
  });
});
