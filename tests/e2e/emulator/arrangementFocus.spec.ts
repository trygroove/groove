import { newProject } from "./support/assistant";
import { expect, type Page, test } from "./support/test";

/**
 * GRV-221: the arrangement's two off-screen Tab stops, the "Select <track>"
 * buttons and the "Clips" listbox, each show where focus is.
 */

const loopButton = (page: Page) =>
  page.getByRole("button", { name: "Add loop from library" });

async function tabFrom(
  page: Page,
  from: () => ReturnType<Page["locator"]>,
  presses: number,
) {
  await from().focus();
  for (let i = 0; i < presses; i += 1) await page.keyboard.press("Tab");
}

const ringOf = (page: Page) =>
  page.locator(".arrangement-body").evaluate((el) => {
    const s = getComputedStyle(el, "::after");
    return { style: s.borderTopStyle, width: s.borderTopWidth };
  });

test.describe("arrangement keyboard focus is visible", () => {
  test("the hidden track button and clip list each show focus", async ({ page }) => {
    await newProject(page);
    await tabFrom(page, () => loopButton(page), 1);
    const select = page.locator("button[data-track-select]").first();
    await expect(select).toBeFocused();
    const header = page.locator(".arrangement-header-row").first();
    const headerOutline = await header.evaluate((el) => {
      const s = getComputedStyle(el);
      return { outline: s.outlineStyle, shadow: s.boxShadow };
    });
    expect(
      headerOutline.outline !== "none" || headerOutline.shadow !== "none",
      "focused track select must be mirrored on its header",
    ).toBe(true);

    await page.keyboard.press("Tab");
    await expect(page.getByRole("listbox", { name: "Clips" })).toBeFocused();
    expect((await ringOf(page)).style).toBe("solid");
  });
});
