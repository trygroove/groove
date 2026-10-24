import { describe, expect, it } from "vitest";
import {
  decodeLessonRecord,
  emptyLessonRecord,
  encodeLessonRecord,
  lessonRecordPath,
} from "./lessonDocuments";
import { filledLessonRecord } from "./lessonRepositoryContract";

describe("the lesson record's layout (GRV-190)", () => {
  it("lives under the user, one document per project", () => {
    expect(lessonRecordPath("u1", "prj_a")).toBe("users/u1/lessons/prj_a");
  });

  it("encodes at version 1 and decodes back to the same record", () => {
    const record = filledLessonRecord(5);
    const encoded = encodeLessonRecord(record);
    expect(encoded.version).toBe(1);
    expect(decodeLessonRecord(encoded)).toEqual(record);
    expect(decodeLessonRecord(encodeLessonRecord(emptyLessonRecord(3)))).toEqual(
      emptyLessonRecord(3),
    );
  });

  it("reads a bite or lesson this build does not know, by its shape", () => {
    const encoded = encodeLessonRecord({
      ...emptyLessonRecord(1),
      finished: { "drums-swing": { how: "did_it", at: 1 } },
    });
    expect(decodeLessonRecord(encoded)?.finished).toEqual({
      "drums-swing": { how: "did_it", at: 1 },
    });
  });

  it("refuses a record of another version, an unknown field or a malformed ID", () => {
    const encoded = encodeLessonRecord(filledLessonRecord(1));
    expect(decodeLessonRecord({ ...encoded, version: 2 })).toBeNull();
    expect(decodeLessonRecord({ ...encoded, projectName: "x" })).toBeNull();
    expect(
      decodeLessonRecord({
        ...encoded,
        finished: { "Not An ID": { how: "did_it", at: 1 } },
      }),
    ).toBeNull();
  });
});
