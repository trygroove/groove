import type { Route } from "@playwright/test";
import { walkthrough } from "../support/walkthrough";
import { newProject, reloadSaved } from "./support/assistant";
import { expect, type Page, test } from "./support/test";

/**
 * One project open in two tabs (GRV-88), saved through the emulator. A change
 * saved in one shows in the other without a reload, and the other's next edit
 * is made on top of it rather than over it, even when it was still being
 * written as the other tab saved. An edit or an undo whose subject the other
 * tab deleted is dropped or refused with a toast, never left failing silently.
 */

const tempo = (page: Page) => page.getByRole("spinbutton", { name: "Tempo (BPM)" });
const muteBd = (page: Page) =>
  page.getByRole("button", { name: "Mute BD", exact: true }).first();
const saveStatus = (page: Page) => page.locator(".save-status");

/**
 * Holds every Firestore commit this tab sends until the returned call: its
 * save is in flight, not yet landed, while the other tab saves.
 */
async function holdCommits(page: Page): Promise<() => Promise<void>> {
  const held: Route[] = [];
  let holding = true;
  const pattern = /documents:commit/;
  await page.route(pattern, async (route) => {
    if (holding) held.push(route);
    else await route.continue();
  });
  return async () => {
    holding = false;
    for (const route of held.splice(0)) await route.continue();
  };
}

async function openSecondTab(page: Page, projectUrl: string): Promise<Page> {
  const other = await page.context().newPage();
  await other.goto(projectUrl);
  await other.getByTestId("arrangement-view-ready").waitFor();
  return other;
}

test.describe("one project in two tabs", () => {
  test("a change saved in one tab shows in the other, and both tabs' edits are kept", async ({
    page,
  }) => {
    const projectUrl = await newProject(page);
    const other = await openSecondTab(page, projectUrl);
    try {
      await tempo(other).fill("140");
      await tempo(other).blur();
      await expect(saveStatus(other)).toHaveText("Saved", { timeout: 10_000 });

      // Tab A shows the new tempo without a reload.
      await expect(tempo(page)).toHaveValue("140", { timeout: 10_000 });

      // Its own next edit is made on top of B's, not over it.
      await muteBd(page).click();
      await expect(muteBd(page)).toHaveAttribute("aria-pressed", "true");
      await reloadSaved(page);
      await other.reload();
      for (const tab of [page, other]) {
        await tab.getByTestId("arrangement-view-ready").waitFor();
        await expect(tempo(tab)).toHaveValue("140");
        await expect(muteBd(tab)).toHaveAttribute("aria-pressed", "true");
      }
    } finally {
      await other.close();
    }
  });

  test("an edit in flight is replayed over the other tab's save, or dropped with a toast", async ({
    page,
  }) => {
    const step = walkthrough(page, {
      id: "grv88-drop",
      title: "An unsaved edit the other tab made impossible",
    });
    const projectUrl = await newProject(page);
    const other = await openSecondTab(page, projectUrl);
    try {
      // Tab A changes the tempo and mutes BD, and its save is held in flight.
      const release = await holdCommits(page);
      await tempo(page).fill("90");
      await tempo(page).blur();
      await muteBd(page).click();
      await expect(saveStatus(page)).toHaveText(/Saving/, { timeout: 10_000 });

      // Tab B deletes BD and saves first.
      await other.getByRole("button", { name: "Delete BD" }).first().click();
      await expect(saveStatus(other)).toHaveText("Saved", { timeout: 10_000 });

      // A's write is refused; it takes B's change in, keeps its tempo edit
      // and drops the mute, whose track is gone, saying so.
      await release();
      await expect(page.getByRole("status").filter({ hasText: "discarded" })).toHaveText(
        /A change you made was discarded because the project changed in another tab\./,
        { timeout: 10_000 },
      );
      await expect(muteBd(page)).toHaveCount(0);
      await expect(tempo(page)).toHaveValue("90");
      await expect(saveStatus(page)).toHaveText("Saved", { timeout: 10_000 });
      await step("Tab A dropped its mute of the track tab B deleted, and is saved");

      await other.reload();
      await other.getByTestId("arrangement-view-ready").waitFor();
      await expect(tempo(other)).toHaveValue("90");
      await expect(muteBd(other)).toHaveCount(0);
    } finally {
      await other.close();
    }
  });

  test("an undo whose subject another tab deleted is refused with a toast", async ({
    page,
  }) => {
    const step = walkthrough(page, {
      id: "grv88-undo",
      title: "An undo that no longer applies",
    });
    const projectUrl = await newProject(page);
    await muteBd(page).click();
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 10_000 });

    const other = await openSecondTab(page, projectUrl);
    try {
      await other.getByRole("button", { name: "Delete BD" }).first().click();
      await expect(saveStatus(other)).toHaveText("Saved", { timeout: 10_000 });
      await expect(muteBd(page)).toHaveCount(0, { timeout: 10_000 });

      await page.getByRole("button", { name: /^Undo/ }).click();
      await expect(page.getByRole("status").filter({ hasText: "Can't undo" })).toHaveText(
        /Can't undo: that changed in another tab\./,
      );
      // Nothing changed: the track stays deleted, and the editor stays saved.
      await expect(muteBd(page)).toHaveCount(0);
      await expect(saveStatus(page)).toHaveText("Saved");
      await step("Undo in tab A after tab B deleted the track it muted");
    } finally {
      await other.close();
    }
  });
});
