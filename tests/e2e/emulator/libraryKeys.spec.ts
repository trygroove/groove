import {
  backToInstrument,
  library,
  newProjectOnInstrumentView,
  openPadSlot,
  railButton,
  readout,
  slotSound,
  soundList,
} from "./support/library";
import { expect, type Page, test } from "./support/test";
import { expectView } from "./support/views";

// #860: the library's Enter (insert) and Space (audition again) let the
// browser's default run too, so the focused button was pressed as well.
// Asserted in a real browser, because only a real one turns a key into a click
// on whatever is focused.
//
// Since #817 the library is the view on `4`. Enter inserts and goes back to
// the instrument; Shift+Enter inserts and stays so another sound can be tried:
// the insert shows as the sound in the slot, and the library is still the view
// you are on.

/** Select the second sound in the list with the keyboard, as a producer would. */
async function selectSecondSound(page: Page): Promise<string> {
  await expect(soundList(page).getByRole("listitem").nth(1)).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const hearing = (await readout(page, "Hearing").textContent()) ?? "";
  return hearing.replace(/^Hearing/, "").trim();
}

/** The insert landed, and the library is still the view you are on. */
async function expectInsertedAndStayed(page: Page, name: string): Promise<void> {
  await expect(readout(page, "In the slot")).toContainText(name);
  await page.waitForTimeout(300);
  await expectView(page, "Library");
  await backToInstrument(page);
  await expect.poll(() => slotSound(page, "BD")).toBe(name);
}

test.describe("library keys", () => {
  test("Enter inserts the selected sound and goes back, once", async ({ page }) => {
    await newProjectOnInstrumentView(page);
    await openPadSlot(page, "BD");
    const name = await selectSecondSound(page);

    await page.keyboard.press("Enter");

    // Back on the instrument with the sound in the slot, and the slot focus
    // lands on does not take the same Enter and open the library again (#860).
    await expectView(page, "Instrument");
    await page.waitForTimeout(300);
    await expect(library(page)).toHaveCount(0);
    await expect.poll(() => slotSound(page, "BD")).toBe(name);
  });

  test("Shift+Enter on a clicked row inserts it and the library stays", async ({
    page,
  }) => {
    await newProjectOnInstrumentView(page);
    await openPadSlot(page, "BD");
    const row = soundList(page)
      .getByRole("button", { name: /^Audition / })
      .nth(2);
    const name = ((await row.getAttribute("aria-label")) ?? "").replace(/^Audition /, "");
    await row.click();

    await page.keyboard.press("Shift+Enter");

    await expectInsertedAndStayed(page, name);
  });

  test("Space auditions again and leaves the library open", async ({ page }) => {
    await newProjectOnInstrumentView(page);
    await openPadSlot(page, "BD");
    await selectSecondSound(page);

    await page.keyboard.press("Space");

    await page.waitForTimeout(300);
    await expect(library(page)).toBeVisible();
  });

  // #961: a held key auto-repeats, and each repeat of a shortcut that does not
  // repeat was ignored without suppressing its default, so the browser pressed
  // the focused button anyway. Playwright's second `keyboard.down` of a key
  // still down is a `repeat: true` keydown, just like an OS auto-repeat.
  test("held Space auditions the selection and never presses a focused button", async ({
    page,
  }) => {
    await newProjectOnInstrumentView(page);
    await openPadSlot(page, "BD");
    // A clicked row keeps focus while the arrows move the selection on.
    const rows = soundList(page).getByRole("button", { name: /^Audition / });
    await rows.nth(0).click();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    const selected = (await readout(page, "Hearing").textContent()) ?? "";

    await page.keyboard.down(" ");
    await page.keyboard.down(" ");
    await page.keyboard.down(" ");
    await page.keyboard.up(" ");

    await page.waitForTimeout(300);
    await expect(library(page)).toBeVisible();
    await expect(readout(page, "Hearing")).toHaveText(selected);
  });

  test("held Space with focus on Close leaves the library open", async ({ page }) => {
    await newProjectOnInstrumentView(page);
    await openPadSlot(page, "BD");
    await selectSecondSound(page);

    await page.keyboard.down(" ");
    await page.keyboard.down(" ");
    await page.keyboard.up(" ");

    await page.waitForTimeout(300);
    await expect(library(page)).toBeVisible();
  });

  // The first Enter inserts and closes the library, returning focus to the slot
  // button; the repeats that follow land there, where no shortcut maps Enter,
  // and once pressed the library reopened.
  test("held Enter inserts once and the library stays closed", async ({ page }) => {
    await newProjectOnInstrumentView(page);
    await openPadSlot(page, "BD");
    const rows = soundList(page).getByRole("button", { name: /^Audition / });
    await rows.nth(0).click();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    const name = ((await readout(page, "Hearing").textContent()) ?? "")
      .replace(/^Hearing/, "")
      .trim();

    await page.keyboard.down("Enter");
    await expect(library(page)).toBeHidden();
    await page.keyboard.down("Enter");
    await page.keyboard.down("Enter");
    await page.keyboard.up("Enter");

    await expect.poll(() => slotSound(page, "BD")).toBe(name);
    await page.waitForTimeout(300);
    await expect(library(page)).toBeHidden();
  });

  test("a focused rail button keeps Enter for itself", async ({ page }) => {
    await newProjectOnInstrumentView(page);
    await openPadSlot(page, "BD");
    await selectSecondSound(page);
    const before = (await readout(page, "In the slot").textContent()) ?? "";

    await railButton(page, "Browse packs").focus();
    await page.keyboard.press("Enter");

    await expect(railButton(page, "Browse packs")).toHaveAttribute("aria-current", /.+/);
    await expect(library(page)).toBeVisible();
    await expect(readout(page, "In the slot")).toHaveText(before);
  });

  // #873: similar sounds took none of the library's keys, so the arrows left
  // Hearing on the source sound and S never grew the trail.
  test("the arrows and S work in similar sounds", async ({ page }) => {
    await newProjectOnInstrumentView(page);
    await openPadSlot(page, "BD");
    await selectSecondSound(page);
    await page.keyboard.press("s");
    const results = library(page).getByRole("list", { name: "Similar sounds" });
    const result = results.getByRole("button", { name: /^Audition / }).nth(1);
    await expect(result).toBeVisible();
    const name = ((await result.getAttribute("aria-label")) ?? "").replace(
      /^Audition /,
      "",
    );

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(readout(page, "Hearing")).toContainText(name);

    await page.keyboard.press("s");
    const trail = library(page).getByRole("navigation", { name: "Similar sounds trail" });
    await expect(trail.getByRole("button")).toHaveCount(2);
    await expect(trail.getByRole("button").nth(1)).toHaveText(name);
  });
});

// GRV-164: the keys sheet is drawn over the library, but the genre menu (a
// higher z-index) stayed on top of it, and a click on the sheet's area reached
// the genre checkboxes behind it. The sheet opening closes the menu, and what
// sits under the sheet is never the topmost element there.
test.describe("library keys over the genre menu", () => {
  test("opening the keys sheet closes the genre menu and covers the button behind it", async ({
    page,
  }) => {
    await newProjectOnInstrumentView(page);
    await openPadSlot(page, "BD");
    const genre = library(page).getByRole("button", { name: /^Any genre\b/ });
    await genre.click();
    const menu = library(page).getByRole("group", { name: "Genres" });
    await expect(menu).toBeVisible();

    await page.keyboard.press("?");

    await expect(page.getByRole("dialog", { name: "Library keys" })).toBeVisible();
    await expect(menu).toHaveCount(0);
    const box = await genre.boundingBox();
    if (!box) throw new Error("the genre button has no box on screen");
    const topmost = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest(".library-keys") !== null,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    expect(topmost).toBe(true);
  });

  test("the genre menu cannot be opened behind the keys sheet", async ({ page }) => {
    await newProjectOnInstrumentView(page);
    await openPadSlot(page, "BD");
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Library keys" })).toBeVisible();

    await page.keyboard.press("g");

    await expect(library(page).getByRole("group", { name: "Genres" })).toHaveCount(0);
  });
});
