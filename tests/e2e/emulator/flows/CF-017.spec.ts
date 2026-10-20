import { walkthrough } from "../../support/walkthrough";
import { reloadPage } from "../support/reload";
import { expect, type Locator, type Page, test } from "../support/test";
import { backToArrangement, expectView, sequenceView } from "../support/views";

/**
 * `CF-017`: a producer writes a bassline in the piano roll.
 *
 * Read the flow in `docs/core-flows.md`. The numbered comments below are its
 * steps, in its words. This is one of the three acceptance contracts for #450
 * (ARR-010, the piano roll redesign), and it is frozen once it lands: a later
 * PR that changes an assertion here has to say so in its body and justify it.
 *
 * **Revised for #817.** The sequence editor is a view on `2`, not a dialog over
 * the arrangement: opening the clip lands on it (`/sequence`), and step 8
 * leaves it with `1` instead of its close button. Parked at `test.fixme` until
 * #817's stack lands; the PR that closes #817 removes the marker.
 *
 * What the roll has to expose for a person, and this spec, to follow the
 * journey (the same contract is repeated in CF-018 and CF-019):
 *
 *  - **Pitch rows** are buttons in a group named "Pitches", one per visible
 *    row, named by the row's pitch in Ableton numbering (MIDI 60 = C3): "C2",
 *    "D♯2". A sharp may be spelled `♯` or `#`; the helpers read either. A
 *    white-key row name is white with black text, a black-key one the reverse.
 *  - **The ruler** is a group named "Ruler" holding one button per step,
 *    "Step 1" to "Step 16" for a one-bar clip, each one step wide and lined up
 *    with its column. A cell is found where its row name and its ruler step
 *    cross, which is how a person finds it too.
 *  - **Notes** are the options of a listbox named "Notes", each named
 *    "<pitch>, step <n>, <length> step(s)", e.g. "C2, step 1, 2 steps", with
 *    `aria-selected` saying whether it is selected. Reading them back is how
 *    the spec reads the clip.
 *  - **The selection count** reads "<n> selected".
 *  - **The key** is a region named "Key" whose status reads "Chromatic".
 *
 * Runs against the Firestore/Auth emulator because step 8 is a real reload.
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

const rulerSteps = (editor: Locator): Locator =>
  editor.getByRole("group", { name: "Ruler" }).getByRole("button");

const rulerStep = (editor: Locator, step: number): Locator =>
  editor
    .getByRole("group", { name: "Ruler" })
    .getByRole("button", { name: `Step ${step}`, exact: true });

const notes = (editor: Locator): Locator =>
  editor.getByRole("listbox", { name: "Notes" }).getByRole("option");

/** The note that starts at `step` on `pitch`. */
const note = (editor: Locator, pitch: string, step: number): Locator =>
  editor
    .getByRole("listbox", { name: "Notes" })
    .getByRole("option", { name: new RegExp(`^${pitchPattern(pitch)}, step ${step},`) });

const selectionCount = (editor: Locator): Locator => editor.getByText(/^\d+ selected$/);

/** A note's name, normalised to the flow's spelling: `♯`, single spaces. */
const normalise = (name: string): string =>
  name.replace(/#/g, "♯").replace(/\s+/g, " ").trim();

/** Every note in the clip, by name, sorted so order on screen does not matter. */
async function noteNames(editor: Locator): Promise<string[]> {
  const names = await notes(editor).evaluateAll((els) =>
    els.map((el) => el.getAttribute("aria-label") ?? el.textContent ?? ""),
  );
  return names.map(normalise).sort();
}

async function expectNotes(editor: Locator, expected: readonly string[]): Promise<void> {
  await expect.poll(() => noteNames(editor)).toEqual([...expected].sort());
}

async function selectedNoteNames(editor: Locator): Promise<string[]> {
  const names = await editor
    .getByRole("listbox", { name: "Notes" })
    .getByRole("option", { selected: true })
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute("aria-label") ?? el.textContent ?? ""),
    );
  return names.map(normalise).sort();
}

async function box(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const found = await target.boundingBox();
  if (!found) throw new Error("expected a visible element to measure");
  return found;
}

/** The middle of the cell where `pitch`'s row crosses ruler `step`. */
async function cellCentre(
  editor: Locator,
  pitch: string,
  step: number,
): Promise<{ x: number; y: number }> {
  const row = await box(pitchRow(editor, pitch));
  const column = await box(rulerStep(editor, step));
  return { x: column.x + column.width / 2, y: row.y + row.height / 2 };
}

/** How far one step is, in pixels, read off the ruler. */
async function stepWidth(editor: Locator): Promise<number> {
  const first = await box(rulerStep(editor, 1));
  const second = await box(rulerStep(editor, 2));
  return second.x - first.x;
}

async function clickCell(
  page: Page,
  editor: Locator,
  pitch: string,
  step: number,
): Promise<void> {
  const { x, y } = await cellCentre(editor, pitch, step);
  await page.mouse.click(x, y);
}

/** Press at `from`, move to `to` well past any click threshold, let go. */
async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  alt = false,
): Promise<void> {
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
  if (alt) await page.keyboard.up("Alt");
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

const WHITE = "rgb(255, 255, 255)";
const BLACK = "rgb(0, 0, 0)";

/** The clip as the outcome describes it. */
const OUTCOME = [
  "C2, step 1, 2 steps",
  "C2, step 5, 1 step",
  "C2, step 9, 2 steps",
  "C2, step 13, 1 step",
  "F2, step 10, 1 step",
  "F2, step 15, 2 steps",
];

test.describe("CF-017", () => {
  // `test.fixme` until #817's stack lands: the PR that closes it removes this
  // marker in the same diff that makes the flow pass.
  test("a producer writes a bassline in the piano roll", async ({ page }) => {
    const step = walkthrough(page, {
      id: "CF-017",
      title: "A producer writes a bassline in the piano roll",
    });

    // 1. Create a new project and add a synth track. Its clip sits in bar 1.
    //    Open it. The sequence view shows the piano roll: 16 steps, rows
    //    named down the left with white rows for white keys and black rows for
    //    black keys, and the key reads "Chromatic".
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    const projectUrl = page.url();
    await page.getByTestId("arrangement-view-ready").waitFor();
    await page.getByRole("button", { name: "Add synth track" }).click();
    await expect(trackList(page)).toHaveText(["BD", "Synth"]);
    const editor = await openSynthClip(page);
    await expect(rulerSteps(editor)).toHaveCount(16);
    await expect(rulerSteps(editor).last()).toHaveAccessibleName("Step 16");
    await pitchRow(editor, "C2").scrollIntoViewIfNeeded();
    await expect(pitchRow(editor, "C2")).toHaveCSS("background-color", WHITE);
    await expect(pitchRow(editor, "C2")).toHaveCSS("color", BLACK);
    await expect(pitchRow(editor, "C♯2")).toHaveCSS("background-color", BLACK);
    await expect(pitchRow(editor, "C♯2")).toHaveCSS("color", WHITE);
    await expect(
      editor.getByRole("region", { name: "Key" }).getByRole("status"),
    ).toHaveText("Chromatic");
    await step("Open the synth clip in the piano roll");

    // 2. Click the empty cell at C2, step 1. A one-step note appears there,
    //    selected. Click C2 step 5, D♯2 step 9 and G2 step 13. The clip has
    //    four notes.
    await clickCell(page, editor, "C2", 1);
    await expectNotes(editor, ["C2, step 1, 1 step"]);
    await expect(note(editor, "C2", 1)).toHaveAttribute("aria-selected", "true");
    await clickCell(page, editor, "C2", 5);
    await clickCell(page, editor, "D♯2", 9);
    await clickCell(page, editor, "G2", 13);
    await expectNotes(editor, [
      "C2, step 1, 1 step",
      "C2, step 5, 1 step",
      "D♯2, step 9, 1 step",
      "G2, step 13, 1 step",
    ]);
    await step("Click four cells to add four notes");

    // 3. Drag the right edge of the note at C2 step 1 one step to the right.
    //    It is now two steps long. Click the empty cell at F2 step 15. The new
    //    note is also two steps long.
    const oneStep = await stepWidth(editor);
    const first = await box(note(editor, "C2", 1));
    const rightEdge = { x: first.x + first.width - 2, y: first.y + first.height / 2 };
    await drag(page, rightEdge, { x: rightEdge.x + oneStep, y: rightEdge.y });
    await expect(note(editor, "C2", 1)).toHaveAccessibleName(/, 2 steps$/);
    await clickCell(page, editor, "F2", 15);
    await expect(note(editor, "F2", 15)).toHaveAccessibleName(/, 2 steps$/);
    await step("Stretch a note; the next note matches it");

    // 4. Drag the note at D♯2 step 9 up two rows and right one step. It lands
    //    at F2 step 10.
    await drag(
      page,
      await cellCentre(editor, "D♯2", 9),
      await cellCentre(editor, "F2", 10),
    );
    await expectNotes(editor, [
      "C2, step 1, 2 steps",
      "C2, step 5, 1 step",
      "F2, step 10, 1 step",
      "F2, step 15, 2 steps",
      "G2, step 13, 1 step",
    ]);
    await step("Drag a note up two rows and right one step");

    // 5. Press in the empty cell at C2 step 6 and drag left to step 1. The two
    //    C2 notes are selected, and the roll reads "2 selected".
    //
    // A press on an empty cell that then moves is a lasso, not a new note.
    await drag(
      page,
      await cellCentre(editor, "C2", 6),
      await cellCentre(editor, "C2", 1),
    );
    await expect
      .poll(() => selectedNoteNames(editor))
      .toEqual(["C2, step 1, 2 steps", "C2, step 5, 1 step"]);
    await expect(selectionCount(editor)).toHaveText("2 selected");
    await step("Lasso the two C2 notes");

    // 6. Hold Alt (Option on macOS), press on the note at C2 step 1, drag it
    //    right by eight steps and let go. Copies land at C2 steps 9 and 13.
    //    The originals have not moved.
    const from = await cellCentre(editor, "C2", 1);
    await drag(page, from, { x: from.x + 8 * oneStep, y: from.y }, true);
    await expectNotes(editor, [
      "C2, step 1, 2 steps",
      "C2, step 5, 1 step",
      "C2, step 9, 2 steps",
      "C2, step 13, 1 step",
      "F2, step 10, 1 step",
      "F2, step 15, 2 steps",
      "G2, step 13, 1 step",
    ]);
    await step("Alt-drag the pair eight steps to copy it");

    // 7. Double-click the note at G2 step 13. It is deleted.
    await note(editor, "G2", 13).dblclick();
    await expectNotes(editor, OUTCOME);
    await step("Double-click a note to delete it");

    // 8. Press 1 to go back to the arrangement, and reload the page. Open the
    //    clip again.
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

    // Outcome: the clip holds six notes: C2 at steps 1 (two steps long), 5, 9
    // (two steps long) and 13, F2 at step 10, and F2 at step 15 (two steps
    // long).
    await expectNotes(reopened, OUTCOME);
    await step("Reload: the bassline is still there");
  });
});
