import { walkthrough } from "../../support/walkthrough";
import {
  ASSISTANT_CHORD,
  arrangement,
  boxOf,
  drag,
  newProject,
  panel,
  panelButton,
  resizeEdge,
} from "../support/assistant";
import { expect, test } from "../support/test";

/**
 * `CF-028`: the assistant stays where a producer puts it.
 *
 * Read the flow in `docs/core-flows.md`. The numbered comments are its steps,
 * in its words. This is an acceptance contract for #849 (AI-004a), and it is
 * frozen once it lands: a later PR that changes an assertion here has to say
 * so in its body and justify it.
 *
 * **Locators.** Every assistant locator is assumed from #849 and its reference
 * design, and listed in `../support/assistant.ts`. "Click the bar" in step 4
 * is a click on the minimised panel's title, clear of its buttons.
 *
 * **Sizes.** The flow names no pixels, so neither does the spec: a drag of
 * 120px must grow the panel by most of that, and every later size is compared
 * with the one the drag produced. That leaves the default size, the limits
 * and the drag's exact gain to the component tests.
 *
 * **What "remembered" means here.** The panel's mode and sizes live on this
 * device, not in the project, so the reload in step 8 is the proof. No
 * project edit is made, and there is nothing for Firestore to hold.
 *
 * Out of scope, per the flow: another browser or device, keyboard resizing,
 * the reset, the limits, shortcut clashes, and the conversation (CF-027).
 */

const DRAG = 120;

test.describe("CF-028", () => {
  test("the assistant stays where a producer puts it", async ({ page }) => {
    const step = walkthrough(page, {
      id: "CF-028",
      title: "The assistant stays where a producer puts it",
    });
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("the page has no viewport");

    // 1. Create a new project. It opens on the arrangement.
    await newProject(page);
    await expect(arrangement(page)).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    const fullWidth = (await boxOf(arrangement(page), "the arrangement")).width;

    // 2. Press Ctrl+K (⌘K on a Mac). The assistant opens floating over the
    //    bottom-right corner of the editor.
    await page.keyboard.press(ASSISTANT_CHORD);
    await expect(panel(page)).toBeVisible();
    const floating = await boxOf(panel(page), "the assistant");
    expect(floating.x + floating.width).toBeGreaterThan(viewport.width * 0.9);
    expect(floating.y + floating.height).toBeGreaterThan(viewport.height - 2);
    // Floating covers the editor; it does not push it aside.
    expect((await boxOf(arrangement(page), "the arrangement")).width).toBe(fullWidth);
    await step("Ctrl+K opens it floating");

    // 3. Drag its top edge up. It grows taller and stays at the bottom of the
    //    window.
    await drag(page, resizeEdge(page, "Resize height"), 0, -DRAG);
    const taller = await boxOf(panel(page), "the assistant");
    expect(taller.height).toBeGreaterThan(floating.height + DRAG * 0.8);
    expect(taller.y + taller.height).toBeGreaterThan(viewport.height - 2);
    await step("Drag the top edge: taller");

    // 4. Press Minimise. It shrinks to a bar at the bottom-right that still
    //    names the assistant. Click the bar. It floats again, at the height
    //    you set.
    await panelButton(page, "Minimise").click();
    const bar = await boxOf(panel(page), "the minimised assistant");
    expect(bar.height).toBeLessThan(64);
    expect(bar.y + bar.height).toBeGreaterThan(viewport.height - 2);
    await expect(panel(page)).toContainText("Cue");
    await step("Minimise to a bar");
    await panel(page).click({ position: { x: 48, y: bar.height / 2 } });
    expect((await boxOf(panel(page), "the assistant")).height).toBe(taller.height);
    await step("Click the bar: floating again");

    // 5. Press Dock. It becomes a column down the right edge, and the
    //    arrangement narrows so that nothing is under it.
    await panelButton(page, "Dock to the right").click();
    const docked = await boxOf(panel(page), "the docked assistant");
    expect(docked.x + docked.width).toBeGreaterThan(viewport.width - 2);
    expect(docked.height).toBeGreaterThan(viewport.height * 0.7);
    const narrowed = await boxOf(arrangement(page), "the arrangement");
    expect(narrowed.x + narrowed.width).toBeLessThanOrEqual(docked.x + 1);
    await step("Dock: the arrangement makes room");

    // 6. Drag its left edge to the left. The column widens, and the
    //    arrangement narrows with it.
    await drag(page, resizeEdge(page, "Resize width"), -DRAG, 0);
    const wider = await boxOf(panel(page), "the docked assistant");
    expect(wider.width).toBeGreaterThan(docked.width + DRAG * 0.8);
    const narrower = await boxOf(arrangement(page), "the arrangement");
    expect(narrower.x + narrower.width).toBeLessThanOrEqual(wider.x + 1);
    await step("Drag the left edge: wider");

    // 7. Press Close. The column goes, and the arrangement fills the window
    //    again. Press Ctrl+K. The assistant comes back docked, at the width
    //    you set.
    await panelButton(page, "Close").click();
    await expect(panel(page)).toHaveCount(0);
    await expect
      .poll(async () => (await boxOf(arrangement(page), "the arrangement")).width)
      .toBe(fullWidth);
    await page.keyboard.press(ASSISTANT_CHORD);
    await expect(panel(page)).toBeVisible();
    expect((await boxOf(panel(page), "the docked assistant")).width).toBe(wider.width);
    await step("Close, then Ctrl+K: docked again");

    // 8. Reload the page. The assistant is docked at the same width, as you
    //    left it. Press Float. It floats at the height you set in step 3.
    await page.reload();
    await expect(arrangement(page)).toBeVisible();
    await expect(panel(page)).toBeVisible();
    const reloaded = await boxOf(panel(page), "the docked assistant");
    expect(reloaded.width).toBe(wider.width);
    expect(reloaded.x + reloaded.width).toBeGreaterThan(viewport.width - 2);
    await panelButton(page, "Float").click();
    expect((await boxOf(panel(page), "the assistant")).height).toBe(taller.height);
    await step("Reload: as you left it");
  });
});
