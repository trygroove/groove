import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* Read from disk: jsdom draws no layout, so pin the declarations themselves. */
const css = readFileSync(join(__dirname, "ArrangementView.css"), "utf8");

function declarationsOf(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&");
  const pattern = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`, "g");
  return [...css.matchAll(pattern)].flatMap((match) =>
    (match[1] ?? "")
      .split(";")
      .map((declaration) => declaration.trim())
      .filter(Boolean),
  );
}

describe("loop brace focus ring (GRV-225)", () => {
  it("is two-tone, so it shows on the brace's white fill while looping is on", () => {
    // The canvas fills the brace with --color-accent while looping, so an
    // outline in that same colour vanishes. An inner ring in the on-accent
    // colour sits just inside it and shows on either ground.
    const rule = declarationsOf(".arrangement-loop-brace:focus-visible");
    expect(rule).toContain("outline: 2px solid var(--color-accent)");
    expect(rule).toContain("box-shadow: inset 0 0 0 4px var(--color-on-accent)");
  });
});
