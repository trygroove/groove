import { walkthrough } from "../../support/walkthrough";
import { reloadPage } from "../support/reload";
import { expect, type Locator, type Page, test } from "../support/test";
import { backToArrangement, expectView, sequenceView } from "../support/views";

/**
 * `CF-019`: a producer copies, pastes and transforms notes from the keyboard.
 *
 * Read the flow in `docs/core-flows.md`. The numbered comments below are its
 * steps, in its words. This is one of the three acceptance contracts for #450
 * (ARR-010, the piano roll redesign), and it is frozen once it lands: a later
 * PR that changes an assertion here has to say so in its body and justify it.
 *
 * #647 changed step 6: Double used to refuse copies that would not fit in the
 * clip, and now makes room for them by doubling the clip.
 *
 * **Revised for #817.** The sequence editor is a view on `2`, not a dialog over
 * the arrangement: opening the clip lands on it (`/sequence`), and step 7
 * leaves it with `1` rather than Esc, which closes dialogs (#650). Parked at
 * `test.fixme` (on the describe, so the body keeps its indentation) until
 * #817's stack lands; the PR that closes #817 removes the marker.
 *
 * The roll's pitch rows, ruler, notes and selection count are found exactly as
 * in CF-017 (read its header for that contract). On top of it, this flow needs:
 *
 *  - **The ruler's step buttons set the insert marker** when clicked
 *    ("Step 9"), which is where a paste lands.
 *  - **The Transform panel**, a region named "Transform", whose scope label
 *    reads "All <n> notes" or "<n> selected notes", with a field labelled
 *    "Semitones" whose value reads "+12 st", and the buttons "Transpose" and
 *    "Double". The ruler has one step button per 1/16 of the clip, so its
 *    last button says how long the clip is.
 *
 * Every key goes through the shortcut registry, so the spec presses them on
 * the page, never on a particular element. `ControlOrMeta` is ⌘ on macOS and
 * Ctrl elsewhere, as the flow says.
 *
 * Runs against the Firestore/Auth emulator because step 7 is a real reload.
 */

/** Musical time at 192 PPQ in the alpha's fixed 4/4 (`src/domain/time.ts`). */
const TICKS_PER_BAR = 4 * 192;

/** The arrangement's interaction canvas: a `<canvas>`, so a class (CF-016). */
const timeline = (page: Page): Locator => page.locator(".arrangement-layer-interactive");

/** The arrangement's accessible mirror of the track list, top to bottom. */
const trackList = (page: Page): Locator =>
  page.getByRole("list", { name: "Arrangement tracks" }).getByRole("listitem");

/** A pitch name as a pattern that reads a sharp spelled `♯` or `#`. */
const pitchPattern = (pitch: string): string => pitch.replace("♯", "[♯#]");

/** A pitch row's name in the gutter; an `Off` tag may follow the pitch. */
const pitchRow = (editor: Locator, pitch: string): Locator =>
  editor
    .getByRole("group", { name: "Pitches" })
    .getByRole("button", { name: new RegExp(`^${pitchPattern(pitch)}(\\W*Off)?$`) });

const rulerStep = (editor: Locator, step: number): Locator =>
  editor
    .getByRole("group", { name: "Ruler" })
    .getByRole("button", { name: `Step ${step}`, exact: true });

const notesList = (editor: Locator): Locator =>
  editor.getByRole("listbox", { name: "Notes" });

const selectionCount = (editor: Locator): Locator => editor.getByText(/^\d+ selected$/);

const transformPanel = (editor: Locator): Locator =>
  editor.getByRole("region", { name: "Transform" });

/** A name, normalised to the flow's spelling: `♯`, single spaces. */
const normalise = (name: string): string =>
  name.replace(/#/g, "♯").replace(/\s+/g, " ").trim();

const sortedNamesOf = async (controls: Locator): Promise<string[]> =>
  (
    await controls.evaluateAll((els) =>
      els.map((el) => el.getAttribute("aria-label") ?? el.textContent ?? ""),
    )
  )
    .map(normalise)
    .sort();

/** Every note in the clip, by name, sorted so order on screen does not matter. */
async function expectNotes(editor: Locator, expected: readonly string[]): Promise<void> {
  await expect
    .poll(() => sortedNamesOf(notesList(editor).getByRole("option")))
    .toEqual([...expected].sort());
}

/** Exactly these notes are selected. */
async function expectSelected(
  editor: Locator,
  expected: readonly string[],
): Promise<void> {
  await expect
    .poll(() => sortedNamesOf(notesList(editor).getByRole("option", { selected: true })))
    .toEqual([...expected].sort());
}

async function box(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const found = await target.boundingBox();
  if (!found) throw new Error("expected a visible element to measure");
  return found;
}

/** Click the middle of the cell where `pitch`'s row crosses ruler `step`. */
async function clickCell(
  page: Page,
  editor: Locator,
  pitch: string,
  step: number,
): Promise<void> {
  const row = await box(pitchRow(editor, pitch));
  const column = await box(rulerStep(editor, step));
  await page.mouse.click(column.x + column.width / 2, row.y + row.height / 2);
}

/** Open the synth clip in bar 1: row 1, under the starter "BD" (CF-016). */
async function openSynthClip(page: Page): Promise<Locator> {
  const root = page.getByTestId("arrangement-view-ready");
  const pixelsPerTick = Number(await root.getAttribute("data-pixels-per-tick"));
  const rulerHeight = Number(await root.getAttribute("data-ruler-height"));
  const rowHeight = Number(await root.getAttribute("data-row-height"));
  expect(pixelsPerTick).toBeGreaterThan(0);
  expect(rowHeight).toBeGreaterThan(0);
  await timeline(page).dblclick({
    position: {
      x: 0.5 * TICKS_PER_BAR * pixelsPerTick,
      y: rulerHeight + 1.5 * rowHeight,
    },
  });
  await expectView(page, "Sequence");
  const editor = sequenceView(page);
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("region", { name: /^Piano roll\b/ })).toBeVisible();
  return editor;
}

const ORIGINALS = ["C2, step 1, 1 step", "G2, step 3, 1 step"];
const COPIES = ["C2, step 9, 1 step", "G2, step 11, 1 step"];
const TRANSPOSED = ["C3, step 1, 1 step", "G3, step 3, 1 step"];
const DOUBLED = ["C3, step 17, 1 step", "G3, step 19, 1 step"];

test.describe("CF-019", () => {
  test("a producer copies, pastes and transforms notes from the keyboard", async ({
    page,
  }) => {
    const step = walkthrough(page, {
      id: "CF-019",
      title: "A producer copies, pastes and transforms notes from the keyboard",
    });

    // 1. Create a new project, add a synth track and open its clip. Add notes
    //    at C2 step 1 and G2 step 3.
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    const projectUrl = page.url();
    await page.getByTestId("arrangement-view-ready").waitFor();
    await page.getByRole("button", { name: "Add synth track" }).click();
    await expect(trackList(page)).toHaveText(["BD", "Synth"]);
    const editor = await openSynthClip(page);
    await clickCell(page, editor, "C2", 1);
    await clickCell(page, editor, "G2", 3);
    await expectNotes(editor, ORIGINALS);
    await step("Add notes at C2 step 1 and G2 step 3");

    // 2. Press ⌘A (Ctrl+A on Windows and Linux). The roll reads "2 selected".
    //    Press ⌘C. Click the ruler at step 9, then press ⌘V. Copies land at C2
    //    step 9 and G2 step 11, and the copies are now the selection.
    await page.keyboard.press("ControlOrMeta+a");
    await expect(selectionCount(editor)).toHaveText("2 selected");
    await page.keyboard.press("ControlOrMeta+c");
    await rulerStep(editor, 9).click();
    await page.keyboard.press("ControlOrMeta+v");
    await expectNotes(editor, [...ORIGINALS, ...COPIES]);
    await expectSelected(editor, COPIES);
    await step("Copy, click the ruler at step 9, paste");

    // 3. Press ↑. The copies move up one row, to C♯2 step 9 and G♯2 step 11.
    //    Undo. They are back at C2 and G2.
    await page.keyboard.press("ArrowUp");
    await expectNotes(editor, [
      ...ORIGINALS,
      "C♯2, step 9, 1 step",
      "G♯2, step 11, 1 step",
    ]);
    await step("Press ↑: the copies move up a row");
    await page.keyboard.press("ControlOrMeta+z");
    await expectNotes(editor, [...ORIGINALS, ...COPIES]);
    await step("Undo: the copies are back");

    // 4. Press Delete. The copies are gone and two notes remain.
    await page.keyboard.press("Delete");
    await expectNotes(editor, ORIGINALS);
    await step("Press Delete: the copies are gone");

    // 5. Nothing is selected now. The Transform panel reads "All 2 notes".
    //    The Transpose field reads "+12 st". Press Transpose. The notes are
    //    now at C3 step 1 and G3 step 3.
    await expectSelected(editor, []);
    await expect(
      transformPanel(editor).getByText("All 2 notes", { exact: true }),
    ).toBeVisible();
    await expect(transformPanel(editor).getByLabel("Semitones")).toHaveValue("+12 st");
    await transformPanel(editor)
      .getByRole("button", { name: /^Transpose\b/ })
      .click();
    await expectNotes(editor, TRANSPOSED);
    await step("Transpose the whole clip up an octave");

    // 6. Press Double. The one-bar clip becomes two bars long, and copies land
    //    at C3 step 17 and G3 step 19.
    await transformPanel(editor)
      .getByRole("button", { name: /^Double\b/ })
      .click();
    await expectNotes(editor, [...TRANSPOSED, ...DOUBLED]);
    await expect(rulerStep(editor, 32)).toBeVisible();
    await expect(rulerStep(editor, 33)).toHaveCount(0);
    await step("Double makes the clip two bars");

    // 7. Press 1. The editor goes back to the arrangement. Reload the page and
    //    open the clip again.
    //
    // The save status is how the editor reports that a revision-checked write
    // completed, so the reload tests persistence rather than a race (CF-016).
    await backToArrangement(page);
    await expect(page.locator(".save-status")).toHaveText("Saved", { timeout: 10_000 });
    await reloadPage(page);
    await expect(page).toHaveURL(projectUrl);
    await page.getByTestId("arrangement-view-ready").waitFor();
    await expect(trackList(page)).toHaveText(["BD", "Synth"]);
    const reopened = await openSynthClip(page);

    // Outcome: the clip is two bars long and holds C3 at steps 1 and 17 and G3
    // at steps 3 and 19.
    await expectNotes(reopened, [...TRANSPOSED, ...DOUBLED]);
    await expect(rulerStep(reopened, 32)).toBeVisible();
    await step("Reload: both bars are kept");
  });
});
