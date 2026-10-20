import { expect, type Locator, type Page, test } from "./support/test";

/**
 * One Escape closes one surface, the topmost (GRV-148).
 *
 * The footer's Privacy panel, the Keyboard shortcuts guide and the
 * arrangement's selection each answer Escape through their own controller on
 * the window. A component test fires its key from inside one script, so the
 * microtask checkpoint a browser runs between two listeners of one press never
 * happens there; this presses Escape in a real browser, where a surface the
 * first listener closed is already gone when the next one looks.
 */

const TICKS_PER_BAR = 768;

const announcement = (page: Page): Locator =>
  page.getByTestId("arrangement-selection-live");

/** Click the first track row in the middle of bar 1, where the starter clip is. */
async function selectStarterClip(page: Page): Promise<void> {
  const root = page.getByTestId("arrangement-view-ready");
  const pixelsPerTick = Number(await root.getAttribute("data-pixels-per-tick"));
  const rulerHeight = Number(await root.getAttribute("data-ruler-height"));
  const rowHeight = Number(await root.getAttribute("data-row-height"));
  await page.locator(".arrangement-layer-interactive").click({
    position: { x: 0.5 * TICKS_PER_BAR * pixelsPerTick, y: rulerHeight + rowHeight / 2 },
  });
  await expect(announcement(page)).toHaveText("Selected clip on BD, bar 1");
}

async function openStudio(page: Page): Promise<void> {
  await page.goto("/projects");
  await page.getByRole("button", { name: "New Project" }).click();
  await expect(page).toHaveURL(/\/projects\/prj_/);
  await page.getByTestId("arrangement-view-ready").waitFor();
}

/**
 * Opens the footer Privacy panel and returns its `<details>`.
 *
 * `keepFocus` opens it with a click that leaves focus where it was, as a click
 * on a `<summary>` does in Safari and on macOS: the arrangement keeps focus,
 * so its own Escape (clear the selection) is live under the panel's.
 */
async function openPrivacy(page: Page, keepFocus = false): Promise<Locator> {
  const summary = page.locator("summary", { hasText: "Privacy" });
  if (keepFocus) await summary.dispatchEvent("click");
  else await summary.click();
  const panel = page.locator("details.telemetry-disclosure");
  await expect(panel).toHaveAttribute("open", "");
  // The panel's Escape mounts on its `toggle` event, a task after `open`.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => setTimeout(done))),
  );
  return panel;
}

test.describe("one Escape closes only the top layer (GRV-148)", () => {
  test("the shortcuts guide over the Privacy panel closes alone", async ({ page }) => {
    await openStudio(page);
    const panel = await openPrivacy(page);

    await page.keyboard.press("?");
    const guide = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(guide).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(guide).toHaveCount(0);
    await expect(panel).toHaveAttribute("open", "");

    await page.keyboard.press("Escape");
    await expect(panel).not.toHaveAttribute("open", "");
    await expect(page.locator("summary", { hasText: "Privacy" })).toBeFocused();
  });

  test("Escape on the Privacy panel keeps the selected clip", async ({ page }) => {
    await openStudio(page);
    await selectStarterClip(page);
    const panel = await openPrivacy(page, true);

    await page.keyboard.press("Escape");
    await expect(panel).not.toHaveAttribute("open", "");
    await expect(announcement(page)).toHaveText("Selected clip on BD, bar 1");
  });
});
