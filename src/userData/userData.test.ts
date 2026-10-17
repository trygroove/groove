import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ADMIN_CLAIM, INTERNAL_CLAIM } from "../access/claims";
import {
  formatBytes,
  IMPORT_CONTENT_TYPES,
  importContentType,
  MAX_IMPORT_FILE_BYTES,
  MAX_PACK_SOUNDS,
  packAudioPath,
  parseUserDataPath,
  USER_DATA_CAP_BYTES,
  usageDocPath,
  usageObjectDocPath,
  usageStanding,
} from "./userData";

describe("user data paths", () => {
  it("puts a pack's audio under its owner", () => {
    expect(packAudioPath("u1", "pak_a", "ast_b")).toBe("users/u1/packs/pak_a/ast_b");
  });

  it("reads the owner and kind back out of a path", () => {
    expect(parseUserDataPath("users/u1/packs/pak_a/ast_b")).toEqual({
      uid: "u1",
      kind: "packs",
    });
    expect(parseUserDataPath("library/packs/x.json")).toBeNull();
    expect(parseUserDataPath("users/u1/unknown/thing")).toBeNull();
    expect(parseUserDataPath("users/u1/packs")).toBeNull();
  });

  it("keys a ledger entry by the whole object path in one document ID", () => {
    expect(usageDocPath("u1")).toBe("users/u1/usage/current");
    expect(usageObjectDocPath("u1", "users/u1/packs/pak_a/ast_b")).toBe(
      "users/u1/usage/current/objects/users%2Fu1%2Fpacks%2Fpak_a%2Fast_b",
    );
  });
});

describe("accepted audio", () => {
  it("takes the browser's type when it is one we accept", () => {
    expect(importContentType({ name: "a.wav", type: "audio/wav" })).toBe("audio/wav");
    expect(importContentType({ name: "a.mp3", type: "audio/mpeg" })).toBe("audio/mpeg");
  });

  it("falls back to the extension when the browser says nothing", () => {
    expect(importContentType({ name: "Kick.WAV", type: "" })).toBe("audio/wav");
    expect(importContentType({ name: "pad.aif", type: "application/octet-stream" })).toBe(
      "audio/aiff",
    );
  });

  it("refuses what is not audio", () => {
    expect(importContentType({ name: "notes.txt", type: "text/plain" })).toBeNull();
    expect(importContentType({ name: "song.mid", type: "" })).toBeNull();
    expect(importContentType({ name: "x.wav", type: "video/mp4" })).toBeNull();
  });
});

describe("the allowance", () => {
  const usage = (usedBytes: number) => ({ usedBytes, capBytes: 1000 });

  it("warns from 90% and refuses past the cap", () => {
    expect(usageStanding(usage(100))).toBe("ok");
    expect(usageStanding(usage(899), 0)).toBe("ok");
    expect(usageStanding(usage(850), 50)).toBe("near");
    expect(usageStanding(usage(950), 50)).toBe("near");
    expect(usageStanding(usage(950), 51)).toBe("over");
  });

  it("reads sizes the way a producer does", () => {
    expect(formatBytes(512)).toBe("512 bytes");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(12.4 * 1024 ** 2)).toBe("12 MB");
    expect(formatBytes(USER_DATA_CAP_BYTES)).toBe("1 GB");
  });
});

describe("storage.rules", () => {
  // The rules cannot import this module, so they repeat its numbers. These pin
  // the copies together: changing one without the other fails here.
  const rules = readFileSync(resolve(process.cwd(), "storage.rules"), "utf8");

  it("enforces the same cap and per-file limit", () => {
    expect(rules).toContain(`${USER_DATA_CAP_BYTES}`);
    expect(rules).toContain(`${MAX_IMPORT_FILE_BYTES}`);
  });

  it("lifts the allowance for the same claims as hasUnlimitedClaim (GRV-112)", () => {
    for (const claim of [INTERNAL_CLAIM, ADMIN_CLAIM]) {
      expect(rules).toContain(`request.auth.token.get('${claim}', false) == true`);
    }
  });

  it("accepts exactly the same audio types", () => {
    const listed = /contentType in \[([^\]]+)\]/.exec(rules)?.[1] ?? "";
    const types = [...listed.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(types.sort()).toEqual([...IMPORT_CONTENT_TYPES].sort());
  });
});

describe("firestore.rules", () => {
  const rules = readFileSync(resolve(process.cwd(), "firestore.rules"), "utf8");

  it("caps a pack's sounds where the client does", () => {
    expect(rules).toContain(`data.assets.size() <= ${MAX_PACK_SOUNDS}`);
  });
});
