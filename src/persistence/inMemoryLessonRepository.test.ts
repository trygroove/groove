import { describe, expect, it } from "vitest";
import { createManualClock } from "../shared/clock";
import { InMemoryLessonRepository } from "./inMemoryLessonRepository";
import { emptyLessonRecord, lessonRecordPath } from "./lessonDocuments";
import {
  describeLessonRepositoryContract,
  LESSON_OWNER,
  LESSON_PROJECT,
} from "./lessonRepositoryContract";

describeLessonRepositoryContract("in-memory", () => {
  const clock = createManualClock();
  const repository = new InMemoryLessonRepository({ clock });
  return {
    clock,
    repositoryFor: () => repository,
    reset: async () => {},
    seedStoredDocument: async (path, data) => repository.writeDocument(path, data),
  };
});

describe("InMemoryLessonRepository", () => {
  it("writes one document per save", async () => {
    const repository = new InMemoryLessonRepository({ clock: createManualClock(1) });
    await repository.saveRecord(LESSON_OWNER, LESSON_PROJECT, emptyLessonRecord(1));
    expect(repository.writes).toEqual([
      { kind: "set", path: lessonRecordPath(LESSON_OWNER, LESSON_PROJECT) },
    ]);
  });
});
