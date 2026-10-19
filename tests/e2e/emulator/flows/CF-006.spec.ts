import { expect, type Locator, type Page, test } from "@playwright/test";
import { walkthrough } from "../../support/walkthrough";
import { seedRegisteredSession } from "../support/authSession";
import { library } from "../support/library";
import { reloadPage } from "../support/reload";
import { expectView, pressView } from "../support/views";

/**
 * `CF-006` — a producer brings their own sounds into a pack.
 *
 * Read the flow in `docs/core-flows.md`; the numbered comments below are its
 * steps, in its words. This is the acceptance contract for `LIB-09` (#282) and
 * is frozen once it lands: a later PR that changes an assertion here has to say
 * so in its body and justify it.
 *
 * **Made to pass by #282**, which built personal packs: **My packs** in the
 * library's rail, "Add pack", importing by drop into Cloud Storage under the
 * owning user, and the Storage emulator in this suite.
 *
 * The library is the Library view (#817), a region named "Library" at
 * `/projects/:id/library`, read through `../support/library` as the other
 * library flows read it; My packs is in its rail. A new project's starter
 * track aims it at its drum machine's first pad, so `4` reaches it.
 *
 * {@link soundFrom} matches a sound's whole name rather than any name
 * containing the file's: the factory library has a "Dusty Tape Kick", and a
 * search for "tape" lists both it and the producer's "tape kick".
 *
 * Runs against the emulator rather than the mock backend for two reasons at
 * once: the account in its precondition is a real one, and step 7 is a real
 * `page.reload()`.
 *
 * Two things about how this flow is driven, neither of which is an assertion
 * about our product:
 *
 *  - **The signed-in account is installed, not logged into.** `seedRegisteredSession`
 *    puts a persisted session in the browser the way a returning visitor already
 *    has one, so this flow never touches the login control — see that module for
 *    why a flow about importing sounds should not answer for the login UI. What
 *    the flow does assert is that it *starts* signed in to an account rather than
 *    as a guest, which is step 1.
 *  - **The files are synthesised and dropped through a `DataTransfer`.** No
 *    browser automation can drag a file off a real desktop, so
 *    {@link dropAudioFiles} builds real, decodable WAV files in the page and
 *    dispatches the drag sequence with them. That is the same `drop` event the
 *    operating system would deliver.
 */

/** The pack the producer makes. Typed by hand in step 4, so it is short. */
const PACK_NAME = "Field Recordings";

/** The three files dropped in step 5, named as they would be on a desktop. */
const FILE_NAMES = ["room-tone.wav", "tape-kick.wav", "door-slam.wav"] as const;

/** The tree node for the producer's own pack, with everything inside it. */
const personalPack = (page: Page): Locator =>
  library(page)
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: new RegExp(PACK_NAME) }) })
    .first();

/**
 * The opened pack's sounds. GRV-52 moved them out of the rail into the
 * library's main region, where every pack's sounds are; the pack's name
 * stays in the rail, and dropping on it still imports into it.
 */
const packSounds = (page: Page): Locator =>
  library(page).getByRole("region", { name: "Pack sounds" });

/** The sounds in a pack node, by the audition control every row carries. */
const sounds = (within: Locator): Locator =>
  within.getByRole("button", { name: /^Audition / });

/** The sound whose name came from `fileName`, by that audition control. */
const soundFrom = (within: Locator, fileName: string): Locator => {
  const stem = fileName.replace(/\.[^.]+$/, "");
  return within.getByRole("button", {
    name: new RegExp(`^Audition ${stem.replace(/-/g, "[ -]?")}$`, "i"),
  });
};

/** Go to the Library view with its key, `4`. */
async function openLibrary(page: Page): Promise<void> {
  await pressView(page, "Library");
  await expect(library(page)).toBeVisible();
}

/** What a guest is told, and a signed-in account is not (`UpgradeAccountPrompt`). */
const GUEST_NOTICE = /You're working as a guest/;

/**
 * Drops files on a target the way the operating system would.
 *
 * The WAV is real audio rather than empty bytes on purpose: the import detects
 * duration (and where it can, sample rate) from the file, and a zero-length
 * blob would exercise the rejection path instead of the one this flow walks.
 */
async function dropAudioFiles(
  page: Page,
  target: Locator,
  fileNames: readonly string[],
): Promise<void> {
  const dataTransfer = await page.evaluateHandle((names: readonly string[]) => {
    const sampleRate = 44_100;
    const frames = sampleRate / 10;
    const bytes = new ArrayBuffer(44 + frames * 2);
    const view = new DataView(bytes);
    const ascii = (offset: number, text: string) => {
      for (let index = 0; index < text.length; index += 1) {
        view.setUint8(offset + index, text.charCodeAt(index));
      }
    };
    ascii(0, "RIFF");
    view.setUint32(4, 36 + frames * 2, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, "data");
    view.setUint32(40, frames * 2, true);
    for (let frame = 0; frame < frames; frame += 1) {
      const value = Math.sin((frame / sampleRate) * 440 * 2 * Math.PI) * 8_000;
      view.setInt16(44 + frame * 2, Math.round(value), true);
    }

    const transfer = new DataTransfer();
    for (const name of names) {
      transfer.items.add(new File([bytes], name, { type: "audio/wav" }));
    }
    return transfer;
  }, fileNames);

  await target.dispatchEvent("dragenter", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
}

// Part of the per-PR `@sanity` subset (.github/workflows/ci.yml).
test.describe("CF-006", { tag: "@sanity" }, () => {
  test("a producer brings their own sounds into a pack", async ({
    page,
    browserName,
  }) => {
    // Three uploads against a local emulator: more than the default per-test
    // timeout allows for.
    test.setTimeout(120_000);

    // Precondition: signed in to a registered account whose personal library
    // is empty. A fresh account per run and per browser — the two gating
    // browsers share one emulator, and an account reused across runs would
    // arrive with the last run's pack already in it.
    await seedRegisteredSession(page, { label: `cf-006-${browserName}` });

    const step = walkthrough(page, {
      id: "CF-006",
      title: "A producer brings their own sounds into a pack",
    });

    // 1. You arrive on the dashboard signed in to your own account, not
    //    working as a guest.
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect(page.getByText(GUEST_NOTICE)).toHaveCount(0);
    await step("You arrive on the dashboard, signed in to your own account");

    // 2. Open a project, so the library browser is on screen.
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    await page.getByTestId("arrangement-view-ready").waitFor();
    await openLibrary(page);
    const libraryUrl = page.url();
    await step("Open a project — the library browser is on screen");

    // 3. Choose "Add pack". A new pack appears in the browser with its name
    //    in an input, waiting to be typed.
    await library(page).getByRole("button", { name: "Add pack" }).click();
    const nameInput = library(page).getByRole("textbox", { name: "Pack name" });
    await expect(nameInput).toBeFocused();
    await step("Choose Add pack — the new pack's name is waiting to be typed");

    // 4. Type a name for the pack and press Return. The pack is now listed,
    //    and empty.
    await nameInput.fill(PACK_NAME);
    await nameInput.press("Enter");
    await expect(nameInput).toBeHidden();
    await expect(personalPack(page)).toBeVisible();
    // Opening the pack is what shows what is in it; a pack the producer just
    // made has nothing.
    await personalPack(page)
      .getByRole("button", { name: new RegExp(PACK_NAME) })
      .click();
    await expect(packSounds(page)).toBeVisible();
    await expect(sounds(packSounds(page))).toHaveCount(0);
    await step("Name the pack — it is listed, and empty");

    // 5. Drag three audio files from the desktop onto that pack. Each shows
    //    its own progress, and each lands as a sound in the pack when it
    //    finishes.
    //
    // "Each shows its own progress" is asserted as one row per dropped file,
    // each of which becomes an auditionable sound of its own. A test cannot
    // reliably catch a progress bar mid-flight against a local emulator — it
    // may already have finished — but it can prove the import is per file
    // rather than one opaque batch, which is what the step is about. The
    // progress indicator itself is asserted at the component layer.
    await dropAudioFiles(page, personalPack(page), FILE_NAMES);
    for (const fileName of FILE_NAMES) {
      await expect(soundFrom(packSounds(page), fileName)).toBeVisible({
        timeout: 30_000,
      });
    }
    await expect(sounds(packSounds(page))).toHaveCount(FILE_NAMES.length);
    await step("Drop three files on the pack — each lands as a sound");

    // 6. Audition one of them from the browser, and find it by searching the
    //    library the same way you would find a factory sound.
    //
    // Auditioning is asserted in Chromium only: in Firefox here a fresh
    // `AudioContext` constructs but `resume()` never settles, so no preview
    // can start. The same known, tracked gap CF-001 and
    // `tests/e2e/emulator/slice.spec.ts` carry — see docs/testing.md,
    // "Playback is asserted in Chromium only", and issue #43. The search
    // half of this step runs in both gating browsers.
    const canAssertAudition = browserName === "chromium";
    test.info().annotations.push({
      type: canAssertAudition ? "playback-asserted" : "playback-skipped",
      description: canAssertAudition
        ? `audition asserted in ${browserName}`
        : `audition not asserted in ${browserName}: AudioContext.resume() is refused here — see HARD-001`,
    });
    if (canAssertAudition) {
      const audition = soundFrom(packSounds(page), FILE_NAMES[0]);
      await audition.click();
      await expect(audition).toHaveAttribute("aria-pressed", "true");
      await step("Audition one of the imported sounds");
    }

    // The same search box a producer finds a factory sound with.
    const stem = FILE_NAMES[1].replace(/\.[^.]+$/, "").split("-")[0];
    await library(page).getByRole("searchbox", { name: "Search sounds" }).fill(stem);
    await expect(soundFrom(library(page), FILE_NAMES[1])).toBeVisible();
    await step("Find it by searching the library");

    // 7. Reload the page. The pack and all three sounds are still there.
    await reloadPage(page);
    await expect(page).toHaveURL(libraryUrl);
    await expectView(page, "Library");
    await expect(personalPack(page)).toBeVisible();
    await personalPack(page)
      .getByRole("button", { name: new RegExp(PACK_NAME) })
      .click();
    await expect(sounds(packSounds(page))).toHaveCount(FILE_NAMES.length);
    await step("Reload — the pack and all three sounds are still there");
  });
});
