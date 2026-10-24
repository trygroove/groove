import { expect, type Locator, type Page, test } from "@playwright/test";
import { walkthrough } from "../../support/walkthrough";
import { arrangement, reloadSaved } from "../support/assistant";
import { seedRegisteredSession } from "../support/authSession";
import {
  askOption,
  conversationIn,
  cuePanel,
  expectQuestion,
  sendAnswer,
  skipQuestion,
} from "../support/onboarding";
import { dockTile, expectView } from "../support/views";

/**
 * `CF-037`: a new producer makes a beat with Coproducer.
 *
 * Read the flow in `docs/core-flows.md`. The numbered comments are its steps,
 * in its words. This is the acceptance contract for GRV-43 (assistant
 * lessons, bite-sized), and it is frozen once it lands: a later PR that
 * changes an assertion here has to say so in its body and justify it.
 *
 * **The account** has never been through onboarding, like CF-035's, so it
 * seeds its own with Playwright's `test`.
 *
 * **Locators.** The welcome's and the panel's are `../support/onboarding.ts`'s.
 * The lesson's are this spec's own, written from the issue:
 *
 *  - the Lessons list is a region named "Lessons" that the panel's "Lessons"
 *    button shows in place of the conversation, a button per lesson (GRV-190);
 *  - the lesson is a region named "Lesson" at the top of Coproducer's panel,
 *    headed "Lesson · <lesson>" (GRV-190);
 *  - its bites are a list named "Bites", one item per bite, whose text says
 *    "done" or "skipped" once it is;
 *  - its step offers "Show me" and "Skip" buttons, and a finished bite a
 *    "Next: <bite>" button;
 *  - a term in a step is a button named by the term, and its meaning is shown
 *    under the step.
 *
 * **The scripted provider** answers a lesson's turn with a short reply that
 * names the bite (`lessonReplyText` in `src/assistant/emulatorProvider.ts`).
 * The spec reads Coproducer's replies alone, never the producer's side of the
 * log, whose lesson lines already name every bite and the chapter; and it
 * reads which moment a reply answers (a bite started, finished, the chapter
 * finished) by the scripted reply's own words, since a bite's name alone is
 * in every reply about it.
 *
 * Runs against the Firestore/Auth emulator because the gateway it talks to is
 * the emulator's function, and step 12 is a real reload.
 */

const CHAPTER = "Make a beat";
const BITES = [
  "Pick a kick",
  "The kick pattern",
  "Hear it",
  "The backbeat",
  "Hats",
  "Loop it",
] as const;

const lesson = (page: Page): Locator =>
  cuePanel(page).getByRole("region", { name: "Lesson", exact: true });

const bite = (page: Page, name: string): Locator =>
  lesson(page)
    .getByRole("list", { name: "Bites" })
    .getByRole("listitem")
    .filter({ hasText: name });

/** Coproducer's replies in the panel's conversation, not the producer's lines. */
const replies = (page: Page): Locator =>
  conversationIn(cuePanel(page)).locator(".assistant-reply");

/** Coproducer's reply that says `words`, as the scripted provider writes it. */
const replySaying = (page: Page, words: string): Locator =>
  replies(page).filter({ hasText: words });

const lessonButton = (page: Page, name: string): Locator =>
  lesson(page).getByRole("button", { name, exact: true });

/** BD's drum machine, on the instrument view. */
const kit = (page: Page): Locator =>
  page.getByRole("region", { name: "Drum machine: BD", exact: true });

/** The sound BD's pad plays, as its sample slot names it. */
const padSound = (page: Page): Locator =>
  kit(page)
    .getByRole("button", { name: "Sample for BD", exact: true })
    .locator(".sample-slot-name");

const sequenceView = (page: Page): Locator =>
  page.getByRole("region", { name: "Sequence editor" });

/** Goes on to the next bite, and checks it is the one under way. */
async function next(page: Page, name: string): Promise<void> {
  await lessonButton(page, `Next: ${name}`).click();
  await expect(bite(page, name)).toHaveAttribute("aria-current", "step");
}

/**
 * Whether a press of Play started the song. Outside Chromium it depends on
 * the browser (HARD-001, issue #43): WebKit's context resumes and the button
 * flips to "Stop playback", Firefox's resume never settles. The editor gives
 * up on a resume after `DEFAULT_RESUME_TIMEOUT_MS` (5 s), so a song that has
 * not started a little after that never will.
 */
async function startedWithinResumeTimeout(stopPlayback: Locator): Promise<boolean> {
  return stopPlayback
    .waitFor({ state: "visible", timeout: 7_000 })
    .then(() => true)
    .catch(() => false);
}

test.describe("CF-037", () => {
  // biome-ignore format: unparked by removing only test.fixme, so the frozen body keeps its lines
  test(
    "a new producer makes a beat with Coproducer",
    async ({ page, browserName }) => {
      // A long journey: the welcome, then six bites, each answered.
      test.setTimeout(120_000);
      await seedRegisteredSession(page, {
        label: `cf-037-${browserName}`,
        onboarded: false,
      });
      const step = walkthrough(page, {
        id: "CF-037",
        title: "A new producer makes a beat with Coproducer",
      });

      // 1. Open the dashboard. At the welcome, pick Hip hop and send, skip how
      //    much music you have made, pick "My first track", and skip the last
      //    two questions. Coproducer offers a first lesson: a quick tour of the
      //    studio, "Tour the studio", before making something.
      await page.goto("/projects");
      await expect(page).toHaveURL(/\/welcome$/);
      await expectQuestion(page, /music do you love/i);
      await askOption(page, "Hip hop").click();
      await sendAnswer(page).click();
      await expectQuestion(page, /how much music have you made/i);
      await skipQuestion(page).click();
      await expectQuestion(page, /goal/i);
      await askOption(page, "My first track").click();
      await expectQuestion(page, /like to learn/i);
      await skipQuestion(page).click();
      await expectQuestion(page, /gear/i);
      await skipQuestion(page).click();
      await expect(conversationIn(page)).toContainText("Tour the studio");
      await expect(conversationIn(page)).toContainText(
        "Let's start with a quick tour of the studio, then we'll make something",
      );
      await step("Coproducer offers a first lesson");

      // 2. Choose Open the studio, and OK on the notice about Groove keeping
      //    conversations. The offer waits in Coproducer's panel.
      await page.getByRole("button", { name: "Open the studio" }).click();
      await arrangement(page).waitFor();
      await cuePanel(page).getByRole("button", { name: "OK" }).click();
      await expect(askOption(cuePanel(page), "Let's go")).toBeVisible();

      // 3. Choose "Not now", and press Lessons in the panel's header. Every
      //    lesson is listed, the tour first, none started. Press "Make a beat".
      //    The list closes and the lesson's plan is at the top of the panel,
      //    whose title says "Coproducer · Lesson": "Make a beat", its six
      //    bites listed with none done, and the first, "Pick a kick", under
      //    way. It asks you to put a kick from the Library on BD's pad, offers
      //    Show me and Skip, and Coproducer's reply follows in the
      //    conversation, saying the lesson has started and that you can leave
      //    it whenever you like.
      await askOption(cuePanel(page), "Not now").click();
      await cuePanel(page).getByRole("button", { name: "Lessons", exact: true }).click();
      const lessons = cuePanel(page).getByRole("region", { name: "Lessons", exact: true });
      await expect(lessons.locator(".lessons-list-title")).toHaveText([
        "Tour the studio",
        CHAPTER,
        "Shape a sound",
        "Finish a track",
      ]);
      await expect(lessons.getByRole("button", { name: /^Tour the studio/ })).toContainText(
        "Not started",
      );
      await lessons.getByRole("button", { name: new RegExp(`^${CHAPTER}`) }).click();
      await expect(lessons).toHaveCount(0);
      await expect(cuePanel(page).locator(".assistant-panel-title")).toHaveText(
        "Coproducer · Lesson",
      );
      await expect(lesson(page)).toBeVisible();
      await expect(lesson(page).getByRole("heading", { name: CHAPTER })).toBeVisible();
      for (const name of BITES) {
        await expect(bite(page, name)).toBeVisible();
        await expect(bite(page, name)).not.toContainText(/done|skipped/);
      }
      await expect(bite(page, BITES[0])).toHaveAttribute("aria-current", "step");
      await expect(lesson(page)).toContainText(/Library/);
      await expect(lessonButton(page, "Show me")).toBeVisible();
      await expect(lessonButton(page, "Skip")).toBeVisible();
      await expect(replySaying(page, `Here's "${BITES[0]}"`)).toHaveCount(1, {
        timeout: 15_000,
      });
      await expect(replySaying(page, `We're starting the "${CHAPTER}" lesson`)).toHaveCount(
        1,
      );
      await step("The lesson starts in Coproducer's panel");

      // 4. Press Show me. A kick from the library lands on BD's pad, and "Pick
      //    a kick" is marked done. Coproducer's reply about it follows, and
      //    the lesson offers the next bite, "The kick pattern".
      await dockTile(page, "Instrument").click();
      await kit(page).getByRole("button", { name: "Audition BD", exact: true }).click();
      const starterKick = ((await padSound(page).textContent()) ?? "").trim();
      expect(starterKick).not.toBe("");
      await lessonButton(page, "Show me").click();
      await expect(bite(page, BITES[0])).toContainText("done");
      await dockTile(page, "Instrument").click();
      await expect(padSound(page)).not.toHaveText(starterKick);
      await expect(replySaying(page, `"${BITES[0]}" is finished`)).toHaveCount(1, {
        timeout: 15_000,
      });
      await expect(lessonButton(page, `Next: ${BITES[1]}`)).toBeVisible({
        timeout: 15_000,
      });
      await step("Show me puts a kick from the library on BD");

      // 5. Press it. The step asks for the boom bap kick: on beat 1 and on
      //    the "and" of beat 3. Press "boom bap" in it: what it means is shown
      //    under the step, and the step is still there.
      await next(page, BITES[1]);
      await expect(lesson(page)).toContainText(/beat 1/);
      await lessonButton(page, "boom bap").click();
      await expect(lessonButton(page, "boom bap")).toHaveAttribute("aria-expanded", "true");
      await expect(lesson(page)).toContainText(/hip hop/i);
      await expect(lessonButton(page, "Show me")).toBeVisible();
      await step("A term, explained without leaving the step");

      // 6. Open the Sequence view and, on BD's row, turn on step 11: the bite
      //    is not done yet, because the starter's kicks on steps 5, 9 and 13
      //    are still on. Turn those three off. "The kick pattern" is marked
      //    done, with nothing pressed in the lesson, and Coproducer's reply
      //    about it follows.
      await dockTile(page, "Sequence").click();
      await expectView(page, "Sequence");
      await sequenceView(page).getByRole("button", { name: "BD, step 11, off" }).click();
      await expect(
        sequenceView(page).getByRole("button", { name: "BD, step 11, on" }),
      ).toBeVisible();
      await expect(bite(page, BITES[1])).not.toContainText("done");
      for (const kick of [5, 9, 13]) {
        await sequenceView(page)
          .getByRole("button", { name: `BD, step ${kick}, on` })
          .click();
      }
      await expect(bite(page, BITES[1])).toContainText("done");
      await expect(replySaying(page, `"${BITES[1]}" is finished`)).toHaveCount(1, {
        timeout: 15_000,
      });
      await expect(lessonButton(page, `Next: ${BITES[2]}`)).toBeVisible({
        timeout: 15_000,
      });
      await step("Done by hand: the boom bap kick, and no other");

      // 7. Go on to "Hear it". It asks for boom bap's tempo, 90 BPM: type 90
      //    in the tempo field. Then press Play. It is marked done. Stop.
      //    (Playing is asserted in Chromium only, the gap CF-001 names: in
      //    other browsers the song may never start, as in Firefox, so there
      //    the bite is skipped to go on when it has not.)
      //
      // That gap is HARD-001 (issue #43): in Firefox the context never
      // resumes, so the song never plays; WebKit's does.
      await next(page, BITES[2]);
      await expect(lesson(page)).toContainText(/90 BPM/);
      const tempo = page.getByRole("spinbutton", { name: "Tempo (BPM)" });
      await tempo.fill("90");
      await tempo.press("Enter");
      await expect(tempo).toHaveValue("90");
      await page.getByRole("button", { name: "Start playback" }).click();
      const stopPlayback = page.getByRole("button", { name: "Stop playback" });
      if (browserName === "chromium") {
        await expect(bite(page, BITES[2])).toContainText("done");
        await stopPlayback.click();
      } else if (await startedWithinResumeTimeout(stopPlayback)) {
        // WebKit's context does resume here, so the song plays and the bite
        // finishes by itself, taking its Skip button with it (GRV-203).
        await expect(bite(page, BITES[2])).toContainText("done");
        await stopPlayback.click();
      } else {
        await lessonButton(page, "Skip").click();
        await expect(bite(page, BITES[2])).toContainText("skipped");
      }

      // 8. Go on to "The backbeat" and press Show me. A Snare pad joins BD's
      //    drum machine with hits on beats 2 and 4, and the bite is marked
      //    done.
      await expect(lessonButton(page, `Next: ${BITES[3]}`)).toBeVisible({
        timeout: 15_000,
      });
      await next(page, BITES[3]);
      await lessonButton(page, "Show me").click();
      await expect(bite(page, BITES[3])).toContainText("done");
      await dockTile(page, "Sequence").click();
      await expect(
        sequenceView(page).getByRole("button", { name: "Snare, step 5, on" }),
      ).toBeVisible();
      await expect(
        sequenceView(page).getByRole("button", { name: "Snare, step 13, on" }),
      ).toBeVisible();

      // 9. Go on to "Hats" and press Skip. It is marked skipped.
      await expect(lessonButton(page, `Next: ${BITES[4]}`)).toBeVisible({
        timeout: 15_000,
      });
      await next(page, BITES[4]);
      await lessonButton(page, "Skip").click();
      await expect(bite(page, BITES[4])).toContainText("skipped");

      // 10. Go on to "Loop it" and press Show me. The beat's clip now runs for
      //     four bars on the arrangement, and the bite is marked done.
      await expect(lessonButton(page, `Next: ${BITES[5]}`)).toBeVisible({
        timeout: 15_000,
      });
      await next(page, BITES[5]);
      await lessonButton(page, "Show me").click();
      await dockTile(page, "Arrangement").click();
      await expectView(page, "Arrangement");
      await expect(
        page
          .getByRole("listbox", { name: "Clips" })
          .getByRole("option", { name: /on BD, bars 1 to 4$/ }),
      ).toHaveCount(1);

      // 11. That was the chapter's last bite: the lesson leaves the panel, its
      //     title is "Coproducer" again, and Coproducer's wrap-up follows in
      //     the conversation, saying the lesson is over.
      await expect(lesson(page)).toHaveCount(0);
      await expect(cuePanel(page).locator(".assistant-panel-title")).toHaveText(
        "Coproducer",
      );
      await expect(replySaying(page, `That's "${CHAPTER}" finished`)).toHaveCount(1, {
        timeout: 15_000,
      });
      await expect(replySaying(page, "The lesson is over")).toHaveCount(1);
      await step("The chapter's done, and Coproducer wraps it up");

      // 12. Reload the page. The beat is still there: the tempo is 90 BPM,
      //     its clip still runs for four bars, and opened in the Sequence
      //     view, BD's step 11 is on and step 5 off, and the Snare pad has its
      //     hits.
      await reloadSaved(page);
      await arrangement(page).waitFor();
      await expect(page.getByRole("spinbutton", { name: "Tempo (BPM)" })).toHaveValue(
        "90",
      );
      const clips = page.getByRole("listbox", { name: "Clips" });
      await expect(clips.getByRole("option", { name: /on BD, bars 1 to 4$/ })).toHaveCount(
        1,
      );
      await clips.focus();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expectView(page, "Sequence");
      await expect(
        sequenceView(page).getByRole("button", { name: "BD, step 11, on" }),
      ).toBeVisible();
      await expect(
        sequenceView(page).getByRole("button", { name: "BD, step 5, off" }),
      ).toBeVisible();
      await expect(
        sequenceView(page).getByRole("button", { name: "Snare, step 5, on" }),
      ).toBeVisible();
      await step("Reloaded: the beat is saved");
    },
  );
});
