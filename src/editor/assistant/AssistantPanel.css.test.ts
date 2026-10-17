import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* Read from disk, as src/theme.test.ts does: the unit suite stubs CSS out, so
   jsdom cannot tell us what size a rule resolves to. What we can pin is the
   declaration itself. */
const css = readFileSync(join(__dirname, "AssistantPanel.css"), "utf8");

/** The declarations of every rule whose selector list is exactly `selector`. */
function declarationsOf(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`, "g");
  return [...css.matchAll(pattern)].flatMap((match) =>
    (match[1] ?? "")
      .split(";")
      .map((declaration) => declaration.trim())
      .filter(Boolean),
  );
}

describe("assistant question options (GRV-100)", () => {
  it("stacks the options one per row, each filling the card's width", () => {
    // A wrapping row sized each chip to its label, so answer 2 came out
    // narrower than the others. In a column each option stretches to the
    // list, which is the card's width. jsdom draws no layout, so pin the rules.
    expect(declarationsOf(".assistant-ask-options")).toEqual(
      expect.arrayContaining(["display: flex", "flex-direction: column"]),
    );
    expect(declarationsOf(".assistant-ask-options")).not.toContain("flex-wrap: wrap");
    expect(declarationsOf(".assistant-ask-option")).toContain("width: 100%");
  });

  it("pins the speaker and the Suggested tag to the option's right edge", () => {
    // After the label they sat at a different x in each option. The text
    // column takes the free space, so both sit together at the end of the
    // row and line up down the card.
    expect(declarationsOf(".assistant-ask-text")).toContain("flex: 1");
    expect(declarationsOf(".assistant-ask-listen")).toContain("flex: none");
    expect(declarationsOf(".assistant-ask-suggested")).toContain("flex: none");
  });
});

describe("assistant composer type", () => {
  it("sets the composer input to the base size the assistant text inherits", () => {
    // The message and reply paragraphs set no size of their own, so they
    // render at the document's base size (`--font-size-base`, 14px).
    const setsOwnSize = (selector: string) =>
      declarationsOf(selector).some((declaration) =>
        declaration.startsWith("font-size:"),
      );
    expect(setsOwnSize(".assistant-message p")).toBe(false);
    expect(setsOwnSize(".assistant-reply p")).toBe(false);

    expect(declarationsOf(".assistant-panel-input")).toContain(
      "font-size: var(--font-size-base)",
    );
  });

  it("styles no placeholder size of its own, so the placeholder matches the field", () => {
    // The placeholder takes the textarea's font; a separate size rule would
    // need its own check.
    expect(css).not.toMatch(/::placeholder/);
  });
});

describe("assistant composer height (GRV-115)", () => {
  it("rests at two lines with no fixed height, so it can grow with its text", () => {
    const declarations = declarationsOf(".assistant-panel-input");
    expect(declarations.some((d) => d.startsWith("height:"))).toBe(false);
    expect(declarations).toContain("overflow-y: auto");
  });
});
