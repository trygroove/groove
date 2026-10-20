import { walkthrough } from "../../support/walkthrough";
import { library } from "../support/library";
import { reloadPage } from "../support/reload";
import { expect, type Locator, type Page, test } from "../support/test";
import { backToArrangement, expectView, pressView, sequenceView } from "../support/views";

/**
 * `CF-002` — a producer builds a five-part loop.
 *
 * Read the flow in `docs/core-flows.md`; the numbered comments below are its
 * steps, in its words.
 *
 * **Trimmed for #817.** This flow used to go on to turn the loop into a song
 * outline (#61, ARR-003). That requirement was dropped when #61 closed, and no
 * outline was built, so steps 7-11 could never pass. The flow now ends where
 * its working part ends, at the playing loop, plus the reload every flow ends
 * on. Steps 1-6 and their assertions are unchanged.
 *
 * **Revised for #496.** Hats and Claps are drum-machine tracks sequenced on the
 * step grid by pad ("HH, step 3, on"); Chords and Bass are sampler tracks
 * written in the piano roll at C4, which plays the sample as recorded.
 *
 * **Revised for #817.** A clip opens on the sequence view (`/sequence`) and `1`
 * leaves it; a sampler's sound comes from its sample slot through the Library
 * view, and Enter inserts and comes back.
 */

// Grid steps are 1-indexed, matching the accessible names the step editor and
// the piano roll emit.

/** The "and" of each beat: the offbeat a closed hat sits on. */
const OFFBEATS = [3, 7, 11, 15];
/** Beats 2 and 4 — the backbeat, not beat 1, which would just double the kick. */
const BACKBEAT = [5, 13];
/** Every third 16th: the rave stab. */
const RAVE_STAB = [1, 4, 7, 10, 13, 16];
/** Four on the floor, with the starter kick. */
const WITH_THE_KICK = [1, 5, 9, 13];
/** C4 plays a sampler's sample as it was recorded (#496). */
const AS_RECORDED = "C4";

/** One bar of the alpha's fixed 4/4 at 192 PPQ (`src/domain/time.ts`). */
const TICKS_PER_BAR = 4 * 192;

/** The interaction canvas the tracks are drawn on: a `<canvas>`, so a class (CF-016). */
const timeline = (page: Page): Locator => page.locator(".arrangement-layer-interactive");

/** Open the clip in bar 1 of track row `rowIndex`, and return the sequence view. */
async function openClip(page: Page, rowIndex: number): Promise<Locator> {
  const root = page.getByTestId("arrangement-view-ready");
  const pixelsPerTick = Number(await root.getAttribute("data-pixels-per-tick"));
  const rulerHeight = Number(await root.getAttribute("data-ruler-height"));
  const rowHeight = Number(await root.getAttribute("data-row-height"));
  expect(pixelsPerTick).toBeGreaterThan(0);
  expect(rowHeight).toBeGreaterThan(0);
  await timeline(page).dblclick({
    position: {
      x: 0.5 * TICKS_PER_BAR * pixelsPerTick,
      y: rulerHeight + rowIndex * rowHeight + rowHeight / 2,
    },
  });
  await expectView(page, "Sequence");
  await expect(sequenceView(page)).toBeVisible();
  return sequenceView(page);
}

/**
 * Name the track just added, the way the arrangement renames any track: a
 * click on its name in the header opens the "Track name" field. A new track
 * opens no name field of its own, and the newest track is the last header.
 * `.track-header-name` is the class the header's own tests click.
 */
async function nameTrack(page: Page, name: string): Promise<void> {
  await page.locator(".track-header-name").last().click();
  await page.getByRole("textbox", { name: "Track name" }).fill(name);
  await page.getByRole("textbox", { name: "Track name" }).press("Enter");
}

/**
 * Add a named drum-machine track and put one of its pads on `steps`, on the
 * step grid. The starter kit already carries a hat on "HH" and a clap on "CP",
 * so no library sound is loaded (#496: the drum machine is the one-shot
 * player, and drum one-shots live on its pads).
 */
async function addDrumTrack(
  page: Page,
  part: { name: string; row: number; pad: string; steps: readonly number[] },
): Promise<void> {
  await page.getByRole("button", { name: "Add drum machine track" }).click();
  await nameTrack(page, part.name);

  const editor = await openClip(page, part.row);
  for (const step of part.steps) {
    await editor.getByRole("button", { name: `${part.pad}, step ${step}, off` }).click();
    await expect(
      editor.getByRole("button", { name: `${part.pad}, step ${step}, on` }),
    ).toBeVisible();
  }
  await backToArrangement(page);
}

/**
 * Add a named sampler track, drag a library sound onto its instrument, and
 * write its notes in the piano roll. A sampler is a tonal instrument (#496):
 * its clip opens in the piano roll, and a note plays the sample at its pitch.
 *
 * The library drop is what #225 exists to deliver; the piano roll's rows and
 * ruler are the ones CF-017 uses.
 */
async function addSamplerTrack(
  page: Page,
  part: { name: string; row: number; sound: string; steps: readonly number[] },
): Promise<void> {
  await page.getByRole("button", { name: "Add sampler track" }).click();
  await nameTrack(page, part.name);

  // From the library (#817): the sampler's sample slot aims the Library view
  // at it, Enter inserts and comes back, and `1` returns to the song.
  await pressView(page, "Instrument");
  const instrument = page.getByRole("region", { name: `${part.name} instrument` });
  await instrument.getByRole("button", { name: "Sample", exact: true }).click();
  await expectView(page, "Library");
  await library(page).getByRole("searchbox", { name: "Search sounds" }).fill(part.sound);
  const pick = library(page)
    .getByRole("button", { name: new RegExp(`^Audition .*${part.sound}`, "i") })
    .first();
  const picked = ((await pick.getAttribute("aria-label")) ?? "").replace(
    /^Audition /,
    "",
  );
  // Act on the row by the name just read: `pick` re-resolves to the first
  // match on every use, and the list can re-order between the read and click.
  await library(page)
    .getByRole("button", { name: `Audition ${picked}`, exact: true })
    .click();
  await page.keyboard.press("Enter");
  await expectView(page, "Instrument");

  // The sampler names what it is holding, so the insert is visible rather
  // than inferred from a later sound.
  await expect(instrument).toContainText(picked);
  await pressView(page, "Arrangement");

  const editor = await openClip(page, part.row);
  await expect(editor.getByRole("region", { name: /^Piano roll\b/ })).toBeVisible();
  const row = editor
    .getByRole("group", { name: "Pitches" })
    .getByRole("button", { name: new RegExp(`^${AS_RECORDED}(\\W*Off)?$`) });
  await row.scrollIntoViewIfNeeded();
  const rowBox = await row.boundingBox();
  if (!rowBox) throw new Error("expected a visible pitch row to measure");
  for (const step of part.steps) {
    const column = editor
      .getByRole("group", { name: "Ruler" })
      .getByRole("button", { name: `Step ${step}`, exact: true });
    const columnBox = await column.boundingBox();
    if (!columnBox) throw new Error("expected a visible ruler step to measure");
    await page.mouse.click(
      columnBox.x + columnBox.width / 2,
      rowBox.y + rowBox.height / 2,
    );
    await expect(
      editor
        .getByRole("listbox", { name: "Notes" })
        .getByRole("option", { name: new RegExp(`^${AS_RECORDED}, step ${step},`) }),
    ).toBeVisible();
  }
  await backToArrangement(page);
}

test.describe("CF-002", () => {
  test("a producer builds a five-part loop", async ({ page, browserName }) => {
    // Five tracks built by hand through three views is a long journey.
    test.setTimeout(120_000);
    const step = walkthrough(page, {
      id: "CF-002",
      title: "A producer builds a five-part loop",
    });

    // 1. Create a new project. It opens on the arrangement with the starter
    //    kick, a drum machine named "BD", four on the floor.
    await page.goto("/projects");
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    await page.getByTestId("arrangement-view-ready").waitFor();
    const kick = await openClip(page, 0);
    for (const kickStep of WITH_THE_KICK) {
      await expect(
        kick.getByRole("button", { name: `BD, step ${kickStep}, on` }),
      ).toBeVisible();
    }
    await step("The new project opens on the starter kick");
    await backToArrangement(page);

    // 2. Add a drum-machine track named "Hats", and put the "HH" pad on
    //    every offbeat.
    await addDrumTrack(page, {
      name: "Hats",
      row: 1,
      pad: "HH",
      steps: OFFBEATS,
    });
    await step("Add a hat track, on every offbeat");

    // 3. Add a drum-machine track named "Claps", with the "CP" pad on beats
    //    2 and 4.
    await addDrumTrack(page, {
      name: "Claps",
      row: 2,
      pad: "CP",
      steps: BACKBEAT,
    });
    await step("Add a clap track, on beats 2 and 4");

    // 4. Add a sampler track named "Chords", load a chord stab onto it from
    //    the library, and write a C4 in the piano roll on steps 1, 4, 7, 10,
    //    13 and 16.
    await addSamplerTrack(page, {
      name: "Chords",
      row: 3,
      sound: "chord",
      steps: RAVE_STAB,
    });
    await step("Add a chord stab");

    // 5. Add a sampler track named "Bass", load a bass note onto it from the
    //    library, and write a C4 in the piano roll following the kick, on
    //    steps 1, 5, 9 and 13.
    await addSamplerTrack(page, {
      name: "Bass",
      row: 4,
      sound: "bass",
      steps: WITH_THE_KICK,
    });
    await step("Add a bass, following the kick");

    // 6. Play the loop — five parts, one bar, tight.
    //
    // As in CF-001, this asserts the transport is running, not that a sound
    // reached a speaker: a headless browser records no audio.
    //
    // Playback is asserted in Chromium only, exactly as in CF-001 and CF-004:
    // Firefox here refuses `AudioContext.resume()` (HARD-001, #43). The click
    // still runs everywhere.
    const canAssertPlayback = browserName === "chromium";
    test.info().annotations.push({
      type: canAssertPlayback ? "playback-asserted" : "playback-skipped",
      description: canAssertPlayback
        ? `playback asserted in ${browserName}`
        : `playback not asserted in ${browserName}: AudioContext.resume() is refused here — see HARD-001`,
    });
    await page.getByRole("button", { name: "Start playback" }).click();
    if (canAssertPlayback) {
      await expect(page.getByRole("button", { name: "Stop playback" })).toBeVisible();
      await step("Play the loop — five parts, one bar");
      await page.getByRole("button", { name: "Stop playback" }).click();
    }

    // 7. Reload the page. The five tracks are still there, in the order you
    //    added them.
    //
    // The reload is only meaningful once the edits have been written, which
    // the save status is how the editor reports.
    await expect(page.locator(".save-status")).toHaveText("Saved", { timeout: 10_000 });
    await reloadPage(page);
    await page.getByTestId("arrangement-view-ready").waitFor();
    await expect(
      page.getByRole("list", { name: "Arrangement tracks" }).getByRole("listitem"),
    ).toContainText(["BD", "Hats", "Claps", "Chords", "Bass"]);
    await step("Reload: the five parts are still there");
  });
});
