import { walkthrough } from "../../support/walkthrough";
import { reloadPage } from "../support/reload";
import { expect, type Locator, type Page, test } from "../support/test";
import { backToArrangement, expectView, sequenceView } from "../support/views";

/**
 * `CF-018`: a producer picks a key and pulls stray notes into it.
 *
 * Read the flow in `docs/core-flows.md`. The numbered comments below are its
 * steps, in its words. This is one of the three acceptance contracts for #450
 * (ARR-010, the piano roll redesign), and it is frozen once it lands: a later
 * PR that changes an assertion here has to say so in its body and justify it.
 *
 * **Revised for #817.** The sequence editor is a view on `2`, not a dialog over
 * the arrangement: opening the clip lands on it (`/sequence`), and step 6
 * leaves it with `1` instead of its close button. Parked at `test.fixme` until
 * #817's stack lands; the PR that closes #817 removes the marker.
 *
 * The roll's pitch rows, ruler and notes are found exactly as in CF-017 (read
 * its header for that contract). On top of it, this flow needs:
 *
 *  - **The Key panel**, a region named "Key", whose status reads the key:
 *    "Chromatic", or "<root> <scale>" such as "C minor".
 *  - **Root buttons**: a group named "Root" in that panel holding the twelve
 *    roots, "C" to "B", with the chosen one `aria-pressed="true"`.
 *  - **The scale switch**: a group named "Scale" in that panel holding one
 *    button per scale, named as the issue lists them ("Chromatic", "Minor", …).
 *  - **An Off row** is a pitch row whose name ends in "Off", e.g. "F♯2 Off".
 *  - **The Transform panel**, a region named "Transform", holding the button
 *    "Quantize to scale".
 *
 * Which scale note Quantize to scale picks is the implementer's rule and out of
 * scope, so the spec asserts only that the stray note lands on a C minor row
 * at the step it started on, and is the only note that moved.
 *
 * Runs against the Firestore/Auth emulator because step 6 is a real reload.
 */

/** Musical time at 192 PPQ in the alpha's fixed 4/4 (`src/domain/time.ts`). */
const TICKS_PER_BAR = 4 * 192;

/** The pitch classes of C minor, spelled as the flow spells them. */
const C_MINOR = new Set(["C", "D", "D♯", "F", "G", "G♯", "A♯"]);

/** The arrangement's interaction canvas: a `<canvas>`, so a class (CF-016). */
const timeline = (page: Page): Locator => page.locator(".arrangement-layer-interactive");

/** The arrangement's accessible mirror of the track list, top to bottom. */
const trackList = (page: Page): Locator =>
  page.getByRole("list", { name: "Arrangement tracks" }).getByRole("listitem");

/** A pitch name as a pattern that reads a sharp spelled `♯` or `#`. */
const pitchPattern = (pitch: string): string => pitch.replace("♯", "[♯#]");

const pitchRows = (editor: Locator): Locator =>
  editor.getByRole("group", { name: "Pitches" }).getByRole("button");

/** A pitch row's name in the gutter; an `Off` tag may follow the pitch. */
const pitchRow = (editor: Locator, pitch: string): Locator =>
  editor
    .getByRole("group", { name: "Pitches" })
    .getByRole("button", { name: new RegExp(`^${pitchPattern(pitch)}(\\W*Off)?$`) });

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

const keyPanel = (editor: Locator): Locator =>
  editor.getByRole("region", { name: "Key" });
const keyReadout = (editor: Locator): Locator => keyPanel(editor).getByRole("status");
const rootButtons = (editor: Locator): Locator =>
  keyPanel(editor).getByRole("group", { name: "Root" }).getByRole("button");
const rootButton = (editor: Locator, root: string): Locator =>
  keyPanel(editor)
    .getByRole("group", { name: "Root" })
    .getByRole("button", { name: root, exact: true });
const scaleButton = (editor: Locator, scale: string): Locator =>
  keyPanel(editor)
    .getByRole("group", { name: "Scale" })
    .getByRole("button", { name: scale, exact: true });

const quantizeToScale = (editor: Locator): Locator =>
  editor
    .getByRole("region", { name: "Transform" })
    .getByRole("button", { name: /^Quantize to scale\b/ });

/** A name, normalised to the flow's spelling: `♯`, single spaces. */
const normalise = (name: string): string =>
  name.replace(/#/g, "♯").replace(/\s+/g, " ").trim();

const namesOf = async (controls: Locator): Promise<string[]> =>
  (
    await controls.evaluateAll((els) =>
      els.map((el) => el.getAttribute("aria-label") ?? el.textContent ?? ""),
    )
  ).map(normalise);

/** Every note in the clip, by name, sorted so order on screen does not matter. */
const noteNames = async (editor: Locator): Promise<string[]> =>
  (await namesOf(notes(editor))).sort();

async function expectNotes(editor: Locator, expected: readonly string[]): Promise<void> {
  await expect.poll(() => noteNames(editor)).toEqual([...expected].sort());
}

/** A pitch's class: "F♯2" -> "F♯". */
const pitchClassOf = (pitch: string): string => pitch.replace(/-?\d+$/, "");

/** The rows the gutter shows, split into the pitch and whether it is marked Off. */
async function rows(editor: Locator): Promise<{ pitch: string; off: boolean }[]> {
  return (await namesOf(pitchRows(editor))).map((name) => {
    const match = name.match(/^([A-G]♯?-?\d+)\W*(Off)?$/);
    if (!match) throw new Error(`"${name}" is not a pitch row name`);
    return { pitch: match[1], off: match[2] === "Off" };
  });
}

/**
 * Every row is a C minor row, except the ones named in `offRows`, which are
 * shown and marked Off. With no `offRows`, nothing is marked Off.
 */
async function expectCMinorRows(
  editor: Locator,
  offRows: readonly string[] = [],
): Promise<void> {
  await expect
    .poll(async () => {
      const shown = await rows(editor);
      return {
        stray: shown
          .filter((row) => !row.off && !C_MINOR.has(pitchClassOf(row.pitch)))
          .map((row) => row.pitch),
        off: shown.filter((row) => row.off).map((row) => row.pitch),
      };
    })
    .toEqual({ stray: [], off: [...offRows] });
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

test.describe("CF-018", () => {
  // `test.fixme` until #817's stack lands: the PR that closes it removes this
  // marker in the same diff that makes the flow pass.
  test("a producer picks a key and pulls stray notes into it", async ({ page }) => {
    const step = walkthrough(page, {
      id: "CF-018",
      title: "A producer picks a key and pulls stray notes into it",
    });

    // 1. Create a new project, add a synth track and open its clip. The key
    //    reads "Chromatic", the root buttons are disabled, and Quantize to
    //    scale is disabled.
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    const projectUrl = page.url();
    await page.getByTestId("arrangement-view-ready").waitFor();
    await page.getByRole("button", { name: "Add synth track" }).click();
    await expect(trackList(page)).toHaveText(["BD", "Synth"]);
    const editor = await openSynthClip(page);
    await expect(keyReadout(editor)).toHaveText("Chromatic");
    await expect(rootButtons(editor)).toHaveCount(12);
    for (const button of await rootButtons(editor).all())
      await expect(button).toBeDisabled();
    await expect(quantizeToScale(editor)).toBeDisabled();
    await step("The key starts at Chromatic");

    // 2. Add notes at C2 step 1, F♯2 step 5 and D♯2 step 9.
    await clickCell(page, editor, "C2", 1);
    await clickCell(page, editor, "F♯2", 5);
    await clickCell(page, editor, "D♯2", 9);
    await expectNotes(editor, [
      "C2, step 1, 1 step",
      "D♯2, step 9, 1 step",
      "F♯2, step 5, 1 step",
    ]);
    await step("Add three notes, one of them F♯2");

    // 3. Choose Minor from the scale switch. The root buttons are enabled with
    //    C chosen, and the key reads "C minor". The roll shows only C minor
    //    rows, plus an F♯2 row marked Off, which holds the F♯2 note. No C♯2 or
    //    E2 row is shown.
    await scaleButton(editor, "Minor").click();
    await expect(scaleButton(editor, "Minor")).toHaveAttribute("aria-pressed", "true");
    for (const button of await rootButtons(editor).all())
      await expect(button).toBeEnabled();
    await expect(rootButton(editor, "C")).toHaveAttribute("aria-pressed", "true");
    await expect(keyReadout(editor)).toHaveText("C minor");
    await expectCMinorRows(editor, ["F♯2"]);
    const offRow = await box(pitchRow(editor, "F♯2"));
    const stray = await box(note(editor, "F♯2", 5));
    const strayMiddle = stray.y + stray.height / 2;
    expect(strayMiddle).toBeGreaterThan(offRow.y);
    expect(strayMiddle).toBeLessThan(offRow.y + offRow.height);
    await expect(pitchRow(editor, "C♯2")).toHaveCount(0);
    await expect(pitchRow(editor, "E2")).toHaveCount(0);
    await step("Choose Minor: F♯2 shows as an Off row");

    // 4. Press Quantize to scale. The F♯2 note moves onto a C minor row, and
    //    the Off row disappears. The C2 and D♯2 notes have not changed.
    await quantizeToScale(editor).click();
    await expectCMinorRows(editor);
    await expect(notes(editor)).toHaveCount(3);
    await expect(note(editor, "F♯2", 5)).toHaveCount(0);
    const quantized = await noteNames(editor);
    expect(quantized).toContain("C2, step 1, 1 step");
    expect(quantized).toContain("D♯2, step 9, 1 step");
    const moved = quantized.filter(
      (name) => name !== "C2, step 1, 1 step" && name !== "D♯2, step 9, 1 step",
    );
    expect(moved).toHaveLength(1);
    const [, movedPitch] = moved[0].match(/^([A-G]♯?-?\d+), step 5, 1 step$/) ?? [];
    expect(movedPitch, `"${moved[0]}" should be the step-5 note`).toBeDefined();
    expect(C_MINOR.has(pitchClassOf(movedPitch ?? ""))).toBe(true);
    await step("Quantize to scale pulls F♯2 into C minor");

    // 5. Undo. The F♯2 note and its Off row are back. Redo. They are gone
    //    again.
    await page.keyboard.press("ControlOrMeta+z");
    await expectNotes(editor, [
      "C2, step 1, 1 step",
      "D♯2, step 9, 1 step",
      "F♯2, step 5, 1 step",
    ]);
    await expectCMinorRows(editor, ["F♯2"]);
    await step("Undo: the stray note and its Off row return");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expectNotes(editor, quantized);
    await expectCMinorRows(editor);
    await step("Redo: they are gone again");

    // 6. Press 1 to go back to the arrangement, and reload the page. Open the
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

    // Outcome: the key reads "C minor" and the roll shows only C minor rows,
    // so the key was saved with the project. The clip holds three notes, all
    // in C minor.
    await expect(keyReadout(reopened)).toHaveText("C minor");
    await expectCMinorRows(reopened);
    await expectNotes(reopened, quantized);
    await step("Reload: the key and the notes are kept");
  });
});
