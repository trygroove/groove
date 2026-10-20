import { reloadPage } from "./support/reload";
import { expect, type Locator, type Page, test } from "./support/test";

/** One bar at 192 PPQ. */
const TICKS_PER_BAR = 4 * 192;

/**
 * The vertical middle of the first track row, read off the arrangement root
 * rather than copied here — the row height moved from 28 to 84 and every copy
 * of it went on passing, because the old centre still landed inside the taller
 * row. The horizontal scale was already read this way.
 */
async function firstRowCentreY(ready: Locator): Promise<number> {
  const rulerHeight = Number(await ready.getAttribute("data-ruler-height"));
  const rowHeight = Number(await ready.getAttribute("data-row-height"));
  expect(rowHeight).toBeGreaterThan(0);
  return rulerHeight + rowHeight / 2;
}

/**
 * Opens the starter clip the way a producer does — a double-click on the
 * timeline (`UI-001`) — and returns the sequence editor. Sequencing is a window
 * over the arrangement now, so the grid has to be opened before it can be
 * edited; a clip is canvas pixels, reachable only as a point.
 */
async function openStarterClip(page: Page): Promise<Locator> {
  const ready = page.getByTestId("arrangement-view-ready");
  await expect(ready).toBeVisible();
  const pixelsPerTick = Number(await ready.getAttribute("data-pixels-per-tick"));
  await page.locator(".arrangement-layer-interactive").dblclick({
    position: {
      x: (TICKS_PER_BAR / 2) * pixelsPerTick,
      y: await firstRowCentreY(ready),
    },
  });
  const editor = page.getByRole("region", { name: "Sequence editor" });
  await expect(editor).toBeVisible();
  return editor;
}

/** Where `firebase emulators:exec` bound Firestore, as the config reads it. */
const firestoreEmulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";

interface StoredPackDependency {
  mapValue: {
    fields: { packId: { stringValue: string }; version: { stringValue: string } };
  };
}

/**
 * The open project's saved pack dependencies, as `id @ version`, read from the
 * emulator's metadata document (`Bearer owner` is the emulator's admin
 * token, so the rules do not apply). The editor does not print them.
 */
async function savedPackDependencies(page: Page): Promise<string[]> {
  // The id, not the last segment: the sequence view has its own (UI-002).
  const projectId = /\/projects\/([^/]+)/.exec(new URL(page.url()).pathname)?.[1];
  const response = await page.request.get(
    `http://${firestoreEmulatorHost}/v1/projects/demo-solid-groove/databases/(default)/documents/projects/${projectId}`,
    { headers: { Authorization: "Bearer owner" } },
  );
  expect(response.ok()).toBe(true);
  const document = await response.json();
  const values: StoredPackDependency[] =
    document.fields?.packDependencies?.arrayValue?.values ?? [];
  return values.map(
    ({ mapValue: { fields } }) =>
      `${fields.packId.stringValue} @ ${fields.version.stringValue}`,
  );
}

/**
 * `FND-009` — the foundation vertical slice, exercised against a real
 * (emulated) backend: open a schema-v1 project, add one note, play it, undo
 * it, save it, reload it, and reproduce playback.
 *
 * Runs against the Firestore + Auth emulator (see `tests/e2e/emulator/playwright.config.ts`),
 * not the in-memory mock dev backend (`VITE_DEV_BACKEND=mock`) — the mock
 * repository is a fresh, empty store on every page load, so it cannot prove
 * anything survives a real `page.reload()`.
 */
// Part of the per-PR `@sanity` subset (.github/workflows/ci.yml).
test.describe("foundation vertical slice", { tag: "@sanity" }, () => {
  test("add a note, play it, undo it, save it, and reload it", async ({
    page,
    browserName,
  }) => {
    // Playback is asserted in Chromium only. See `canAssertPlayback` below.
    const canAssertPlayback = browserName === "chromium";
    // Capture everything the page says, so a failure reports a cause rather
    // than only a timeout. Starting playback is the step most likely to fail
    // for environmental reasons — it needs a real AudioContext, and a headless
    // CI browser may have no audio device — and `useProjectAudio.play()`
    // deliberately swallows that into `audio_start_failed` with no UI surface,
    // so without this the assertion below can only ever say "element not
    // found" and leave the actual reason in the browser's console.
    const pageLog: string[] = [];
    page.on("console", (message) =>
      pageLog.push(`console.${message.type()}: ${message.text()}`),
    );
    page.on("pageerror", (error) => pageLog.push(`pageerror: ${error.message}`));

    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect(page.getByText("No projects yet")).toBeVisible();

    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    const projectUrl = page.url();

    const editor = await openStarterClip(page);
    await expect(editor.getByRole("region", { name: "Step editor" })).toBeVisible();
    // The starter project's four-on-the-floor clip: steps 1, 5, 9, 13 on.
    await expect(editor.getByRole("button", { name: "BD, step 1, on" })).toBeVisible();
    await expect(editor.getByRole("button", { name: "BD, step 3, off" })).toBeVisible();

    // The reopened project must report the same pack dependency it saved
    // (PRD LIB-05, invariant 12) — saved as soon as the starter project
    // is created, since its drum pad's asset resolves through a pack from the start.
    const packDependencies = await savedPackDependencies(page);
    expect(packDependencies).toEqual([
      expect.stringMatching(/^pak_\S+ @ \d+\.\d+\.\d+$/),
    ]);

    // Add a note: dispatches note.add through the shared command layer.
    await editor.getByRole("button", { name: "BD, step 3, off" }).click();
    await expect(editor.getByRole("button", { name: "BD, step 3, on" })).toBeVisible();

    // The revision-checked write actually advances the persisted revision,
    // not just the visible save state.
    await expect(page.locator(".save-status")).toHaveText("Saved", {
      timeout: 10_000,
    });
    const revisionAfterAdd = Number(
      await page.locator(".save-status").getAttribute("data-revision"),
    );

    // Back to the arrangement with 1: the sequence view is a view (UI-002).
    await page.keyboard.press("1");
    await expect(page.getByRole("region", { name: "Sequence editor" })).toHaveCount(0);

    // Play it: the allowed user gesture resumes the shared AudioRuntime and
    // starts the transport.
    //
    // Chromium only, deliberately, and this is a known coverage gap rather
    // than a tidy-up. In this suite Firefox never reaches `setIsPlaying(true)`:
    // a fresh `AudioContext` constructs fine and reports `state="suspended"`,
    // no error is logged anywhere, and `runtime.resume()` simply never settles.
    // Three fixes were tried and none worked — a null ALSA default output
    // device (wrong: the context constructs, so there is no missing-device
    // problem) and then `media.autoplay.*` user prefs (no effect). Firefox
    // cannot be installed in the development sandbox, so each attempt costs a
    // CI round and is made blind.
    //
    // Rather than keep guessing, or weaken the assertion for every browser,
    // the rest of the slice — add, save, revision advance, undo, reload,
    // pack dependency — still runs in both gating browsers, and only the two
    // playback assertions are Chromium-only.
    //
    // `LOOP-003` (#43) fixed the half of this that was a product bug: the
    // unlock is now bounded by a timeout, so a never-settling `resume()`
    // rejects and Firefox emits `audio_start_failed` with the browser-blocked
    // flag rather than nothing at all (`AUD-07`). It does not make Firefox
    // play, so this guard stays: a bounded failure is still a failure. Why
    // Firefox refuses the unlock here is a real-browser-policy question and is
    // `HARD-001`'s cross-browser pass. See docs/testing.md, "Playback is
    // asserted in Chromium only".
    test.info().annotations.push({
      type: canAssertPlayback ? "playback-asserted" : "playback-skipped",
      description: canAssertPlayback
        ? `playback asserted in ${browserName}`
        : `playback not asserted in ${browserName}: AudioContext.resume() is refused here — see HARD-001`,
    });

    if (canAssertPlayback) {
      const transportToggle = page.getByRole("button", {
        name: "Start playback",
      });
      await transportToggle.click();
      try {
        await expect(page.getByRole("button", { name: "Stop playback" })).toBeVisible();
      } catch (error) {
        // The button only flips once `runtime.resume()` resolves, so reaching
        // here means the shared AudioContext did not start. Report what the page
        // said, and the context's own state, instead of just the timeout.
        const audioState = await page
          .evaluate(() => {
            const Ctor =
              window.AudioContext ??
              (
                window as unknown as {
                  webkitAudioContext?: typeof AudioContext;
                }
              ).webkitAudioContext;
            if (!Ctor) return "no AudioContext constructor";
            try {
              const probe = new Ctor();
              const state = probe.state;
              void probe.close();
              return `a fresh AudioContext reports state="${state}"`;
            } catch (contextError) {
              return `constructing an AudioContext threw: ${String(contextError)}`;
            }
          })
          .catch((probeError) => `probe failed: ${String(probeError)}`);

        throw new Error(
          `Playback never started: the transport button stayed on "Start playback", ` +
            `so useProjectAudio.play() did not reach setIsPlaying(true).\n` +
            `AudioContext probe: ${audioState}\n` +
            `Page log:\n${pageLog.length ? pageLog.join("\n") : "(nothing logged)"}\n\n` +
            `Original assertion failure:\n${String(error)}`,
        );
      }
      await page.getByRole("button", { name: "Stop playback" }).click();
    }

    // Undo it: the added note is removed through the same history. The clip is
    // opened again to watch it happen, and the undo comes from the keyboard,
    // which the `sequence_editor` shortcut context keeps live (`UI-001`).
    const afterPlayback = await openStarterClip(page);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(
      afterPlayback.getByRole("button", { name: "BD, step 3, off" }),
    ).toBeVisible();
    await page.keyboard.press("1");
    await expect(page.getByRole("region", { name: "Sequence editor" })).toHaveCount(0);

    // Save it: the autosave status settles once the revision-checked write
    // against the emulator completes.
    await expect(page.locator(".save-status")).toHaveText("Saved", {
      timeout: 10_000,
    });
    // The undo produced its own revision-checked write, strictly after the
    // add's — the visible save state alone ("Saved" both times) cannot show
    // that a real second write happened, only the revision can.
    await expect
      .poll(
        async () =>
          Number(await page.locator(".save-status").getAttribute("data-revision")),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(revisionAfterAdd);

    // Reload it: a genuine browser reload, answered by the emulator rather
    // than by in-memory state the reload just discarded.
    await reloadPage(page);
    await expect(page).toHaveURL(projectUrl);
    const reopened = await openStarterClip(page);
    await expect(reopened.getByRole("button", { name: "BD, step 1, on" })).toBeVisible();
    // The undone note stayed undone — a stale echo of the pre-undo save
    // never got the chance to restore it, and the reload reads the
    // post-undo revision that was actually persisted.
    await expect(reopened.getByRole("button", { name: "BD, step 3, off" })).toBeVisible();
    expect(await savedPackDependencies(page)).toEqual(packDependencies);
    await page.keyboard.press("1");
    await expect(page.getByRole("region", { name: "Sequence editor" })).toHaveCount(0);

    // Reproduce playback after reload, against the stable graph rebuilt
    // from the reloaded project. Chromium only, for the reason above.
    if (canAssertPlayback) {
      await page.getByRole("button", { name: "Start playback" }).click();
      await expect(page.getByRole("button", { name: "Stop playback" })).toBeVisible();
    }
  });
});
