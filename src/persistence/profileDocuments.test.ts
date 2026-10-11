import { describe, expect, it } from "vitest";
import {
  decodeProfile,
  EMPTY_MEMORY,
  emptyProfile,
  encodeProfile,
  MEMORY_FIELDS,
  PROFILE_SCHEMA_VERSION,
  profileDocumentPath,
} from "./profileDocuments";
import { filledProfile } from "./profileRepositoryContract";

describe("the profile document (GRV-25)", () => {
  it("lives under the user, never under a project", () => {
    expect(profileDocumentPath("uid_1")).toBe("users/uid_1/profile/current");
  });

  it("round-trips a full profile through encode and decode", () => {
    const profile = filledProfile(1_700_000_000_000);
    const encoded = encodeProfile(profile);
    expect(encoded.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
    expect(decodeProfile(JSON.parse(JSON.stringify(encoded)))).toEqual(profile);
  });

  it("round-trips an empty profile", () => {
    expect(decodeProfile(encodeProfile(emptyProfile(5)))).toEqual(emptyProfile(5));
  });

  it("keeps memory as the six typed keys", () => {
    expect(Object.keys(EMPTY_MEMORY).sort()).toEqual([...MEMORY_FIELDS].sort());
  });

  it("refuses a document of another version, or with fields it does not know", () => {
    const encoded = encodeProfile(emptyProfile(1));
    expect(decodeProfile({ ...encoded, schemaVersion: 2 })).toBeNull();
    expect(decodeProfile({ ...encoded, projectId: "prj_x" })).toBeNull();
    expect(
      decodeProfile({ ...encoded, memory: { ...EMPTY_MEMORY, experience: "expert" } }),
    ).toBeNull();
    expect(decodeProfile(null)).toBeNull();
  });
});
