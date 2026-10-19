import { describe, expect, it, vi } from "vitest";
import { exportStems } from "./exportStems";
import { createStemFixtureProject } from "./stemFixture";
import { exportFailure, fakeRenderer } from "./stemTestSupport";

/**
 * What a stems export says when its ZIP, or the memory to build it, fails
 * (GRV-55). The archive is replaced only for the one test that needs it.
 */

const archive = vi.hoisted(() => ({ fail: null as Error | null }));
vi.mock("./stemArchive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stemArchive")>();
  return {
    ...actual,
    buildStemArchive: (...args: Parameters<typeof actual.buildStemArchive>) => {
      if (archive.fail) throw archive.fail;
      return actual.buildStemArchive(...args);
    },
  };
});

const RATE = 8_000;

describe("exportStems failures (GRV-55)", () => {
  it("fails as zip_batch_failed when the ZIP cannot be built", async () => {
    archive.fail = new Error("deflate stream broke");
    try {
      const error = await exportFailure(
        exportStems(createStemFixtureProject(), {
          sampleRate: RATE,
          render: fakeRenderer().render,
        }),
      );
      expect(error.code).toBe("zip_batch_failed");
    } finally {
      archive.fail = null;
    }
  });

  it("fails as out_of_memory when the ZIP's memory cannot be allocated", async () => {
    archive.fail = new RangeError("Array buffer allocation failed");
    try {
      const error = await exportFailure(
        exportStems(createStemFixtureProject(), {
          sampleRate: RATE,
          render: fakeRenderer().render,
        }),
      );
      expect(error.code).toBe("out_of_memory");
    } finally {
      archive.fail = null;
    }
  });

  it("fails as out_of_memory when a render's memory cannot be allocated", async () => {
    const error = await exportFailure(
      exportStems(createStemFixtureProject(), {
        sampleRate: RATE,
        render: async () => {
          throw new RangeError("Array buffer allocation failed");
        },
      }),
    );
    expect(error.code).toBe("out_of_memory");
  });
});
