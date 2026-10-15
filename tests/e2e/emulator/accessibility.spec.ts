import AxeBuilder from "@axe-core/playwright";
import { assistantButton, newProject, panel, panelButton } from "./support/assistant";
import { soundList } from "./support/library";
import { expect, type Page, test } from "./support/test";
import { pressView, type ViewName } from "./support/views";

/**
 * The automated half of the accessibility pass (#76): axe-core over every
 * surface the issue names (the dashboard, the editor's five views, the
 * shortcut guide, the assistant and the Export dialog), each in the state a
 * producer first meets it. The manual half, the keyboard and screen-reader
 * scripts axe cannot run, is `docs/accessibility.md`.
 *
 * The bar is WCAG 2.1 A and AA plus axe's best practices (heading order,
 * landmarks, scrollable regions). WCAG 2.2's 24px target size is not in it:
 * the editor is a dense instrument panel by design (docs/design.md), and that
 * trade is the accessibility doc's to explain, not this check's to waive one
 * control at a time.
 *
 * A failure names the rule and the elements, so the fix starts from the
 * message rather than from a re-run with a debugger.
 */

const STANDARD = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

/**
 * Wait until no CSS transition is running. A button's `background-color`
 * eases over 0.1s (src/app.css) while its text colour flips at once, so a
 * pressed toggle is black text on the old dark fill for that moment, and axe
 * reads it as a contrast failure (GRV-87). WebKit, on a slow runner, is where
 * the scan lands inside that window. Only transitions are awaited: the
 * assistant's blinking caret is an infinite animation that never finishes.
 */
async function settleTransitions(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

/** Run axe over the page as it stands, and fail with what it found. */
async function expectAccessible(page: Page, surface: string): Promise<void> {
  await settleTransitions(page);
  const { violations } = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
  const found = violations.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ${violation.help}\n${violation.nodes
        .map((node) => `    ${node.target.join(" ")}`)
        .join("\n")}`,
  );
  expect(found, `${surface} has accessibility violations`).toEqual([]);
}

const VIEWS: readonly ViewName[] = ["Sequence", "Instrument", "Library", "Mixer"];

test.describe("accessibility (axe)", { tag: "@sanity" }, () => {
  test("the dashboard, empty, listing a project, and confirming a delete", async ({
    page,
  }) => {
    await page.goto("/projects");
    await expect(page.getByText("No projects yet")).toBeVisible();
    await expectAccessible(page, "the empty dashboard");

    await newProject(page);
    await page.goto("/projects");
    const remove = page.getByRole("button", { name: /^Delete / }).first();
    await expect(remove).toBeVisible();
    await expectAccessible(page, "the dashboard");

    await remove.click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await expectAccessible(page, "the delete confirmation");
  });

  test("the editor's five views", async ({ page }) => {
    await newProject(page);
    await expectAccessible(page, "the arrangement");
    for (const view of VIEWS) {
      await pressView(page, view);
      // The library lists its sounds once the pack index has loaded.
      if (view === "Library") {
        await expect(soundList(page).getByRole("listitem").first()).toBeVisible();
      }
      await expectAccessible(page, `the ${view.toLowerCase()} view`);
    }
  });

  // A muted track, strip or pad and a bypassed device recede, but each is
  // still a control a producer operates, so its text has to read at AA too.
  // They dimmed with opacity before, which axe only sees once they are muted.
  test("a muted track, strip and pad, and a bypassed device", async ({ page }) => {
    await newProject(page);
    const muteTrack = page.getByRole("button", { name: "Mute BD" }).first();
    await muteTrack.click();
    await expect(muteTrack).toHaveAttribute("aria-pressed", "true");
    await expectAccessible(page, "the arrangement with a muted track");

    await pressView(page, "Mixer");
    await expect(page.getByRole("button", { name: "Mute BD" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expectAccessible(page, "the mixer with a muted strip");

    await pressView(page, "Instrument");
    const padMute = page.getByRole("table").getByRole("button", { name: "Mute BD" });
    await padMute.click();
    await expect(padMute).toHaveAttribute("aria-pressed", "true");

    const chain = page.getByRole("region", { name: "Device chain" });
    await chain
      .getByRole("group", { name: "Add device" })
      .getByRole("button", { name: "Add overdrive device" })
      .click();
    const bypass = chain
      .getByRole("list", { name: "Device chain" })
      .getByRole("listitem")
      .first()
      .getByRole("button", { name: /^Bypass/ });
    await bypass.click();
    await expect(bypass).toHaveAttribute("aria-pressed", "true");
    await expectAccessible(
      page,
      "the instrument view with a muted pad and a bypassed device",
    );
  });

  test("the shortcut guide, the assistant and the Export dialog", async ({ page }) => {
    await newProject(page);

    await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await expectAccessible(page, "the shortcut guide");
    await page.keyboard.press("Escape");

    await assistantButton(page).click();
    await expect(panel(page)).toBeVisible();
    await expectAccessible(page, "the floating assistant");
    await panelButton(page, "Dock to the right").click();
    await expectAccessible(page, "the docked assistant");
    await panelButton(page, "Close").click();
    await expect(panel(page)).toHaveCount(0);

    await page.getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Export", exact: true })).toBeVisible();
    await expectAccessible(page, "the Export dialog");
  });
});
