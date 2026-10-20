import { walkthrough } from "../../support/walkthrough";
import { reloadPage } from "../support/reload";
import { expect, type Locator, type Page, test } from "../support/test";

/**
 * `CF-013` — a producer rearranges a track's chain while it plays.
 *
 * Read the flow in `docs/core-flows.md`; the numbered comments below are its
 * steps, in its words. This is the acceptance contract for `LOOP-017` (#241)
 * and is frozen once it lands: a later PR that changes an assertion here has to
 * say so in its body and justify it.
 *
 * `test.fixme` because the panel is missing — #241 is the PR that removes this
 * marker. The commands it drives (`device.reorder`, `device.setBypass`,
 * `device.duplicate`, `device.reset`, `device.remove`) and `DeviceChain`'s node
 * reuse on reorder already exist; this flow proves a producer can reach them.
 *
 * "Click-free" is not asserted here: a headless browser hears nothing. The flow
 * proves playback keeps running through the edits; the reuse that makes a
 * reorder click-free is asserted against `DeviceChain` in the audio suite.
 *
 * Runs against the Firestore/Auth emulator because step 9 is a real reload.
 */

/** The dock's link to the instrument view (#304). */
const instrumentLink = (page: Page): Locator =>
  page
    .getByRole("navigation", { name: "Views" })
    .getByRole("link", { name: "Instrument" });

/** The selected track's device chain and its devices, in signal order — see CF-012. */
const chainPanel = (page: Page): Locator =>
  page.getByRole("region", { name: "Device chain" });
const devices = (page: Page): Locator =>
  chainPanel(page).getByRole("list", { name: "Device chain" }).getByRole("listitem");

/** Adds a device from the six registered types — see CF-012. */
async function addDevice(page: Page, label: string): Promise<void> {
  await chainPanel(page)
    .getByRole("group", { name: "Add device" })
    .getByRole("button", { name: `Add ${label.toLowerCase()} device` })
    .click();
}

/**
 * A device's own actions, found inside that device's entry so two reverbs are
 * never confused. Bypass is a toggle button, like a strip's Mute and Solo, so
 * its state is `aria-pressed`. Reordering is a drag from a card's header onto
 * the card whose place it takes (changed from earlier/later buttons at the
 * product owner's request on #241; the keyboard way is Alt/Option+Up/Down on
 * the device's name, covered at the component layer).
 */
const bypass = (device: Locator): Locator =>
  device.getByRole("button", { name: /^Bypass/ });
const dragOnto = (device: Locator, target: Locator): Promise<void> =>
  device.locator("header").dragTo(target.locator("header"));
const action = (device: Locator, name: "Duplicate" | "Reset" | "Remove"): Locator =>
  device.getByRole("button", { name: new RegExp(`^${name}`) });

/** The transport's playhead readout, by the accessible text `EditorHeader` gives it. */
const playheadReadout = (page: Page): Locator =>
  page.getByText(/^Playhead at bar \d+\.\d+$/);

test.describe("CF-013", () => {
  // `test.fixme` until #241 (LOOP-017) lands: that PR removes this marker in
  // the same diff that makes the flow pass.
  test("a producer rearranges a track's chain while it plays", async ({
    page,
    browserName,
  }) => {
    test.setTimeout(120_000);

    const step = walkthrough(page, {
      id: "CF-013",
      title: "A producer rearranges a track's chain while it plays",
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

    // 1. Create a new project. Go to the instrument view for the starter
    //    track, and add an overdrive and then a reverb to its chain.
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    await page.getByTestId("arrangement-view-ready").waitFor();
    await instrumentLink(page).click();
    await expect(page).toHaveURL(/\/projects\/prj_[^/]+\/instrument$/);
    const instrumentUrl = page.url();
    await expect(devices(page)).toHaveCount(0);
    await addDevice(page, "Overdrive");
    await addDevice(page, "Reverb");
    await expect(devices(page)).toHaveText([/Overdrive/, /Reverb/]);
    await step("An overdrive, then a reverb, on the starter track");

    // 2. Start playback.
    await page.getByRole("button", { name: "Start playback" }).click();
    await stillPlaying();
    await step("Start playback");

    // 3. While it plays, move the reverb before the overdrive. The chain now
    //    reads reverb, then overdrive, and playback never drops out.
    await dragOnto(devices(page).nth(1), devices(page).nth(0));
    await expect(devices(page)).toHaveText([/Reverb/, /Overdrive/]);
    await stillPlaying();
    await step("Move the reverb before the overdrive, still playing");

    // 4. Bypass the overdrive. It stays in its place in the chain, marked as
    //    bypassed, with its settings unchanged.
    const overdrive = devices(page).nth(1);
    const driveBefore = await overdrive
      .getByRole("slider", { name: "Drive" })
      .inputValue();
    await bypass(overdrive).click();
    await expect(devices(page)).toHaveText([/Reverb/, /Overdrive/]);
    await expect(bypass(devices(page).nth(1))).toHaveAttribute("aria-pressed", "true");
    await expect(devices(page).nth(1).getByRole("slider", { name: "Drive" })).toHaveValue(
      driveBefore,
    );
    await step("Bypass the overdrive — it keeps its place and settings");

    // 5. Duplicate the reverb. A second reverb appears directly after the
    //    first, with the same settings.
    const sizeBefore = await devices(page)
      .nth(0)
      .getByRole("slider", { name: "Size" })
      .inputValue();
    await action(devices(page).nth(0), "Duplicate").click();
    await expect(devices(page)).toHaveText([/Reverb/, /Reverb/, /Overdrive/]);
    await expect(devices(page).nth(1).getByRole("slider", { name: "Size" })).toHaveValue(
      sizeBefore,
    );
    await step("Duplicate the reverb");

    // 6. Turn the second reverb's size up, then reset it. Its controls return
    //    to their defaults; the first reverb is untouched.
    //
    // Size is used rather than Dry/Wet because Dry/Wet already defaults to
    // its maximum, so "up" would not be an edit. Its default, 0.5, is the
    // reverb's own parameter definition (`src/domain/devices.ts`).
    const secondSize = devices(page).nth(1).getByRole("slider", { name: "Size" });
    await secondSize.fill("0.9");
    await expect(secondSize).toHaveValue("0.9");
    await action(devices(page).nth(1), "Reset").click();
    await expect(secondSize).toHaveValue("0.5");
    await expect(devices(page).nth(0).getByRole("slider", { name: "Size" })).toHaveValue(
      sizeBefore,
    );
    await step("Reset the second reverb to its defaults");

    // 7. Remove the second reverb. The chain reads reverb, then the bypassed
    //    overdrive.
    await action(devices(page).nth(1), "Remove").click();
    await expect(devices(page)).toHaveText([/Reverb/, /Overdrive/]);
    await expect(bypass(devices(page).nth(1))).toHaveAttribute("aria-pressed", "true");
    await step("Remove the second reverb");

    // 8. Undo once. The removed reverb returns in the same place.
    await page.getByRole("button", { name: /^Undo/ }).click();
    await expect(devices(page)).toHaveText([/Reverb/, /Reverb/, /Overdrive/]);
    await stillPlaying();
    await step("Undo — the reverb is back in its place");

    // 9. Stop playback and reload the page. The chain reads reverb, reverb,
    //    overdrive, with the overdrive still bypassed and the second reverb
    //    still at its defaults.
    if (canAssertPlayback) {
      await page.getByRole("button", { name: "Stop playback" }).click();
      await expect(page.getByRole("button", { name: "Start playback" })).toBeVisible();
    }
    await expect(page.locator(".save-status")).toHaveText("Saved", {
      timeout: 10_000,
    });
    await reloadPage(page);
    await expect(page).toHaveURL(instrumentUrl);
    await expect(devices(page)).toHaveText([/Reverb/, /Reverb/, /Overdrive/]);
    await expect(bypass(devices(page).nth(2))).toHaveAttribute("aria-pressed", "true");
    await expect(devices(page).nth(1).getByRole("slider", { name: "Size" })).toHaveValue(
      "0.5",
    );
    await step("Reload — the rearranged chain is intact");
  });
});
