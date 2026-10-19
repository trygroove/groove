import { walkthrough } from "../../support/walkthrough";
import { reloadPage } from "../support/reload";
import { expect, type Locator, type Page, test } from "../support/test";
import { expectView, pressView, sequenceView } from "../support/views";

/**
 * `CF-020`: a producer fills a drum row from the Generate panel.
 *
 * Read the flow in `docs/core-flows.md`. The numbered comments below are its
 * steps, in its words. It is the acceptance contract for #643 (the step
 * sequencer revamp), and it is frozen once it lands: a later PR that changes
 * an assertion here has to say so in its body and justify it.
 *
 * **Revised for #817.** The sequence editor is a view on `2`, not a dialog over
 * the arrangement: opening the clip lands on it (`/sequence`), and step 7 goes
 * straight from it to the instrument view with `3` instead of closing it first.
 * Parked at `test.fixme` until #817's stack lands; the PR that closes #817
 * removes the marker.
 *
 * What the step grid has to expose for a person, and this spec, to follow
 * the journey:
 *
 *  - **Rows** are buttons in a group named "Rows", one per pad, named by the
 *    pad ("BD", "Pad 2"). The selected row's button is `aria-pressed="true"`.
 *  - **Steps** are buttons named "<pad>, step <n>, on|off", as today
 *    (CF-001), so the spec reads a row by which of its steps are on.
 *  - **The Generate panel** is a region named "Generate". It shows
 *    "into <pad>" for the selected row. Its presets are buttons named by the
 *    pattern ("Offbeats"). The Euclidean generator has spinbuttons named
 *    "Hits" and "Steps" and a button named "Write Euclidean".
 *
 * Runs against the Firestore/Auth emulator because step 8 is a real reload.
 */

/** Musical time at 192 PPQ in the alpha's fixed 4/4 (`src/domain/time.ts`). */
const TICKS_PER_BAR = 4 * 192;

/** A one-bar clip: the starter's length. */
const STEPS = 16;

/** The dock's links between views (#304, see CF-008 and CF-013). */
const viewLink = (page: Page, name: "Arrangement" | "Instrument"): Locator =>
  page.getByRole("navigation", { name: "Views" }).getByRole("link", { name });

/** The arrangement's interaction canvas: a `<canvas>`, so a class (CF-016). */
const timeline = (page: Page): Locator => page.locator(".arrangement-layer-interactive");

const rowName = (editor: Locator, pad: string): Locator =>
  editor
    .getByRole("group", { name: "Rows" })
    .getByRole("button", { name: pad, exact: true });

const generatePanel = (editor: Locator): Locator =>
  editor.getByRole("region", { name: "Generate" });

/** The steps of `pad`'s row that are on, 1-based and in order. */
async function stepsOn(editor: Locator, pad: string): Promise<number[]> {
  const on: number[] = [];
  for (let step = 1; step <= STEPS; step++) {
    const cell = editor.getByRole("button", {
      name: new RegExp(`^${pad}, step ${step}, (on|off)$`),
    });
    const name = (await cell.getAttribute("aria-label")) ?? "";
    if (name.endsWith(", on")) on.push(step);
  }
  return on;
}

async function expectRow(
  editor: Locator,
  pad: string,
  expected: readonly number[],
): Promise<void> {
  await expect.poll(() => stepsOn(editor, pad)).toEqual([...expected]);
}

/** Open the drum clip in bar 1 of the only track, "BD" (CF-001). */
async function openDrumClip(page: Page): Promise<Locator> {
  const root = page.getByTestId("arrangement-view-ready");
  await root.waitFor();
  const pixelsPerTick = Number(await root.getAttribute("data-pixels-per-tick"));
  const rulerHeight = Number(await root.getAttribute("data-ruler-height"));
  const rowHeight = Number(await root.getAttribute("data-row-height"));
  expect(pixelsPerTick).toBeGreaterThan(0);
  expect(rowHeight).toBeGreaterThan(0);
  await timeline(page).dblclick({
    position: {
      x: 0.5 * TICKS_PER_BAR * pixelsPerTick,
      y: rulerHeight + 0.5 * rowHeight,
    },
  });
  await expectView(page, "Sequence");
  const editor = sequenceView(page);
  await expect(editor).toBeVisible();
  return editor;
}

const KICK = [1, 5, 9, 13];
const OFFBEATS = [3, 7, 11, 15];
/** 3 hits over 8 steps (the tresillo), repeated through the bar. */
const EUCLID_3_OF_8 = [1, 4, 7, 9, 12, 15];

test.describe("CF-020", () => {
  // `test.fixme` until #817's stack lands: the PR that closes it removes this
  // marker in the same diff that makes the flow pass.
  test("a producer fills a drum row from the Generate panel", async ({ page }) => {
    const step = walkthrough(page, {
      id: "CF-020",
      title: "A producer fills a drum row from the Generate panel",
    });

    // 1. Create a new project. Go to the instrument view for the starter "BD"
    //    track and add a pad. It is called "Pad 2".
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    const projectUrl = page.url();
    await page.getByTestId("arrangement-view-ready").waitFor();
    await viewLink(page, "Instrument").click();
    await expect(page).toHaveURL(/\/projects\/prj_[^/]+\/instrument$/);
    await page.getByRole("button", { name: "Add pad to BD" }).click();
    await expect(page.getByRole("button", { name: "Audition Pad 2" })).toBeVisible();
    await step("Add a second pad to the starter drum machine");

    // 2. Go to the arrangement and open the "BD" clip. The step grid shows a
    //    "BD" row with steps 1, 5, 9 and 13 on, and an empty "Pad 2" row.
    await viewLink(page, "Arrangement").click();
    const editor = await openDrumClip(page);
    await expect(rowName(editor, "BD")).toBeVisible();
    await expect(rowName(editor, "Pad 2")).toBeVisible();
    await expectRow(editor, "BD", KICK);
    await expectRow(editor, "Pad 2", []);
    await step("Open the BD clip: a kick row and an empty Pad 2 row");

    // 3. Click the "Pad 2" row's name. It becomes the selected row, and the
    //    Generate panel reads "into Pad 2".
    await rowName(editor, "Pad 2").click();
    await expect(rowName(editor, "Pad 2")).toHaveAttribute("aria-pressed", "true");
    await expect(rowName(editor, "BD")).not.toHaveAttribute("aria-pressed", "true");
    await expect(generatePanel(editor)).toContainText("into Pad 2");
    await step("Click the Pad 2 row's name to select it");

    // 4. Press Offbeats. The "Pad 2" row has steps 3, 7, 11 and 15 on. The
    //    "BD" row has not changed.
    await generatePanel(editor).getByRole("button", { name: "Offbeats" }).click();
    await expectRow(editor, "Pad 2", OFFBEATS);
    await expectRow(editor, "BD", KICK);
    await step("Press Offbeats: the row fills with offbeats");

    // 5. Set the Euclidean generator to 3 hits over 8 steps and press Write.
    //    The "Pad 2" row now has steps 1, 4, 7, 9, 12 and 15 on, and nothing
    //    else. The offbeats are gone. The "BD" row has not changed.
    //
    // Steps first, so Hits is never asked to exceed it.
    await generatePanel(editor).getByRole("spinbutton", { name: "Steps" }).fill("8");
    await generatePanel(editor).getByRole("spinbutton", { name: "Hits" }).fill("3");
    await generatePanel(editor).getByRole("button", { name: "Write Euclidean" }).click();
    await expectRow(editor, "Pad 2", EUCLID_3_OF_8);
    await expectRow(editor, "BD", KICK);
    await step("Write a 3-over-8 Euclidean rhythm over the offbeats");

    // 6. Undo once. The "Pad 2" row is back to the offbeats. Redo. It is back
    //    to the Euclidean pattern.
    await page.keyboard.press("ControlOrMeta+Z");
    await expectRow(editor, "Pad 2", OFFBEATS);
    await page.keyboard.press("ControlOrMeta+Shift+Z");
    await expectRow(editor, "Pad 2", EUCLID_3_OF_8);
    await step("Undo and redo the generate as one step");

    // 7. Press 3. The instrument view shows the "BD" drum machine, and "Pad 2"
    //    is the selected pad.
    await pressView(page, "Instrument");
    await expect(page.getByRole("region", { name: "Drum machine: BD" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Pad 2 pad" })).toBeVisible();
    await step("The instrument view has Pad 2 selected too");

    // 8. Reload the page. Go to the arrangement and open the "BD" clip again.
    //
    // The save status is how the editor reports that a revision-checked write
    // completed, so the reload tests persistence rather than a race (CF-016).
    await expect(page.locator(".save-status")).toHaveText("Saved", { timeout: 10_000 });
    await reloadPage(page);
    await viewLink(page, "Arrangement").click();
    await expect(page).toHaveURL(projectUrl);
    const reopened = await openDrumClip(page);

    // Outcome: the "BD" row has steps 1, 5, 9 and 13 on, and the "Pad 2" row
    // has steps 1, 4, 7, 9, 12 and 15 on.
    await expectRow(reopened, "BD", KICK);
    await expectRow(reopened, "Pad 2", EUCLID_3_OF_8);
    await step("Reload: both rows are still there");
  });
});
