import { seedDisclosureAnswered } from "./support/assistant";
import { expect, type Locator, type Page, test } from "./support/test";

/**
 * The assistant panel's place on the page (#849): what is drawn over it and
 * what it is drawn over. Stacking and hit-testing are layout, which jsdom does
 * not do, so they are asserted here in a real browser.
 *
 *  - The app's bottom-right chrome (the release badge, the telemetry
 *    disclosure) is fixed at z-index 1000. It must stand clear of the panel,
 *    so a click aimed at any of the panel's buttons lands on that button.
 *  - A modal dialog (Export) is on top of the panel, floating or docked, and
 *    nothing in the panel can be reached while it is open.
 */

const ASSISTANT_CHORD = process.platform === "darwin" ? "Meta+k" : "Control+k";

async function openEditor(page: Page): Promise<void> {
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "New Project" }).click();
  await expect(page).toHaveURL(/\/projects\/prj_/);
  await expect(page.getByTestId("arrangement-view-ready")).toBeVisible();
}

const panel = (page: Page): Locator => page.locator(".assistant-panel");
const panelButton = (page: Page, name: string): Locator =>
  panel(page).getByRole("button", { name, exact: true });

/** What a pointer at (x, y) would hit: true when it is `target` or inside it. */
async function hits(target: Locator, x: number, y: number): Promise<boolean> {
  return target.evaluate(
    (element, at) => {
      const hit = document.elementFromPoint(at.x, at.y);
      return hit !== null && element.contains(hit);
    },
    { x, y },
  );
}

/** Every one of the panel's buttons answers at its centre and its top edge. */
async function buttonsAnswer(page: Page, mode: string): Promise<void> {
  const buttons = panel(page).getByRole("button");
  const count = await buttons.count();
  expect(count, `the ${mode} panel's buttons`).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    const name = await button.getAttribute("aria-label");
    const box = await button.boundingBox();
    if (!box) throw new Error(`${name} has no box`);
    const centreX = box.x + box.width / 2;
    expect(
      await hits(button, centreX, box.y + box.height / 2),
      `${mode}: ${name} centre`,
    ).toBe(true);
    expect(await hits(button, centreX, box.y + 1), `${mode}: ${name} top edge`).toBe(
      true,
    );
  }
}

test.describe("assistant panel", () => {
  test("no app chrome is drawn over its controls, in any of its homes", async ({
    page,
    invitedProducer,
  }) => {
    // The composer is checked, so the disclosure has been answered (GRV-8).
    await seedDisclosureAnswered(invitedProducer.uid);
    await openEditor(page);
    await page.keyboard.press(ASSISTANT_CHORD);
    await expect(panel(page)).toHaveAttribute("data-mode", "floating");
    await buttonsAnswer(page, "floating");
    // The composer's corner too, where the badge and the disclosure sat.
    const composer = panel(page).locator(".assistant-panel-composer");
    const composerBox = await composer.boundingBox();
    if (!composerBox) throw new Error("the composer has no box");
    expect(
      await hits(
        composer,
        composerBox.x + composerBox.width - 4,
        composerBox.y + composerBox.height - 4,
      ),
    ).toBe(true);

    await panelButton(page, "Minimise").click();
    await expect(panel(page)).toHaveAttribute("data-mode", "minimised");
    await buttonsAnswer(page, "minimised");

    await panelButton(page, "Dock to the right").click();
    await expect(panel(page)).toHaveAttribute("data-mode", "docked");
    await buttonsAnswer(page, "docked");

    // Closed, the chrome goes back to its corner.
    await panelButton(page, "Close").click();
    await expect(panel(page)).toHaveCount(0);
    const badge = page.locator(".release-badge");
    if ((await badge.count()) > 0) {
      const box = await badge.boundingBox();
      const viewport = page.viewportSize();
      if (!box || !viewport) throw new Error("no badge box or viewport");
      expect(viewport.width - (box.x + box.width)).toBeLessThan(12);
    }
  });

  for (const mode of ["floating", "docked"] as const) {
    test(`a modal dialog is on top of the ${mode} panel, which cannot be reached`, async ({
      page,
    }) => {
      await openEditor(page);
      await page.keyboard.press(ASSISTANT_CHORD);
      if (mode === "docked") await panelButton(page, "Dock to the right").click();
      await expect(panel(page)).toHaveAttribute("data-mode", mode);
      const close = panelButton(page, "Close");
      const box = await close.boundingBox();
      if (!box) throw new Error("the panel's Close has no box");

      await page.getByRole("button", { name: "Export", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Export" });
      await expect(dialog).toBeVisible();
      await expect(panel(page)).toHaveAttribute("inert", "");

      // Where the panel's Close was, the pointer meets the dialog's layer.
      const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      expect(await hits(close, centre.x, centre.y)).toBe(false);
      const backdrop = page.locator(".dialog-backdrop");
      expect(await hits(backdrop, centre.x, centre.y)).toBe(true);
      // And everywhere the dialog is drawn, it is the dialog that answers.
      const dialogBox = await dialog.boundingBox();
      if (!dialogBox) throw new Error("the Export dialog has no box");
      for (const x of [dialogBox.x + 8, dialogBox.x + dialogBox.width - 8]) {
        expect(await hits(dialog, x, dialogBox.y + dialogBox.height / 2)).toBe(true);
      }
      // The keyboard cannot reach it either.
      for (let index = 0; index < 30; index += 1) {
        await page.keyboard.press("Tab");
        expect(
          await panel(page).evaluate((element) =>
            element.contains(document.activeElement),
          ),
        ).toBe(false);
      }

      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(panel(page)).not.toHaveAttribute("inert", "");
      expect(await hits(close, centre.x, centre.y)).toBe(true);
    });
  }

  test("grows to 1000px, and stays on screen when the window shrinks", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 1200 });
    await openEditor(page);
    await page.keyboard.press(ASSISTANT_CHORD);
    const edge = panel(page).getByRole("separator");
    await expect(edge).toHaveAttribute("aria-valuemax", "1000");
    await edge.focus();
    for (let step = 0; step < 8; step += 1) await page.keyboard.press("Shift+ArrowUp");
    await expect(edge).toHaveAttribute("aria-valuenow", "1000");
    expect((await panel(page).boundingBox())?.height).toBe(1000);

    await page.setViewportSize({ width: 360, height: 500 });
    await expect(edge).toHaveAttribute("aria-valuemax", "450");
    const box = await panel(page).boundingBox();
    if (!box) throw new Error("the panel has no box");
    // All of it on screen, the resize edge clear of the header.
    expect(box.y).toBeGreaterThanOrEqual(50);
    expect(box.y + box.height).toBeLessThanOrEqual(500);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    await buttonsAnswer(page, "floating in a small window");
  });
});
