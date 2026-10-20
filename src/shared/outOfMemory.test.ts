import { describe, expect, it } from "vitest";
import { isOutOfMemory } from "./outOfMemory";

describe("isOutOfMemory (GRV-55)", () => {
  it("recognises the engines' allocation failures", () => {
    expect(isOutOfMemory(new RangeError("Array buffer allocation failed"))).toBe(true);
    expect(isOutOfMemory(new RangeError("Invalid typed array length: 99999999999"))).toBe(
      true,
    );
    const firefox = new Error("allocation size overflow");
    firefox.name = "InternalError";
    expect(isOutOfMemory(firefox)).toBe(true);
    expect(isOutOfMemory(new RangeError("out of memory"))).toBe(true);
  });

  it("does not mistake one of our own refusals, or anything else, for one", () => {
    expect(isOutOfMemory(new RangeError("The render is too long for a WAV file"))).toBe(
      false,
    );
    expect(isOutOfMemory(new Error("Array buffer allocation failed"))).toBe(false);
    // A negative or invalid length is a bug in the size asked for, not memory.
    expect(isOutOfMemory(new RangeError("Invalid typed array length: -1"))).toBe(false);
    expect(isOutOfMemory(new RangeError("Invalid array buffer length"))).toBe(false);
    expect(isOutOfMemory(new RangeError("Maximum call stack size exceeded"))).toBe(false);
    const recursion = new Error("too much recursion");
    recursion.name = "InternalError";
    expect(isOutOfMemory(recursion)).toBe(false);
    expect(isOutOfMemory("out of memory")).toBe(false);
    expect(isOutOfMemory(null)).toBe(false);
  });
});
