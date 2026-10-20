import { describe, expect, it } from "vitest";
import { centredScrollTop, runoutHeight } from "./runout";

// 768x800 as QA measured it: a 200px header inset and 32px at the bottom, so
// the middle of what can be seen is 200 + (800 - 232) / 2 = 484, leaving 316
// below it.
const screen = { viewport: 800, insetTop: 200, insetBottom: 32 };

describe("runoutHeight (GRV-128)", () => {
  it("leaves only the room the question needs to reach the middle", () => {
    // 50px of the skip link below the question's centre: 266px more to find.
    expect(runoutHeight({ ...screen, questionCentre: 500, contentEnd: 550 })).toBe(266);
  });

  it("leaves none when the content below already fills it", () => {
    expect(runoutHeight({ ...screen, questionCentre: 500, contentEnd: 900 })).toBe(0);
  });

  it("follows the viewport", () => {
    const tall = runoutHeight({
      ...screen,
      viewport: 1200,
      questionCentre: 500,
      contentEnd: 550,
    });
    expect(tall).toBe(466);
  });

  it("rounds up, so the question never stops a pixel short", () => {
    expect(runoutHeight({ ...screen, questionCentre: 500.5, contentEnd: 550 })).toBe(267);
  });
});

describe("centredScrollTop (GRV-128)", () => {
  it("puts the region's middle where a question's sat", () => {
    // 500-700 has its middle at 600; the visible middle is 484 down the screen.
    expect(centredScrollTop({ ...screen, top: 500, bottom: 700 })).toBe(116);
  });

  it("puts a region taller than the visible area just under the header", () => {
    expect(centredScrollTop({ ...screen, top: 500, bottom: 1200 })).toBe(300);
  });

  it("never scrolls above the page's top", () => {
    expect(centredScrollTop({ ...screen, top: 250, bottom: 300 })).toBe(0);
  });
});
