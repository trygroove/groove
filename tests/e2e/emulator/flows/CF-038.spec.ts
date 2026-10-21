import type { Locator, Page } from "@playwright/test";
import { walkthrough } from "../../support/walkthrough";
import {
  arrangement,
  assistantButton,
  composer,
  newProject,
  reloadSaved,
  seedDisclosureAnswered,
} from "../support/assistant";
import { conversationIn, cuePanel } from "../support/onboarding";
import { expect, test } from "../support/test";
import { dockTile, expectView } from "../support/views";

/**
 * `CF-038`: a producer finishes a track with Coproducer and exports its stems.
 *
 * Read the flow in `docs/core-flows.md`. The numbered comments are its steps,
 * in its words. This is the acceptance contract for GRV-44 ("Finish a
 * track"), and it is frozen once it lands: a later PR that changes an
 * assertion here has to say so in its body and justify it.
 *
 * **The account** has been through onboarding with nothing in memory (the
 * suite's `test` seeds it so), so its beat is four on the floor, in A minor.
 *
 * **Locators.** The panel's are `../support/onboarding.ts`'s, the lesson's
 * CF-037's: a region named "Lesson" headed by its chapter's title, a list
 * named "Bites" whose items say "done", "skipped" or "already in your song",
 * "Show me" and "Skip" buttons, "Next: <bite>" within a chapter and "Next
 * chapter: <chapter>" between them. The arrangement's clips are read from
 * its "Clips" list, whose options end "on <track>, bars <first> to <last>".
 *
 * **The scripted provider** starts "Finish a track" for a message carrying
 * `[track-lesson]`, and answers a lesson's turn with a short reply naming the
 * bite (`lessonReplyText` in `src/assistant/emulatorProvider.ts`); the end of
 * the lesson as `That's "Finish a track" finished`.
 *
 * Runs against the Firestore/Auth emulator because the gateway it talks to is
 * the emulator's function, and step 8 is a real reload.
 */

const ASK = "Teach me to finish a track [track-lesson]";

const CHAPTERS = {
  beat: {
    title: "Make a beat",
    bites: [
      "Pick a kick",
      "The kick pattern",
      "Hear it",
      "The backbeat",
      "Hats",
      "Loop it",
    ],
  },
  bass: { title: "Bass", bites: ["Pick a key", "Under the kick", "Round it off"] },
  chords: {
    title: "Chords and hook",
    bites: ["A chord loop", "The hook", "Pluck the hook"],
  },
  arrange: {
    title: "Arrange, subtractively",
    bites: ["Copy the loop out", "An intro", "A breakdown", "The drop", "A short outro"],
  },
  mix: {
    title: "Mix and export",
    bites: [
      "Balance",
      "Pan",
      "Reverb on the hook",
      "Watch the master",
      "Export the stems",
    ],
  },
} as const;

const lesson = (page: Page): Locator =>
  cuePanel(page).getByRole("region", { name: "Lesson", exact: true });

/** A bite in the list by its whole title: "The hook", never "Pluck the hook". */
const bite = (page: Page, name: string): Locator =>
  lesson(page)
    .getByRole("list", { name: "Bites" })
    .getByRole("listitem")
    .filter({
      hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s*·|$)`),
    });

const lessonButton = (page: Page, name: string): Locator =>
  lesson(page).getByRole("button", { name, exact: true });

/** Coproducer's replies in the panel's conversation, not the producer's lines. */
const replySaying = (page: Page, words: string): Locator =>
  conversationIn(cuePanel(page)).locator(".assistant-reply").filter({ hasText: words });

/** The arrangement's clip that plays on `track` over `bars` ("bars 9 to 28"). */
const clip = (page: Page, track: string, bars: string): Locator =>
  page
    .getByRole("listbox", { name: "Clips" })
    .getByRole("option", { name: new RegExp(` on ${track}, ${bars}$`) });

const stop = (page: Page) => page.getByRole("button", { name: "Stop playback" }).click();

/** Goes on to `name` with its "Next" button, and checks it is under way. */
async function next(page: Page, name: string): Promise<void> {
  await lessonButton(page, `Next: ${name}`).click({ timeout: 15_000 });
  await expect(bite(page, name)).toHaveAttribute("aria-current", "step");
}

/** Goes on to `chapter` with "Next chapter", and checks its first bite is under way. */
async function nextChapter(
  page: Page,
  chapter: { readonly title: string; readonly bites: readonly string[] },
): Promise<void> {
  await lessonButton(page, `Next chapter: ${chapter.title}`).click({ timeout: 15_000 });
  await expect(lesson(page).getByRole("heading", { name: chapter.title })).toBeVisible();
  await expect(bite(page, chapter.bites[0])).toHaveAttribute("aria-current", "step");
}

/**
 * Presses Show me on each of the bite's steps until it is marked done: a
 * press either finishes the bite or moves it on to its next step.
 */
async function showMe(page: Page, name: string): Promise<void> {
  const done = bite(page, name).filter({ hasText: /· done/ });
  for (let press = 0; press < 3; press += 1) {
    const step = lesson(page).locator(".lesson-step");
    const before = (await step.textContent()) ?? "";
    await lessonButton(page, "Show me").click();
    await expect
      .poll(
        async () =>
          (await done.count()) > 0 ||
          ((await step.count()) > 0 && (await step.textContent()) !== before),
        { timeout: 20_000 },
      )
      .toBe(true);
    if ((await done.count()) > 0) return;
  }
  await expect(done).toHaveCount(1);
}

/** A bite that needs the song to play: shown in Chromium, skipped elsewhere. */
async function listen(page: Page, name: string, browserName: string): Promise<void> {
  if (browserName === "chromium") {
    await showMe(page, name);
    await stop(page);
    return;
  }
  // HARD-001 (issue #43): elsewhere the context never resumes, so the song
  // never plays. Any step before the listening is shown, then it is skipped.
  while (
    (await bite(page, name)
      .filter({ hasText: /· (done|skipped)/ })
      .count()) === 0
  ) {
    const step = (await lesson(page).locator(".lesson-step").textContent()) ?? "";
    if (/play|Play/.test(step)) await lessonButton(page, "Skip").click();
    else await lessonButton(page, "Show me").click();
    await page.waitForTimeout(250);
  }
}

test.describe("CF-038", () => {
  // biome-ignore format: unparked by removing only test.fixme, so the frozen body keeps its lines
  test.fixme(
    "a producer finishes a track with Coproducer and exports its stems",
    async ({ page, browserName, invitedProducer }) => {
      // The longest journey there is: five chapters, each bite answered.
      test.setTimeout(300_000);
      // The account met the assistant's disclosure in an earlier session (GRV-8).
      await seedDisclosureAnswered(invitedProducer.uid);
      const step = walkthrough(page, {
        id: "CF-038",
        title: "A producer finishes a track with Coproducer and exports its stems",
      });

      // 1. Make a new project, open Coproducer and ask it to teach you to
      //    finish a track. The lesson appears in the panel: "Finish a track",
      //    chapter 1 of 5, "Make a beat", with "Pick a kick" under way and
      //    "The kick pattern" marked as already in your song.
      await newProject(page);
      await assistantButton(page).click();
      await composer(page).fill(ASK);
      await page.keyboard.press("Enter");
      await expect(lesson(page)).toBeVisible({ timeout: 15_000 });
      await expect(lesson(page)).toContainText("Finish a track · chapter 1 of 5");
      await expect(
        lesson(page).getByRole("heading", { name: CHAPTERS.beat.title }),
      ).toBeVisible();
      await expect(bite(page, "Pick a kick")).toHaveAttribute("aria-current", "step");
      await expect(bite(page, "The kick pattern")).toContainText("already in your song");
      await step("Finish a track starts in Coproducer's panel");
      // 2. Go through "Make a beat" with Show me: Pick a kick, Hear it, The
      //    backbeat, Hats and Loop it, each marked done. The chapter is over:
      //    Coproducer wraps it up, and the lesson offers the next chapter.
      await showMe(page, "Pick a kick");
      await next(page, "Hear it");
      await listen(page, "Hear it", browserName);
      for (const name of ["The backbeat", "Hats", "Loop it"]) {
        await next(page, name);
        await showMe(page, name);
      }
      await expect(replySaying(page, `That's "${CHAPTERS.beat.title}" finished`)).toHaveCount(
        1,
        { timeout: 15_000 },
      );
      // 3. Go on to "Bass" and through it with Show me: a Bass track joins
      //    the song, in A minor, its bassline running four bars under the beat.
      await nextChapter(page, CHAPTERS.bass);
      // Its first step adds the Bass track; then it asks for the genre's key.
      await lessonButton(page, "Show me").click();
      await expect(lesson(page)).toContainText("A minor");
      await showMe(page, CHAPTERS.bass.bites[0]);
      for (const name of CHAPTERS.bass.bites.slice(1)) {
        await next(page, name);
        await showMe(page, name);
      }
      await dockTile(page, "Arrangement").click();
      await expectView(page, "Arrangement");
      await expect(clip(page, "Bass", "bars 1 to 4")).toHaveCount(1);
      await step("The bass, under the kick");
      // 4. Go on and through "Chords and hook" with Show me: Chords and Hook
      //    tracks join, each running four bars.
      await nextChapter(page, CHAPTERS.chords);
      await showMe(page, CHAPTERS.chords.bites[0]);
      for (const name of CHAPTERS.chords.bites.slice(1)) {
        await next(page, name);
        await showMe(page, name);
      }
      await expect(clip(page, "Chords", "bars 1 to 4")).toHaveCount(1);
      await expect(clip(page, "Hook", "bars 1 to 4")).toHaveCount(1);
      // 5. Go on and through "Arrange, subtractively" with Show me. On the
      //    arrangement the Hook plays bars 9 to 28 and BD bars 1 to 8 and 17
      //    to 28.
      await nextChapter(page, CHAPTERS.arrange);
      await showMe(page, "Copy the loop out");
      await expect(clip(page, "Hook", "bars 1 to 32")).toHaveCount(1);
      for (const name of ["An intro", "A breakdown"]) {
        await next(page, name);
        await showMe(page, name);
      }
      await next(page, "The drop");
      await listen(page, "The drop", browserName);
      await next(page, "A short outro");
      await showMe(page, "A short outro");
      await expect(clip(page, "Hook", "bars 9 to 28")).toHaveCount(1);
      await expect(clip(page, "BD", "bars 1 to 8")).toHaveCount(1);
      await expect(clip(page, "BD", "bars 17 to 28")).toHaveCount(1);
      await step("Arranged by taking parts away");
      // 6. Go on and through "Mix and export" with Show me: Balance, Pan, and
      //    Reverb on the hook. Watch the master: the master strip has its own
      //    level meter, and Show me plays the drop while you watch it.
      await nextChapter(page, CHAPTERS.mix);
      await showMe(page, "Balance");
      for (const name of ["Pan", "Reverb on the hook"]) {
        await next(page, name);
        await showMe(page, name);
      }
      await dockTile(page, "Mixer").click();
      await expectView(page, "Mixer");
      await expect(page.getByRole("meter", { name: "Master level" })).toHaveCount(1);
      await expect(
        page.getByRole("button", { name: "Remove send from Hook to Reverb" }),
      ).toHaveCount(1);
      await next(page, "Watch the master");
      await listen(page, "Watch the master", browserName);
      await step("Mixed, with the master meter watched");
      // 7. The last bite opens the Export dialog by itself with Stems (ZIP)
      //    chosen and every track picked in its list. Press Export. The bite is done and the lesson leaves the
      //    panel. Close the dialog. Coproducer's wrap-up of the whole track
      //    follows in the conversation.
      await lessonButton(page, "Next: Export the stems").click({ timeout: 15_000 });
      const dialog = page.getByRole("dialog", { name: "Export" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("radio", { name: "Stems (ZIP)" })).toBeChecked();
      const stems = dialog.getByRole("listbox", { name: "Tracks to export" });
      await expect(stems.getByRole("option").first()).toBeVisible();
      await expect(stems.getByRole("option", { selected: false })).toHaveCount(0);
      await step("The Export dialog, on stems");
      await dialog.getByRole("button", { name: "Export", exact: true }).click();
      await expect(lesson(page)).toHaveCount(0);
      await dialog.getByRole("button", { name: "Close export" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(replySaying(page, `That's "Finish a track" finished`)).toHaveCount(1, {
        timeout: 15_000,
      });
      await step("The track is finished");
      // 8. Reload the page. The track is still there: the Bass, Chords and
      //    Hook tracks, the Hook playing bars 9 to 28 and BD bars 1 to 8 and
      //    17 to 28.
      await reloadSaved(page);
      await dockTile(page, "Arrangement").click();
      await arrangement(page).waitFor();
      await expect(clip(page, "Hook", "bars 9 to 28")).toHaveCount(1);
      await expect(clip(page, "BD", "bars 1 to 8")).toHaveCount(1);
      await expect(clip(page, "BD", "bars 17 to 28")).toHaveCount(1);
      await expect(page.getByRole("listbox", { name: "Clips" })).toContainText("on Bass");
      await expect(page.getByRole("listbox", { name: "Clips" })).toContainText("on Chords");
    },
  );
});
