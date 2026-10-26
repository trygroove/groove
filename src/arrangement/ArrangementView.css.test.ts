import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "ArrangementView.css"), "utf8");

describe("ArrangementView.css focus frame", () => {
  it("frames the arrangement while a visually hidden track-select control has focus (GRV-223)", () => {
    const frame = css.match(/([^{}]*)\.arrangement-body::after\s*\{[^}]*border:/);
    expect(frame?.[1]).toContain("[data-track-select]:focus-visible");
  });
});
