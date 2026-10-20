import { walkthrough } from "../../support/walkthrough";
import { library } from "../support/library";
import { reloadPage } from "../support/reload";
import { expect, type Locator, type Page, test } from "../support/test";
import { expectView } from "../support/views";

/**
 * `CF-007` — a producer drives the whole mix through an overdrive.
 *
 * Read the flow in `docs/core-flows.md`; the numbered comments below are its
 * steps, in its words. This is the acceptance contract for `LOOP-020` (#283)
 * and is frozen once it lands: a later PR that changes an assertion here has to
 * say so in its body and justify it.
 *
 * **Rewritten by #304**, which replaces the editor's main region with three
 * views. The master chain is reached by going to the **mixer** and selecting
 * the master strip, not by switching a tab inside the arrangement; and step 1
 * brings its loop in through the library, as CF-005 does. Everything
 * this flow proves — the chain, the commands behind it, the control, the
 * reload — is unchanged.
 *
 * **Revised for #817.** Step 1 brings its loop in through the Library view on
 * `4`, as CF-005 now does: the arrangement's library button aims it at a new
 * track and Enter inserts and goes back to the arrangement. The mixer is
 * the view on `5`. Parked at `test.fixme` until #817's stack lands: the PR that
 * closes #817 removes the marker.
 *
 * **Revised for #937.** A new project's master starts with a visible Limiter
 * in place of the hidden safety limiter (a product-owner decision), so step 4
 * finds the Limiter alone on the chain rather than an empty one, and every
 * count below is one higher. The overdrive is added before it (a new master
 * device never goes after a Limiter at the end) and is still what
 * the flow undoes, redoes, drives and reloads; its Drive is found on its own
 * card, since the Limiter has a Drive too.
 *
 * Runs against the Firestore/Auth emulator rather than the mock backend,
 * because step 8 is a real `page.reload()` and the mock repository is a fresh,
 * empty store on every page load.
 *
 * ---
 *
 * **Why the undo comes before the drive is pushed.** A parameter gesture is a
 * command and therefore its own history entry (PRD 9.6; #283's criterion that a
 * control gesture "commits as one history entry per gesture"). Undoing after it
 * would put the drive back rather than take the device off, and redoing an
 * `device.add` restores the device as its payload described it, not as a later
 * edit left it. The flow undoes and redoes the add first, then pushes the drive,
 * so each of its claims is literally true. The register was corrected to match
 * before this spec was written; see CF-007's "Out of scope".
 */

/** The mixer view, and the dock link that reaches it (#304). */
const mixerLink = (page: Page): Locator =>
  page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Mixer" });
const mixer = (page: Page): Locator => page.getByRole("region", { name: "Mixer" });

/**
 * The master channel strip, and the panel selecting it reveals (#283).
 *
 * The master is a strip in the mixer like any other, which is what makes it
 * reachable without a selection model of its own; its effects appear beside the
 * strips rather than replacing them, so the producer keeps the mix in view
 * while they glue it together.
 */
const masterStrip = (page: Page): Locator =>
  mixer(page).getByRole("button", { name: "Master" });
const masterView = (page: Page): Locator =>
  page.getByRole("region", { name: "Master effects" });

/**
 * The master's device chain, in order.
 *
 * A named list is what "lists the master chain in order" has to be for a
 * keyboard and a screen reader, and it is what this spec counts devices in.
 */
const masterChain = (page: Page): Locator =>
  masterView(page).getByRole("list", { name: "Master chain" });

/** The overdrive's card on the master chain: the Limiter has a Drive too (#937). */
const overdrive = (page: Page): Locator =>
  masterChain(page).getByRole("listitem").filter({ hasText: "Overdrive" });

/** The arrangement's way into the library — see CF-005. */
const addFromLibrary = (page: Page): Locator =>
  page.getByRole("button", { name: /library/i }).first();

/** The transport's playhead readout, by the accessible text `EditorHeader` gives it. */
const playheadReadout = (page: Page): Locator =>
  page.getByText(/^Playhead at bar \d+\.\d+$/);

test.describe("CF-007", () => {
  // `test.fixme` until #817's stack lands: the PR that closes #817 removes this
  // marker in the same diff that makes the flow pass.
  test("a producer drives the whole mix through an overdrive", async ({
    page,
    browserName,
  }) => {
    // Parked from inside the body so the body keeps its indentation.
    // Playback runs across several steps of this flow in real time.
    test.setTimeout(120_000);

    const step = walkthrough(page, {
      id: "CF-007",
      title: "A producer drives the whole mix through an overdrive",
    });

    /*
     * Playback is asserted in Chromium only — the known, tracked gap CF-001
     * and `tests/e2e/emulator/slice.spec.ts` already carry (Firefox
     * constructs an `AudioContext` here whose `resume()` never settles). See
     * docs/testing.md, "Playback is asserted in Chromium only", and #43.
     *
     * The chain, the controls, the history and the reload — everything this
     * flow's own "Out of scope" says it proves — run in both gating browsers.
     */
    const canAssertPlayback = browserName === "chromium";
    test.info().annotations.push({
      type: canAssertPlayback ? "playback-asserted" : "playback-skipped",
      description: canAssertPlayback
        ? `playback asserted in ${browserName}`
        : `playback not asserted in ${browserName}: AudioContext.resume() is refused here — see HARD-001`,
    });

    // 1. Create a new project and bring a library loop into it, so the
    //    starter kick and a loop are in the project together.
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    await page.getByTestId("arrangement-view-ready").waitFor();

    await addFromLibrary(page).click();
    await expectView(page, "Library");
    await library(page).getByRole("searchbox", { name: "Search sounds" }).fill("loop");
    // A loop states the tempo it was recorded at; a one-shot has none, and a
    // one-shot inserted here would load a sampler instead of making a track.
    // Which loop does not matter to this flow — CF-005 is where the tempo
    // relationship is the subject — so it takes the first one that is one.
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

    // 2. Start playback. The two parts repeat over the loop brace.
    await page.getByRole("button", { name: "Start playback" }).click();
    if (canAssertPlayback) {
      await expect(page.getByRole("button", { name: "Stop playback" })).toBeVisible();
      await expect(page.getByTestId("arrangement-loop-live")).toContainText("bar 1");
      await step("Both parts play over the loop brace");
    }

    // 3. Switch to the mixer.
    await mixerLink(page).click();
    await expect(page).toHaveURL(/\/projects\/prj_[^/]+\/mixer$/);
    const mixerUrl = page.url();
    await expect(mixer(page)).toBeVisible();
    await step("Switch to the mixer");

    // 4. Select the master strip. The master's effects are on screen, with
    //    only the Limiter a new project starts with on its chain. Add an
    //    overdrive to it.
    await masterStrip(page).click();
    await expect(masterView(page)).toBeVisible();
    await expect(masterChain(page).getByRole("listitem")).toHaveText([/Limiter/]);
    await step("The master is on screen, with only its Limiter on the chain");

    // #283 offers the six registered device types from their registry
    // definitions as one add button per type after the chain, the unit the
    // arrangement uses to add a track (changed from an "Add device" button and
    // a picker at the product owner's request, matching #241's chain).
    await masterView(page)
      .getByRole("group", { name: "Add device" })
      .getByRole("button", { name: "Add overdrive device" })
      .click();
    await expect(masterChain(page).getByRole("listitem")).toHaveCount(2);
    await expect(masterChain(page)).toContainText("Overdrive");
    await step("Add an overdrive to the master chain");

    // 5. Undo once. The overdrive comes off the master chain.
    //
    // Nothing has been edited since the add, so the one entry on the stack is
    // the add itself.
    await page.getByRole("button", { name: /^Undo/ }).click();
    await expect(masterChain(page).getByRole("listitem")).toHaveText([/Limiter/]);
    await step("Undo once — the overdrive comes off");

    // 6. Redo. It is back.
    await page.getByRole("button", { name: /^Redo/ }).click();
    await expect(masterChain(page).getByRole("listitem")).toHaveCount(2);
    await expect(masterChain(page)).toContainText("Overdrive");
    await step("Redo — it is back");

    // 7. While it is still playing, drive the overdrive up. The control
    //    follows and playback never drops out.
    //
    // "Drive" is the overdrive's own parameter definition
    // (`src/domain/devices.ts`), normalized 0-1 and defaulting to 0.3, and
    // the panel's control is generated from that definition rather than from
    // literals — so this sets a value in the parameter's own range.
    const drive = overdrive(page).getByRole("slider", { name: "Drive" });
    await expect(drive).toBeVisible();
    await drive.fill("0.8");
    await expect(drive).toHaveValue("0.8");

    if (canAssertPlayback) {
      // "Playback never drops out", observed through the transport rather
      // than a level reading: a meter in a headless browser with no output
      // device is not evidence of anything, and this flow's own "Out of
      // scope" says it proves the chain, the controls and the state — not the
      // processing, which the audio suite asserts. A playhead still advancing
      // after the edit is the claim that matters: the graph did not stall or
      // rebuild.
      await expect(page.getByRole("button", { name: "Stop playback" })).toBeVisible();
      const before = (await playheadReadout(page).textContent()) ?? "";
      await expect
        .poll(async () => (await playheadReadout(page).textContent()) ?? "", {
          timeout: 10_000,
        })
        .not.toBe(before);
    }
    await step("Drive it up while it plays");

    if (canAssertPlayback) {
      await page.getByRole("button", { name: "Stop playback" }).click();
      await expect(page.getByRole("button", { name: "Start playback" })).toBeVisible();
    }

    // 8. Reload the page. The overdrive is still on the master chain, still
    //    at that drive.
    //
    // The reload is only meaningful once the edits have been written, which
    // the save status is how the editor reports.
    await expect(page.locator(".save-status")).toHaveText("Saved", {
      timeout: 10_000,
    });
    await reloadPage(page);
    // The view is part of the address (#304), so the reload lands back on the
    // mixer; only the strip selection, which is UI state and deliberately not
    // persisted, has to be made again.
    await expect(page).toHaveURL(mixerUrl);
    await masterStrip(page).click();
    await expect(masterChain(page).getByRole("listitem")).toHaveCount(2);
    await expect(masterChain(page)).toContainText("Overdrive");
    await expect(overdrive(page).getByRole("slider", { name: "Drive" })).toHaveValue(
      "0.8",
    );
    await step("Reload — the overdrive is still there, still at that drive");
  });
});
