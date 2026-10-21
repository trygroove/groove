import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { packVersion } from "../../domain/entities";
import type { AssetId, ClipId, PackId, TrackId } from "../../domain/ids";
import MissingSounds, {
  type MissingSoundsReport,
  missingSoundCount,
} from "./MissingSounds";

const version = packVersion("1.0.0");

/** One personal sound deleted from its pack, and a withdrawn factory pack of two. */
const report: MissingSoundsReport = {
  missingAssets: [
    {
      assetId: "ast_tape" as AssetId,
      name: "tape kick",
      packId: "pak_mine" as PackId,
      version,
      availableVersions: [version],
      tracks: [{ id: "trk_drums" as TrackId, name: "Drums" }],
      clips: [],
    },
  ],
  missingPacks: [],
  withdrawnPacks: [
    {
      packId: "pak_factory" as PackId,
      version,
      reason: "pack_unavailable",
      assets: [
        { id: "ast_sub" as AssetId, name: "Deep Sub" },
        { id: "ast_loop" as AssetId, name: "Rolling Bassline" },
      ],
      tracks: [{ id: "trk_bass" as TrackId, name: "Bass" }],
      clips: [{ id: "clp_bass" as ClipId, name: "Bass line" }],
    },
  ],
};

describe("MissingSounds", () => {
  it("counts every sound a report names, personal and withdrawn alike", () => {
    expect(missingSoundCount(report)).toBe(3);
    expect(missingSoundCount({ ...report, missingAssets: [], withdrawnPacks: [] })).toBe(
      0,
    );
  });

  it("names each sound from a withdrawn library pack with what it leaves silent", () => {
    render(() => (
      <MissingSounds
        report={report}
        packName={(id) => (id === "pak_mine" ? "Mine" : null)}
      />
    ));
    const region = screen.getByRole("region", { name: "Missing sounds" });
    expect(region).toHaveTextContent(
      "3 sounds this project uses are missing from your library.",
    );
    const lines = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(lines).toEqual([
      "tape kick was deleted from Mine. Track: Drums.",
      "Deep Sub was in a library pack that is no longer available. Track: Bass. Clip: Bass line.",
      "Rolling Bassline was in a library pack that is no longer available. Track: Bass. Clip: Bass line.",
    ]);
  });
});
