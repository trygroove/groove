import { expect, type Locator, type Page, test } from "./support/test";

// #879: inserting a loop through Add loop made its new audio track, but left
// the editor on the track selected before, so the instrument view went on
// showing the old track's instrument. A track you just added is the one you
// want to see, so the new loop track is selected, and the view stays put.

const library = (page: Page): Locator =>
  page.getByRole("region", { name: "Library", exact: true });
const rail = (page: Page): Locator =>
  page.getByRole("main").getByRole("list", { name: "Tracks", exact: true });

test("inserting a loop from Add loop selects its new track", async ({ page }) => {
  await page.goto("/projects");
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByTestId("arrangement-view-ready").waitFor();
  await page
    .getByRole("navigation", { name: "Views" })
    .getByRole("link", { name: "Instrument" })
    .click();

  // The add-track unit follows the rail's list rather than sitting in it (#76).
  await page
    .getByRole("main")
    .getByRole("group", { name: "Add track", exact: true })
    .getByRole("button", { name: "Add loop from library" })
    .click();
  await expect(library(page)).toBeVisible();
  await expect(library(page).getByRole("heading", { name: "Loops" })).toBeVisible();

  // Whichever loop the library lists first: its name is read off the row, so
  // the test keeps working when the delivered library changes. A row offers
  // Insert once it is selected.
  const sounds = library(page).getByRole("list", { name: "Sounds", exact: true });
  const first = sounds.getByRole("button", { name: /^Audition / }).first();
  const loopName = ((await first.getAttribute("aria-label")) ?? "").replace(
    /^Audition /,
    "",
  );
  expect(loopName).not.toBe("");
  // Pinned by the name just read, not by position: the library fills in as its
  // packs arrive, so "the first row" can be a different loop by the time of the
  // click, and then `Insert <loopName>` never appears.
  await sounds.getByRole("button", { name: `Audition ${loopName}`, exact: true }).click();
  const insert = library(page).getByRole("button", { name: `Insert ${loopName}` });
  await insert.click();
  await expect(library(page)).toHaveCount(0);

  // Still the instrument view, now on the new loop track.
  await expect(
    page.getByRole("navigation", { name: "Views" }).getByRole("link", {
      name: "Instrument",
    }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    rail(page).getByRole("button", { name: `Edit ${loopName}`, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("region", { name: `${loopName} loop` })).toBeVisible();
});
