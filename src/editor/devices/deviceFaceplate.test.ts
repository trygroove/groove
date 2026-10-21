import { describe, expect, it } from "vitest";
import { deviceTypeDefinition, deviceTypes } from "../../domain/devices";
import { bareParameterId, type ParameterDefinition } from "../../domain/parameters";
import { deviceGroups } from "./deviceFaceplate";

describe("deviceGroups (#447)", () => {
  it("places every parameter of every device exactly once, in a named group", () => {
    for (const { type, parameters } of deviceTypes()) {
      const groups = deviceGroups(type, parameters);
      const placed = groups.flatMap((group) => group.parameters.map((p) => p.id));
      expect(placed.sort()).toEqual(parameters.map((p) => p.id).sort());
      expect(groups.map((group) => group.title)).not.toContain("More");
    }
  });

  it("orders a compressor's banks from dynamics to gain", () => {
    const groups = deviceGroups(
      "compressor",
      deviceTypeDefinition("compressor")?.parameters ?? [],
    );
    expect(
      groups.map((g) => [g.title, g.parameters.map((p) => bareParameterId(p.id))]),
    ).toEqual([
      ["Dynamics", ["threshold", "ratio"]],
      ["Timing", ["attack", "release"]],
      ["Gain", ["makeup", "wet"]],
    ]);
  });

  it("keeps a parameter no group names in a trailing More group", () => {
    const extra = { id: "filter.drift", label: "Drift" } as ParameterDefinition;
    const groups = deviceGroups("filter", [
      ...(deviceTypeDefinition("filter")?.parameters ?? []),
      extra,
    ]);
    expect(groups.at(-1)).toEqual({ title: "More", parameters: [extra] });
  });
});
