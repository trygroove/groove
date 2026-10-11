import { describe, expect, it } from "vitest";
import { createManualClock } from "../shared/clock";
import { InMemoryProfileRepository } from "./inMemoryProfileRepository";
import { emptyProfile, profileDocumentPath } from "./profileDocuments";
import {
  describeProfileRepositoryContract,
  PROFILE_OWNER,
} from "./profileRepositoryContract";

describeProfileRepositoryContract("in-memory", () => {
  const clock = createManualClock();
  const repository = new InMemoryProfileRepository({ clock });
  return {
    clock,
    repositoryFor: () => repository,
    reset: async () => {},
    seedStoredDocument: async (path, data) => repository.writeDocument(path, data),
  };
});

describe("InMemoryProfileRepository", () => {
  it("writes one document per save", async () => {
    const repository = new InMemoryProfileRepository({ clock: createManualClock(1) });
    await repository.saveProfile(PROFILE_OWNER, emptyProfile(1));
    expect(repository.writes).toEqual([
      { kind: "set", path: profileDocumentPath(PROFILE_OWNER) },
    ]);
  });
});
