import { walkthrough } from "../../support/walkthrough";
import { reloadPage } from "../support/reload";
import { expect, type Locator, type Page, test } from "../support/test";

/**
 * `CF-014` — a producer drags their tracks into order.
 *
 * Read the flow in `docs/core-flows.md`; the numbered comments below are its
 * steps, in its words. This is the acceptance contract for `TRK-02` (#331) and
 * is frozen once it lands: a later PR that changes an assertion here has to say
 * so in its body and justify it.
 *
 * `test.fixme` because neither view accepts a drag yet — #331 is the PR that
 * removes this marker. `track.reorder` and the mixer's move-left/right buttons
 * already exist; this flow proves a producer can reach the reorder by dragging,
 * from the arrangement and the mixer, and that all three views agree.
 *
 * The drag is driven with `page.mouse` rather than `dragTo` so the spec can look
 * at the drop marker before releasing; the flow does not dictate pointer events
 * or HTML drag-and-drop, and both respond to a real mouse. The marker is the one
 * thing found by test id (`track-drop-indicator`), because it is decoration a
 * screen reader has no reason to announce as a control.
 *
 * Runs against the Firestore/Auth emulator because step 9 is a real reload.
 */

const TRACK_NAME = /^Edit (BD|Synth|Sampler)\b/;

/** The dock, and one view's link in it (#304) — see CF-008. */
const dock = (page: Page): Locator => page.getByRole("navigation", { name: "Views" });
const viewLink = (page: Page, name: string): Locator =>
  dock(page).getByRole("link", { name });

/** The arrangement's header column: one "Edit <track>" control per row. */
const arrangementHeaders = (page: Page): Locator =>
  page.getByRole("list", { name: "Tracks" }).getByRole("button", { name: TRACK_NAME });
const arrangementHeader = (page: Page, track: string): Locator =>
  page
    .getByRole("list", { name: "Tracks" })
    .getByRole("button", { name: new RegExp(`^Edit ${track}\\b`) });

/** The mixer's strips, by each strip's "Edit <track>" control. Master excluded. */
const mixer = (page: Page): Locator => page.getByRole("region", { name: "Mixer" });
const mixerStrips = (page: Page): Locator =>
  mixer(page).getByRole("button", { name: TRACK_NAME });
const mixerStrip = (page: Page, track: string): Locator =>
  mixer(page).getByRole("button", { name: `Edit ${track}`, exact: true });

/** The instrument view's track rail (#304). */
const trackRail = (page: Page): Locator =>
  page.getByRole("list", { name: "Tracks" }).getByRole("button", { name: /^Edit / });

const dropIndicator = (page: Page): Locator => page.getByTestId("track-drop-indicator");

/** The track names a list of "Edit <track>" controls reads, in order. */
async function namesOf(controls: Locator): Promise<string[]> {
  const labels = await controls.evaluateAll((els) =>
    els.map((el) => el.getAttribute("aria-label") ?? ""),
  );
  return labels.map((label) => label.replace(/^Edit /, "").replace(/ \(muted\)$/, ""));
}

/** The transport's playhead readout, by the accessible text `EditorHeader` gives it. */
const playheadReadout = (page: Page): Locator =>
  page.getByText(/^Playhead at bar \d+\.\d+$/);

type Point = { x: number; y: number };

/**
 * The element's box once its layout has stopped moving: the same box on two
 * animation frames running. A view that has just mounted (the mixer's strips,
 * the rail) can still be settling, and a box read mid-settle points the mouse at
 * where the element was, not where it is.
 */
async function settledBox(target: Locator, what: string) {
  await target.evaluate(
    (el) =>
      new Promise<void>((resolve) => {
        const key = () => {
          const r = el.getBoundingClientRect();
          return `${r.x},${r.y},${r.width},${r.height}`;
        };
        let last = key();
        const frame = () =>
          requestAnimationFrame(() => {
            const now = key();
            if (now === last) resolve();
            else {
              last = now;
              frame();
            }
          });
        frame();
      }),
  );
  const box = await target.boundingBox();
  if (!box) throw new Error(`${what} is not visible`);
  return box;
}

/**
 * Presses on `source`, moves to `to` in small steps (past any drag threshold),
 * runs `beforeRelease` while still holding, then lets go. `to` is read after the
 * source has settled, so a drop point never goes stale while the view lays out.
 */
async function drag(
  page: Page,
  source: Locator,
  to: Point | (() => Promise<Point>),
  beforeRelease?: () => Promise<void>,
): Promise<void> {
  const box = await settledBox(source, "drag source");
  const destination = typeof to === "function" ? await to() : to;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 5, from.y + 5, { steps: 4 });
  // The app has picked the item up (`dragLift.ts` marks the document) before the
  // pointer travels on, so the first move to the drop point is read as a drag.
  await expect(page.locator("html.drag-lifting")).toHaveCount(1);
  await page.mouse.move(destination.x, destination.y, { steps: 12 });
  await beforeRelease?.();
  await page.mouse.up();
}

/** A point just inside the leading edge of `target`: its top, or its left. */
async function leadingEdge(target: Locator, axis: "top" | "left"): Promise<Point> {
  const box = await settledBox(target, "drop target");
  return axis === "top"
    ? { x: box.x + box.width / 2, y: box.y + 2 }
    : { x: box.x + 2, y: box.y + box.height / 2 };
}

test.describe("CF-014", () => {
  // `test.fixme` until #331 (TRK-02) lands: that PR removes this marker in the
  // same diff that makes the flow pass.
  test("a producer drags their tracks into order", async ({ page, browserName }) => {
    test.setTimeout(120_000);

    const step = walkthrough(page, {
      id: "CF-014",
      title: "A producer drags their tracks into order",
    });

    // Playback is asserted in Chromium only — see CF-007 and #43.
    const canAssertPlayback = browserName === "chromium";
    test.info().annotations.push({
      type: canAssertPlayback ? "playback-asserted" : "playback-skipped",
      description: canAssertPlayback
        ? `playback asserted in ${browserName}`
        : `playback not asserted in ${browserName}: AudioContext.resume() is refused here — see HARD-001`,
    });

    /** Playback is still running: the transport stayed on and the playhead moves. */
    async function stillPlaying(): Promise<void> {
      if (!canAssertPlayback) return;
      await expect(page.getByRole("button", { name: "Stop playback" })).toBeVisible();
      const before = (await playheadReadout(page).textContent()) ?? "";
      await expect
        .poll(async () => (await playheadReadout(page).textContent()) ?? "", {
          timeout: 10_000,
        })
        .not.toBe(before);
    }

    // 1. Create a new project. It opens on the arrangement with the starter
    //    track, BD. Add a synth track and then a sampler track. The track list
    //    reads BD, Synth, Sampler, top to bottom.
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    await page.getByTestId("arrangement-view-ready").waitFor();
    await expect.poll(() => namesOf(arrangementHeaders(page))).toEqual(["BD"]);
    await page.getByRole("button", { name: "Add synth track" }).click();
    await page.getByRole("button", { name: "Add sampler track" }).click();
    await expect
      .poll(() => namesOf(arrangementHeaders(page)))
      .toEqual(["BD", "Synth", "Sampler"]);
    await step("Three tracks: BD, Synth, Sampler");

    // 2. Start playback.
    await page.getByRole("button", { name: "Start playback" }).click();
    await stillPlaying();
    await step("Start playback");

    // 3. While it plays, drag the Sampler track's header up over BD. Before you
    //    let go, a marker shows the track will land at the top. Let go: the
    //    list reads Sampler, BD, Synth, and playback never stops.
    await drag(
      page,
      arrangementHeader(page, "Sampler"),
      () => leadingEdge(arrangementHeader(page, "BD"), "top"),
      async () => {
        await expect(dropIndicator(page)).toBeVisible();
        await step("Drag Sampler up — a marker shows it will land at the top");
      },
    );
    await expect(dropIndicator(page)).toHaveCount(0);
    await expect
      .poll(() => namesOf(arrangementHeaders(page)))
      .toEqual(["Sampler", "BD", "Synth"]);
    await stillPlaying();
    await step("Let go — Sampler is at the top, still playing");

    // 4. Drag BD's header off the track list and let go over the view dock.
    //    Nothing moves: the list still reads Sampler, BD, Synth.
    const dockBox = await dock(page).boundingBox();
    if (!dockBox) throw new Error("the view dock is not visible");
    await drag(page, arrangementHeader(page, "BD"), {
      x: dockBox.x + dockBox.width / 2,
      y: dockBox.y + dockBox.height / 2,
    });
    await expect(dropIndicator(page)).toHaveCount(0);
    await expect
      .poll(() => namesOf(arrangementHeaders(page)))
      .toEqual(["Sampler", "BD", "Synth"]);
    await step("A drag released off the list changes nothing");

    // 5. Undo once. The list reads BD, Synth, Sampler — the whole drag comes
    //    back in one step. Redo, and it reads Sampler, BD, Synth again.
    await page.getByRole("button", { name: /^Undo/ }).click();
    await expect
      .poll(() => namesOf(arrangementHeaders(page)))
      .toEqual(["BD", "Synth", "Sampler"]);
    await page.getByRole("button", { name: /^Redo/ }).click();
    await expect
      .poll(() => namesOf(arrangementHeaders(page)))
      .toEqual(["Sampler", "BD", "Synth"]);
    await step("Undo and redo take the whole drag in one step");

    // 6. Go to the mixer. The strips read Sampler, BD, Synth, left to right.
    //    Drag the Synth strip to the far left. Before you let go, a marker
    //    shows where it will land. Let go: the strips read Synth, Sampler, BD,
    //    and playback is still running.
    await viewLink(page, "Mixer").click();
    await expect(mixer(page)).toBeVisible();
    await expect
      .poll(() => namesOf(mixerStrips(page)))
      .toEqual(["Sampler", "BD", "Synth"]);
    await drag(
      page,
      mixerStrip(page, "Synth"),
      () => leadingEdge(mixerStrip(page, "Sampler"), "left"),
      async () => {
        await expect(dropIndicator(page)).toBeVisible();
        await step("Drag the Synth strip left — a marker shows where it lands");
      },
    );
    await expect(dropIndicator(page)).toHaveCount(0);
    await expect
      .poll(() => namesOf(mixerStrips(page)))
      .toEqual(["Synth", "Sampler", "BD"]);
    await stillPlaying();
    await step("Let go — Synth is first in the mixer, still playing");

    // 7. Using only the keyboard, move BD one place to the left. The strips
    //    read Synth, BD, Sampler.
    //
    // The existing "Move BD left" button, or whatever replaces it, reached by
    // focus and Enter — the drag is never the only path (#331).
    const moveBdLeft = mixer(page).getByRole("button", {
      name: /^Move BD (left|earlier)/i,
    });
    await moveBdLeft.focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => namesOf(mixerStrips(page)))
      .toEqual(["Synth", "BD", "Sampler"]);
    await step("Move BD left with the keyboard");

    // 8. Go to the instrument view. The track list down its left edge reads
    //    Synth, BD, Sampler.
    await viewLink(page, "Instrument").click();
    await expect(page).toHaveURL(/\/projects\/prj_[^/]+\/instrument$/);
    await expect(trackRail(page)).toHaveText(["Synth", "BD", "Sampler"]);
    await step("The instrument view's track list agrees");

    // 9. Stop playback and reload the page. The instrument view's track list
    //    still reads Synth, BD, Sampler, and so does the arrangement's.
    if (canAssertPlayback) {
      await page.getByRole("button", { name: "Stop playback" }).click();
      await expect(page.getByRole("button", { name: "Start playback" })).toBeVisible();
    }
    await expect(page.locator(".save-status")).toHaveText("Saved", { timeout: 10_000 });
    await reloadPage(page);
    await expect(trackRail(page)).toHaveText(["Synth", "BD", "Sampler"]);
    await viewLink(page, "Arrangement").click();
    await page.getByTestId("arrangement-view-ready").waitFor();
    await expect
      .poll(() => namesOf(arrangementHeaders(page)))
      .toEqual(["Synth", "BD", "Sampler"]);
    await step("Reload — every view keeps the new order");
  });
});
