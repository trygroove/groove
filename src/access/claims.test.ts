import { describe, expect, it } from "vitest";
import {
  hasInternalClaim,
  hasUnlimitedClaim,
  INTERNAL_CLAIM,
  withInternalClaim,
} from "./claims";

describe("hasInternalClaim", () => {
  it("is true only for the claim set to true", () => {
    expect(INTERNAL_CLAIM).toBe("internal");
    expect(hasInternalClaim({ internal: true })).toBe(true);
    expect(hasInternalClaim({ internal: true, admin: true })).toBe(true);
  });

  it.each([
    ["no claims", undefined],
    ["null claims", null],
    ["no internal claim", { admin: true }],
    ["false", { internal: false }],
    ["a truthy string", { internal: "true" }],
    ["a number", { internal: 1 }],
  ])("is false for %s", (_, claims) => {
    expect(hasInternalClaim(claims)).toBe(false);
  });
});

describe("hasUnlimitedClaim", () => {
  it.each([
    ["an internal account", { internal: true }],
    ["an admin", { admin: true }],
    ["both", { internal: true, admin: true }],
  ])("is true for %s", (_, claims) => {
    expect(hasUnlimitedClaim(claims)).toBe(true);
  });

  it.each([
    ["no claims", undefined],
    ["null claims", null],
    ["an ordinary account", { email_verified: true }],
    ["false claims", { internal: false, admin: false }],
    ["truthy strings", { internal: "true", admin: "true" }],
  ])("is false for %s", (_, claims) => {
    expect(hasUnlimitedClaim(claims)).toBe(false);
  });
});

describe("withInternalClaim", () => {
  it("grants the claim and keeps every other claim", () => {
    expect(withInternalClaim({ admin: true }, true)).toEqual({
      admin: true,
      internal: true,
    });
    expect(withInternalClaim(undefined, true)).toEqual({ internal: true });
  });

  it("revokes by removing the claim, keeping every other one", () => {
    expect(withInternalClaim({ admin: true, internal: true }, false)).toEqual({
      admin: true,
    });
    expect(withInternalClaim(null, false)).toEqual({});
  });

  it("does not change the claims it is given", () => {
    const claims = { admin: true, internal: true };
    withInternalClaim(claims, false);
    expect(claims).toEqual({ admin: true, internal: true });
  });
});
