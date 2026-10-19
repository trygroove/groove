import type { Locator, Page } from "@playwright/test";
import { walkthrough } from "../../support/walkthrough";
import {
  arrangement,
  assistantButton,
  composer,
  conversation,
  newProject,
  panel,
  proposal,
  proposalButton,
  recommendation,
  recommendationButton,
  recommendedSound,
  seedDisclosureAnswered,
} from "../support/assistant";
import { expect, test } from "../support/test";
import { expectView } from "../support/views";

/**
 * `CF-036`: a producer builds a first beat with Coproducer, one card at a time.
 *
 * Read the flow in `docs/core-flows.md`. The numbered comments are its steps,
 * in its words. This is the acceptance contract for GRV-129 (assistant cards
 * one at a time, each aimed at its own pad), and it is frozen once it lands: a
 * later PR that changes an assertion here has to say so in its body and
 * justify it.
 *
 * The marker it carried while the panel showed every card of a turn at once,
 * and aimed a recommendation for a pad the proposal adds at the selected pad,
 * was removed by the PR that completes GRV-129.
 *
 * **Locators.** The assistant's are `../support/assistant.ts`'s. Three are
 * this spec's own, written from the issue:
 *
 *  - a card's held line is its text "<n> more after this";
 *  - a recommended pack's header names its target as "<track> · <pad>";
 *  - a pad's sample slot is the "Sample for <pad>" button inside the drum
 *    machine region named "Drum machine: <track>", whose `.sample-slot-name`
 *    names the sound (as `../support/library.ts` reads BD's). A track is shown
 *    on the instrument view by its "Edit <track>" button.
 *
 * **The scripted provider.** The flow's precondition is that the emulator
 * suite's gateway answers from a scripted provider (#69): asked for the
 * first-beat lesson (`[first-beat]`), it proposes the "Snare & Hat" drum
 * machine and recommends a kick, a snare and a hat for BD, Snare and Hat in
 * one turn. The spec cannot arrange that itself, and does not try. The sounds
 * are read off each card, so the spec pins the journey, not the script's
 * choice of sound.
 *
 * Out of scope, per the flow: what the assistant says, declining the proposal,
 * dismissing a card, a card for a pad that is not in the song, the gateway's
 * check of a recommendation's target, and audibility.
 *
 * Runs against the Firestore/Auth emulator because the gateway it talks to is
 * the emulator's function.
 */

const ASK = "Let's build my first beat [first-beat]";
const KIT = "Snare & Hat";

/** A pad's sample slot, on the drum machine of `track`. */
const padSlot = (page: Page, track: string, pad: string): Locator =>
  page
    .getByRole("region", { name: `Drum machine: ${track}`, exact: true })
    .getByRole("button", { name: `Sample for ${pad}`, exact: true });

/** The sound a pad's sample slot names. */
async function padSound(page: Page, track: string, pad: string): Promise<string> {
  const name = padSlot(page, track, pad).locator(".sample-slot-name");
  return ((await name.textContent()) ?? "").trim();
}

/** Show `track` on the instrument view, and `pad`'s slot on it. */
async function showPad(page: Page, track: string, pad: string): Promise<void> {
  await page
    .getByRole("button", { name: `Edit ${track}`, exact: true })
    .first()
    .click();
  const kit = page.getByRole("region", { name: `Drum machine: ${track}`, exact: true });
  await expect(kit).toBeVisible();
  await kit.getByRole("button", { name: `Audition ${pad}`, exact: true }).click();
  await expect(padSlot(page, track, pad)).toBeVisible();
}

/** Every recommended pack in the conversation, oldest first. */
const recommendations = (page: Page): Locator =>
  panel(page).getByRole("region", { name: /^Recommended pack\b/ });

/**
 * Try the sound of the turn's card at `index` on `pad` of `track`, keep it,
 * and return its name once the pad's slot names it. The card is read by its
 * place, not as the newest: keeping a sound brings the next card up below it.
 */
async function tryAndKeep(
  page: Page,
  index: number,
  track: string,
  pad: string,
): Promise<string> {
  const card = recommendations(page).nth(index);
  const sound = await recommendedSound(page, 0);
  await card.getByRole("button", { name: `Try on ${pad}`, exact: true }).click();
  await expectView(page, "Instrument");
  await card.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(card.locator("output")).toContainText(/kept/i);
  await expect.poll(() => padSound(page, track, pad)).toBe(sound);
  return sound;
}

test.describe("CF-036", () => {
  // biome-ignore format: unparked by removing only test.fixme, so the frozen body keeps its lines
  test(
    "a producer builds a first beat with Coproducer, one card at a time",
    async ({ page, browserName, invitedProducer }) => {
      // The account met the assistant's disclosure in an earlier session (GRV-8).
      await seedDisclosureAnswered(invitedProducer.uid);
      const step = walkthrough(page, {
        id: "CF-036",
        title: "A producer builds a first beat with Coproducer, one card at a time",
      });

      // 1. Create a new project. It opens on the arrangement, with the starter
      //    kick on the drum machine's "BD" pad.
      await newProject(page);
      await expect(arrangement(page)).toBeVisible();

      // 2. Press the Coproducer button, type "Let's build my first beat
      //    [first-beat]" and press Enter. Your message appears in the
      //    conversation, and the assistant's reply follows it.
      await assistantButton(page).click();
      await expect(panel(page)).toBeVisible();
      await composer(page).fill(ASK);
      await page.keyboard.press("Enter");
      await expect(composer(page)).toHaveValue("");
      await expect(conversation(page)).toContainText(ASK);

      // 3. Only the proposal is shown. It says there are 3 more after this. No
      //    recommended pack is on screen yet.
      await expect(proposal(page)).toBeVisible({ timeout: 15_000 });
      await expect(proposal(page)).toContainText(KIT);
      await expect(proposal(page)).toContainText("3 more after this");
      await expect(recommendations(page)).toHaveCount(0);
      await step("Only the proposal, with 3 more after it");

      // 4. Press Apply. The proposal says it was applied. Then the first
      //    recommended pack appears, on its own: its header names BD's track
      //    and pad (BD · BD), it offers to try its sound on BD, and it says
      //    there are 2 more after this.
      await proposalButton(page, "Apply").click();
      await expect(proposal(page)).toContainText(/Applied/);
      await expect(recommendations(page)).toHaveCount(1);
      await expect(recommendation(page)).toContainText("BD · BD");
      await expect(recommendationButton(page, "Try on BD")).toBeVisible();
      await expect(recommendation(page)).toContainText("2 more after this");
      await step("Applied: the kick's card, aimed at BD");

      // 5. Press Try on BD, then Keep. The card says the sound was kept, and
      //    BD's sample slot names it. The next recommended pack appears: its
      //    header names the new track and its Snare pad (Snare & Hat · Snare),
      //    and it offers to try its sound on Snare.
      const kick = await tryAndKeep(page, 0, "BD", "BD");
      await expect(recommendations(page)).toHaveCount(2);
      await expect(recommendation(page)).toContainText(`${KIT} · Snare`);
      await expect(recommendationButton(page, "Try on Snare")).toBeVisible();
      await step("Kick kept on BD: the snare's card, aimed at Snare");

      // 6. Press Try on Snare, then Keep. Snare's sample slot names the kept
      //    snare. The last recommended pack appears, naming Snare & Hat · Hat
      //    and offering to try its sound on Hat. Nothing more is held after it.
      const snare = await tryAndKeep(page, 1, KIT, "Snare");
      await expect(recommendations(page)).toHaveCount(3);
      await expect(recommendation(page)).toContainText(`${KIT} · Hat`);
      await expect(recommendationButton(page, "Try on Hat")).toBeVisible();
      await expect(recommendation(page)).not.toContainText(/more after this/);
      await step("Snare kept: the hat's card, aimed at Hat");

      // 7. Press Try on Hat, then Keep. Hat's sample slot names the kept hat.
      const hat = await tryAndKeep(page, 2, KIT, "Hat");
      await step("Hat kept");

      // 8. Press Play. The song plays. Every pad that has notes has a sound:
      //    BD's slot still names the kick kept in step 5, Snare's the snare and
      //    Hat's the hat.
      //
      // Playback is asserted in Chromium only, as in CF-001 and CF-002:
      // Firefox here refuses `AudioContext.resume()` (HARD-001, #43).
      await page.getByRole("button", { name: "Start playback" }).click();
      if (browserName === "chromium") {
        await expect(page.getByRole("button", { name: "Stop playback" })).toBeVisible();
      }
      await showPad(page, "BD", "BD");
      expect(await padSound(page, "BD", "BD")).toBe(kick);
      await showPad(page, KIT, "Snare");
      expect(await padSound(page, KIT, "Snare")).toBe(snare);
      await showPad(page, KIT, "Hat");
      expect(await padSound(page, KIT, "Hat")).toBe(hat);
      await step("Play: the kick, the snare and the hat each on their own pad");
    },
  );
});
