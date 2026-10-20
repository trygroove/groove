import { walkthrough } from "../../support/walkthrough";
import { library } from "../support/library";
import { reloadPage } from "../support/reload";
import { expect, type Locator, type Page, test } from "../support/test";
import { expectView } from "../support/views";

/**
 * `CF-012` — a producer builds an effects chain on one track.
 *
 * Read the flow in `docs/core-flows.md`; the numbered comments below are its
 * steps, in its words. This is the acceptance contract for `LOOP-017` (#241)
 * and is frozen once it lands: a later PR that changes an assertion here has to
 * say so in its body and justify it.
 *
 * **Revised for #817.** Step 1 brings its loop in through the Library view on
 * `4`, as CF-005 now does: the arrangement's library button aims it at a new
 * track and Enter inserts and goes back to the arrangement. Parked at
 * `test.fixme` until #817's stack lands: the PR that closes #817 removes the
 * marker.
 *
 * Runs against the Firestore/Auth emulator rather than the mock backend,
 * because step 9 is a real `page.reload()` and the mock repository is a fresh,
 * empty store on every page load.
 */

/** The dock's links to two of the five views (#304, #817). */
const viewLink = (page: Page, name: "Mixer" | "Instrument"): Locator =>
  page.getByRole("navigation", { name: "Views" }).getByRole("link", { name });
const mixer = (page: Page): Locator => page.getByRole("region", { name: "Mixer" });

/**
 * Selecting a track in the mixer is its "Edit <name>" control (#240), and the
 * instrument view's track rail is the same selection. Tracks are taken by
 * position — the starter kick first, the inserted loop second — because a
 * track's name is the user's content, not something this flow asserts.
 */
const mixerSelect = (page: Page, index: number): Locator =>
  mixer(page)
    .getByRole("button", { name: /^Edit / })
    .nth(index);
const railSelect = (page: Page, index: number): Locator =>
  page
    .getByRole("list", { name: "Tracks" })
    .getByRole("button", { name: /^Edit / })
    .nth(index);

/**
 * The selected track's device chain, in the slot UI-001 reserved for it, and
 * the devices on it in signal order. A named list is what "in order" has to be
 * for a keyboard and a screen reader, and it is what this spec counts in.
 */
const chainPanel = (page: Page): Locator =>
  page.getByRole("region", { name: "Device chain" });
const devices = (page: Page): Locator =>
  chainPanel(page).getByRole("list", { name: "Device chain" }).getByRole("listitem");

/**
 * Adds a device from the six registered types: one add button per type after
 * the chain, the unit the arrangement uses to add a track (changed from an
 * "Add device" button and a picker at the product owner's request on #241).
 */
async function addDevice(page: Page, label: string): Promise<void> {
  await chainPanel(page)
    .getByRole("group", { name: "Add device" })
    .getByRole("button", { name: `Add ${label.toLowerCase()} device` })
    .click();
}

/** The arrangement's way into the library — see CF-005. */
const addFromLibrary = (page: Page): Locator =>
  page.getByRole("button", { name: /library/i }).first();

/** The transport's playhead readout, by the accessible text `EditorHeader` gives it. */
const playheadReadout = (page: Page): Locator =>
  page.getByText(/^Playhead at bar \d+\.\d+$/);

test.describe("CF-012", () => {
  // `test.fixme` until #817's stack lands: the PR that closes #817 removes this
  // marker in the same diff that makes the flow pass.
  test("a producer builds an effects chain on one track", async ({
    page,
    browserName,
  }) => {
    // Parked from inside the body so the body keeps its indentation.
    test.setTimeout(120_000);

    const step = walkthrough(page, {
      id: "CF-012",
      title: "A producer builds an effects chain on one track",
    });

    // Playback is asserted in Chromium only — the known, tracked gap CF-001
    // and CF-007 already carry. See docs/testing.md, "Playback is asserted in
    // Chromium only", and #43. The chain, controls, history and reload run in
    // both gating browsers.
    const canAssertPlayback = browserName === "chromium";
    test.info().annotations.push({
      type: canAssertPlayback ? "playback-asserted" : "playback-skipped",
      description: canAssertPlayback
        ? `playback asserted in ${browserName}`
        : `playback not asserted in ${browserName}: AudioContext.resume() is refused here — see HARD-001`,
    });

    // 1. Create a new project and bring a library loop into it, so the
    //    starter kick and the loop sit on two tracks.
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    await page.getByTestId("arrangement-view-ready").waitFor();

    await addFromLibrary(page).click();
    await expectView(page, "Library");
    await library(page).getByRole("searchbox", { name: "Search sounds" }).fill("loop");
    // A loop states its tempo; a one-shot does not, and would load a sampler
    // instead of making a track. Which loop does not matter here.
    const loopName = await library(page)
      .getByRole("button", { name: /^Audition / })
      .locator("..")
      .filter({ hasText: /BPM/ })
      .first()
      .getByRole("button", { name: /^Audition / })
      .getAttribute("aria-label");
    // Select-then-insert: hearing the loop is what makes it the one to insert.
    await library(page)
      .getByRole("button", { name: loopName ?? "", exact: true })
      .click();
    await page.keyboard.press("Enter");
    await expectView(page, "Arrangement");
    await expect(library(page)).toHaveCount(0);
    await expect(
      page.getByRole("list", { name: "Arrangement tracks" }).getByRole("listitem"),
    ).toHaveCount(2);
    await step("A project with the starter kick and a library loop");

    // 2. Switch to the mixer and select the loop's track. Go to the
    //    instrument view. It shows the loop's track, and its device chain is
    //    empty.
    await viewLink(page, "Mixer").click();
    await mixerSelect(page, 1).click();
    await expect(mixerSelect(page, 1)).toHaveAttribute("aria-pressed", "true");
    await viewLink(page, "Instrument").click();
    await expect(page).toHaveURL(/\/projects\/prj_[^/]+\/instrument$/);
    const instrumentUrl = page.url();
    await expect(railSelect(page, 1)).toHaveAttribute("aria-pressed", "true");
    await expect(chainPanel(page)).toBeVisible();
    await expect(devices(page)).toHaveCount(0);
    await step("The loop's track, with an empty device chain");

    // 3. Add a filter to the chain. It appears with its own controls —
    //    cutoff and the rest of its settings — not a list of presets.
    //
    // The controls are generated from the filter's parameter definitions
    // (PRD FX-01), so the spec names them by those definitions' labels.
    await addDevice(page, "Filter");
    await expect(devices(page)).toHaveCount(1);
    const filter = devices(page).nth(0);
    await expect(filter).toContainText("Filter");
    await expect(filter.getByRole("slider", { name: "Cutoff" })).toBeVisible();
    await expect(filter.getByRole("slider", { name: "Resonance" })).toBeVisible();
    await expect(filter.getByRole("slider", { name: "Dry/Wet" })).toBeVisible();
    await step("Add a filter, with its own controls");

    // 4. Add a delay. It appears after the filter, and the chain reads
    //    filter, then delay.
    await addDevice(page, "Delay");
    await expect(devices(page)).toHaveText([/Filter/, /Delay/]);
    await step("Add a delay after the filter");

    // 5. Undo once. The delay comes off; the filter stays. Redo. The delay
    //    is back, after the filter.
    await page.getByRole("button", { name: /^Undo/ }).click();
    await expect(devices(page)).toHaveText([/Filter/]);
    await page.getByRole("button", { name: /^Redo/ }).click();
    await expect(devices(page)).toHaveText([/Filter/, /Delay/]);
    await step("Undo and redo the delay");

    // 6. Start playback. While it plays, sweep the filter's cutoff down. The
    //    control follows, and playback never drops out.
    await page.getByRole("button", { name: "Start playback" }).click();
    const cutoff = devices(page).nth(0).getByRole("slider", { name: "Cutoff" });
    const cutoffBefore = await cutoff.inputValue();
    await cutoff.fill("800");
    await expect(cutoff).toHaveValue("800");
    if (canAssertPlayback) {
      // Observed through the transport, as in CF-007: a playhead still
      // advancing after the edit is the claim — the graph did not stall or
      // rebuild. Audibility is the audio suite's.
      await expect(page.getByRole("button", { name: "Stop playback" })).toBeVisible();
      const before = (await playheadReadout(page).textContent()) ?? "";
      await expect
        .poll(async () => (await playheadReadout(page).textContent()) ?? "", {
          timeout: 10_000,
        })
        .not.toBe(before);
    }
    await step("Sweep the filter's cutoff while it plays");

    // 7. Undo once. The cutoff returns to where it was before the sweep, in
    //    one step.
    //
    // A parameter gesture is one history entry (#241's gesture criterion),
    // so a single undo takes back the whole sweep and nothing else.
    await page.getByRole("button", { name: /^Undo/ }).click();
    await expect(cutoff).toHaveValue(cutoffBefore);
    await expect(devices(page)).toHaveText([/Filter/, /Delay/]);
    await step("One undo takes back the whole sweep");

    if (canAssertPlayback) {
      await page.getByRole("button", { name: "Stop playback" }).click();
      await expect(page.getByRole("button", { name: "Start playback" })).toBeVisible();
    }

    // 8. Select the kick's track in the mixer and return to the instrument
    //    view. Its device chain is empty — the filter and delay belong to the
    //    loop's track only.
    await viewLink(page, "Mixer").click();
    await mixerSelect(page, 0).click();
    await viewLink(page, "Instrument").click();
    await expect(railSelect(page, 0)).toHaveAttribute("aria-pressed", "true");
    await expect(devices(page)).toHaveCount(0);
    await step("The kick's own chain is empty");

    // 9. Reload the page. Select the loop's track again. The filter and the
    //    delay are still on it, in that order, with the filter's settings as
    //    you left them.
    await expect(page.locator(".save-status")).toHaveText("Saved", {
      timeout: 10_000,
    });
    await reloadPage(page);
    // The view is part of the address (#304); the track selection is UI
    // state, deliberately not persisted, so it is made again.
    await expect(page).toHaveURL(instrumentUrl);
    await railSelect(page, 1).click();
    await expect(devices(page)).toHaveText([/Filter/, /Delay/]);
    await expect(
      devices(page).nth(0).getByRole("slider", { name: "Cutoff" }),
    ).toHaveValue(cutoffBefore);
    await step("Reload — the chain is still there, in order");
  });
});
