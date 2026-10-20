import { expect, type Page, test } from "./support/test";

// `LOOP-014`: the KEY-01 registry and the KEY-02 mapping guide, in a real
// browser — where keyboard layout, focus, and the browser's own defaults are
// real rather than simulated. Moved here from the retired mock-backend suite's
// `smoke.spec.ts`.

/** Reads the generated name of the project the editor just opened. */
async function openedProjectName(page: Page): Promise<string> {
  // The editor's own heading, not the dashboard's "Projects" it replaces.
  const heading = page.locator("h1.project-name");
  await expect(heading).not.toBeEmpty();
  return (await heading.textContent())?.trim() ?? "";
}

test.describe("keyboard shortcuts", () => {
  test("plays from the keyboard and opens the mapping guide with ?", async ({
    page,
    browserName,
  }) => {
    // Playback is asserted in Chromium only — the same known, tracked gap
    // `tests/e2e/emulator/slice.spec.ts` documents: in Firefox here
    // `AudioContext.resume()` is refused, so the transport button never flips.
    // `LOOP-003` bounded that refusal with a timeout so it now reports
    // `audio_start_failed` instead of hanging, but a bounded failure is still
    // a failure — the cause is `HARD-001`'s real-browser pass. Not a
    // shortcut-dispatch problem; the `?` guide, the text-entry coverage below
    // and the `transport bar` block all run in every gating browser.
    // See docs/testing.md, "Playback is asserted in Chromium only".
    const canAssertPlayback = browserName === "chromium";
    test.info().annotations.push({
      type: canAssertPlayback ? "playback-asserted" : "playback-skipped",
      description: canAssertPlayback
        ? `playback asserted in ${browserName}`
        : `playback not asserted in ${browserName}: AudioContext.resume() is refused here — see HARD-001`,
    });

    await page.goto("/projects");
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page.getByTestId("arrangement-view-ready")).toBeVisible();

    // Space toggles playback from the registry, not from a component's own
    // listener, and the transport button reflects it.
    if (canAssertPlayback) {
      await page.keyboard.press("Space");
      await expect(page.getByRole("button", { name: "Stop playback" })).toBeVisible();
      await page.keyboard.press("Space");
      await expect(page.getByRole("button", { name: "Start playback" })).toBeVisible();
    }

    // `?` opens the guide, generated from the registry.
    await page.keyboard.press("?");
    const guide = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(guide).toBeVisible();
    await expect(
      guide.getByRole("heading", { name: "Keyboard shortcuts" }),
    ).toBeVisible();
    await expect(guide.getByRole("heading", { name: "Transport" })).toBeVisible();

    // Searching filters it, and the search field is where focus landed.
    await page.keyboard.type("quantize");
    await expect(guide.locator("[data-action]")).toHaveCount(1);
    await expect(guide.locator('[data-action="clip.quantize"]')).toBeVisible();

    // Escape closes it from inside its own search box, and playback is
    // untouched.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start playback" })).toBeVisible();
  });

  // The guide's search box is the only text input this slice renders while a
  // controller is attached, so it is where text-entry suppression is provable
  // in a real browser: the characters typed here are all live mappings.
  test("types shortcut characters into a focused text field instead of firing them", async ({
    page,
  }) => {
    await page.goto("/projects");
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page.getByTestId("arrangement-view-ready")).toBeVisible();

    await page.keyboard.press("?");
    const guide = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(guide).toBeVisible();
    const search = guide.getByRole("searchbox", { name: "Search shortcuts" });
    await expect(search).toBeFocused();

    // Space, ?, q, e and o are all registered combinations. Typed into a text
    // input they are text: every character lands, the guide `?` would have
    // re-opened stays open, and playback never starts.
    await page.keyboard.type("space ? q e o");
    await expect(search).toHaveValue("space ? q e o");
    await expect(guide).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start playback" })).toBeVisible();
  });

  // Not a text-entry test: the editor registers its shortcut scope on the
  // app's one controller for its own lifetime, so this is what proves the
  // scope goes on unmount and editor mappings do not follow the user to the
  // dashboard.
  test("editor shortcuts stop working after leaving the editor", async ({ page }) => {
    await page.goto("/projects");
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    await page.getByRole("link", { name: /projects/i }).click();
    await expect(page).toHaveURL(/\/projects$/);

    // `?` opened the guide one route ago. With the editor unmounted there is
    // no controller on the window at all, so it does nothing.
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // And the dashboard's own text entry keeps every character.
    await page.getByRole("button", { name: /rename/i }).click();
    const nameField = page.getByRole("textbox", { name: /rename/i });
    await nameField.fill("");
    await nameField.type("space ? test");
    await expect(nameField).toHaveValue("space ? test");
  });

  // `ConfirmDialog` has no keyboard listener of its own: Escape reaches it as
  // `view.close_surface` from the same registry the editor uses.
  test("closes the delete confirmation with Escape through the registry", async ({
    page,
  }) => {
    await page.goto("/projects");
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    const name = await openedProjectName(page);
    await page.getByRole("link", { name: /projects/i }).click();
    await expect(page.getByText(name)).toBeVisible();

    await page.getByRole("button", { name: `Delete ${name}`, exact: true }).click();
    const dialog = page.getByRole("alertdialog", {
      name: /delete this project/i,
    });
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // Cancelled, not deleted.
    await expect(page.getByText(name)).toBeVisible();
  });
});
