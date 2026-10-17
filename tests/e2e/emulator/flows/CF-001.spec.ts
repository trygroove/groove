import { expect, type Locator, type Page, test } from "@playwright/test";
import { walkthrough } from "../../support/walkthrough";
import { allowlist, signInWithGoogle, uniqueEmail } from "../support/access";
import { backToArrangement, expectView, sequenceView } from "../support/views";

/**
 * `CF-001` — an invited producer signs in and reaches a playing loop.
 *
 * This is the worked example for the core-flow convention: read
 * `docs/core-flows.md` for the flow this reproduces, and copy this file's shape
 * when writing a new one. Three properties are what make it a *flow* spec
 * rather than an ordinary E2E test:
 *
 *  - It starts at an entrypoint a person could actually arrive at — the public
 *    landing page — and never deep-links into seeded state. That is what makes
 *    the captured walkthrough worth a reviewer's time.
 *  - Its steps are the register's numbered steps, one `step()` caption each, in
 *    the same order and the same words. When they diverge, the register is
 *    right and this file is wrong.
 *  - It asserts the outcome the register promises, and stops. Neighbouring
 *    behavior is covered at the lowest useful layer, not bolted on here — a
 *    flow spec that grows assertions becomes a flow nobody can read.
 *
 * **Rewritten for the alpha allowlist (#854).** The journey used to start with
 * no account at all: "Start in your browser" made the visitor a guest. Guest
 * start is retired, and only an invited (allowlisted) Google address can sign
 * in, so steps 2 and 3 are now signing in with Google from the landing page and
 * arriving signed in. Everything from creating a project onwards is unchanged.
 *
 * **Revised for onboarding (GRV-25).** A new account is taken to the welcome
 * before the dashboard, so step 3 passes through it with "Skip to the studio".
 * The precondition, an address on the list, is set up the way an admin would
 * (`../support/access`), and the sign-in goes through the Auth emulator's own
 * account chooser, so the blocking `beforeSignIn` function decides it exactly
 * as it does in production.
 *
 * Runs against the Firestore/Auth emulator, like every core flow (`TEST-001`).
 * CF-001's register entry claims nothing about persistence, and this spec
 * asserts nothing about it.
 */

/** One bar of the alpha's fixed 4/4 at 192 PPQ (`src/domain/time.ts`). */
const TICKS_PER_BAR = 4 * 192;

/**
 * The vertical middle of one track row, in the timeline canvas's coordinates.
 *
 * Read off the arrangement root rather than written down here. These two
 * numbers used to be copies — `22` and `28` — and when the row height became
 * `84` the copies did not go red: the old centre of row 0 still landed inside
 * the taller row 0, so a stale spec went on passing while describing a layout
 * that no longer existed. The horizontal scale was never copied for exactly
 * that reason (`data-pixels-per-tick`, the hook CF-004 introduced); this is
 * the same hook on the other axis.
 */
const rowCentreY = async (page: Page, rowIndex: number): Promise<number> => {
  const root = page.getByTestId("arrangement-view-ready");
  const rulerHeight = Number(await root.getAttribute("data-ruler-height"));
  const rowHeight = Number(await root.getAttribute("data-row-height"));
  expect(rowHeight).toBeGreaterThan(0);
  return rulerHeight + rowIndex * rowHeight + rowHeight / 2;
};

/** The interaction canvas the tracks are drawn on — see CF-008 on why a class. */
const timeline = (page: Page): Locator => page.locator(".arrangement-layer-interactive");

// Part of the per-PR `@sanity` subset (.github/workflows/ci.yml).
test.describe("CF-001", { tag: "@sanity" }, () => {
  test("an invited producer signs in and reaches a playing loop", async ({
    page,
    browserName,
  }) => {
    const step = walkthrough(page, {
      id: "CF-001",
      title: "An invited producer signs in and reaches a playing loop",
    });

    // Precondition: the producer has been invited — their address is on the
    // alpha list.
    const email = uniqueEmail(`cf-001-${browserName}`);
    await allowlist(email);

    // 1. Open the landing page.
    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: /Finish the tracks you start/ }),
    ).toBeVisible();
    await step("Open the landing page");

    // 2. Choose Sign in, and sign in with Google as the invited address.
    await signInWithGoogle(page, email, () =>
      page.getByRole("button", { name: "Sign in", exact: true }).first().click(),
    );

    // 3. You arrive signed in at the welcome, where Cue introduces itself.
    //    Choose Skip to the studio: you are on the dashboard, with no projects
    //    yet. (Revised for GRV-25: a new account meets Cue first; the welcome
    //    is CF-035's subject.)
    await expect(page).toHaveURL(/\/welcome$/);
    await expect(page.getByRole("heading", { level: 1, name: "Cue" })).toBeVisible();
    await page.getByRole("button", { name: "Skip to the studio" }).click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(page.getByText(/You're working as a guest/)).toHaveCount(0);
    await expect(page.getByText("No projects yet")).toBeVisible();
    await step("You arrive at the dashboard signed in, with no projects yet");

    // 4. Create a new project.
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);

    // 5. It opens on the arrangement, with a starter pattern on its only
    //    track.
    await page.getByTestId("arrangement-view-ready").waitFor();
    await expect(
      page.getByRole("list", { name: "Arrangement tracks" }).getByRole("listitem"),
    ).toHaveCount(1);
    await step("The new project opens on the arrangement, with a starter pattern");

    // 6. Open that clip. The sequence view fills the page, showing the pattern on the
    //    "BD" pad: steps 1, 5, 9 and 13 on.
    //
    // Where the clip is drawn can only be reached as a coordinate: bar 1 of
    // the first row, through the horizontal scale the arrangement publishes
    // (`data-pixels-per-tick`, the hook CF-004 introduced).
    const pixelsPerTick = Number(
      await page
        .getByTestId("arrangement-view-ready")
        .getAttribute("data-pixels-per-tick"),
    );
    expect(pixelsPerTick).toBeGreaterThan(0);
    await timeline(page).dblclick({
      position: {
        x: (TICKS_PER_BAR / 2) * pixelsPerTick,
        y: await rowCentreY(page, 0),
      },
    });

    await expectView(page, "Sequence");
    await expect(sequenceView(page)).toBeVisible();
    // The starter project's four-on-the-floor clip: the kick pad "BD", steps
    // 1, 5, 9, 13 on. Two of them, plus an off step, so this cannot pass
    // against an empty grid. The starter is a drum machine (#496), so the
    // lane is the pad's own name, not the sampler's old "Notes" lane.
    await expect(
      sequenceView(page).getByRole("button", { name: "BD, step 1, on" }),
    ).toBeVisible();
    await expect(
      sequenceView(page).getByRole("button", { name: "BD, step 5, on" }),
    ).toBeVisible();
    await expect(
      sequenceView(page).getByRole("button", { name: "BD, step 2, off" }),
    ).toBeVisible();
    await step("Open the clip — the sequence editor shows the starter pattern");

    // 7. Turn on a step that was off on the "BD" pad, and press 1 to go back to the
    //    arrangement.
    await sequenceView(page).getByRole("button", { name: "BD, step 2, off" }).click();
    await expect(
      sequenceView(page).getByRole("button", { name: "BD, step 2, on" }),
    ).toBeVisible();
    await step("Turn on a step that was off");

    await backToArrangement(page);

    // 8. Start playback.
    //
    // The transport is what this asserts — that the button flips to its
    // playing state, which only happens once `useProjectAudio.play()` has
    // resumed the shared AudioRuntime and started the transport. It is NOT an
    // assertion that a sound reached a speaker: a headless browser records no
    // audio and Playwright captures none. See docs/core-flows.md's "Out of
    // scope" for this flow, docs/testing.md, and issue #43.
    //
    // Asserted in Chromium only — the known, tracked gap this flow's own "Out
    // of scope" already names, and the same guard `tests/e2e/emulator/shortcuts.spec.ts` and
    // `tests/e2e/emulator/slice.spec.ts` carry. In Firefox here `AudioContext`
    // constructs but its `resume()` never settles, so `play()` times out into
    // `audio_start_failed` and the button never becomes "Stop playback".
    // `LOOP-003` bounded that hang; it did not make Firefox play. The cause is
    // `HARD-001`'s real-hardware cross-browser pass — do not unguard this
    // before then. See docs/testing.md, "Playback is asserted in Chromium
    // only", and issue #43.
    const canAssertPlayback = browserName === "chromium";
    test.info().annotations.push({
      type: canAssertPlayback ? "playback-asserted" : "playback-skipped",
      description: canAssertPlayback
        ? `playback asserted in ${browserName}`
        : `playback not asserted in ${browserName}: AudioContext.resume() is refused here — see HARD-001`,
    });

    // The click itself runs in every gating browser: the gesture, the command
    // path behind it and the button staying mounted are real coverage, and a
    // crash on click would still fail here. Only the transport's *playing*
    // state is Chromium-only.
    await page.getByRole("button", { name: "Start playback" }).click();
    if (canAssertPlayback) {
      await expect(page.getByRole("button", { name: "Stop playback" })).toBeVisible();
      // The walkthrough is captured from the Chromium run
      // (`walkthrough:capture` passes `--project=chromium`), so this caption
      // is only ever recorded from a run that actually asserted it.
      await step("Start playback — the transport is running");
    }
  });
});
