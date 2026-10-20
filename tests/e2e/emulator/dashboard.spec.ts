import { seedRegisteredSession } from "./support/authSession";
import { reloadPage } from "./support/reload";
import { expect, type Page, test } from "./support/test";

/** Reads the generated name of the project the editor just opened. */
async function openedProjectName(page: Page): Promise<string> {
  // The editor's own heading, not the dashboard's "Projects" it replaces.
  const heading = page.locator("h1.project-name");
  await expect(heading).not.toBeEmpty();
  return (await heading.textContent())?.trim() ?? "";
}

/**
 * `LOOP-001` — the dashboard's access control and destructive
 * confirmation, exercised against a real (emulated) backend so Firestore
 * security rules are actually enforced (the in-memory mock dev backend has no
 * server-side security boundary to prove).
 */
test.describe("dashboard access control", () => {
  test("a project created by one account is invisible and inaccessible to another", async ({
    browser,
  }, testInfo) => {
    const ownerContext = await browser.newContext();
    const strangerContext = await browser.newContext();
    try {
      const ownerPage = await ownerContext.newPage();
      await seedRegisteredSession(ownerPage, { label: `owner-${testInfo.project.name}` });
      await ownerPage.goto("/projects");
      await expect(ownerPage.getByRole("heading", { name: "Projects" })).toBeVisible();
      await ownerPage.getByRole("button", { name: "New Project" }).click();
      await expect(ownerPage).toHaveURL(/\/projects\/prj_/);
      const projectUrl = ownerPage.url();

      // A second, independent account: its own browser context gets its own
      // Auth persistence, so this is a genuinely different uid.
      const strangerPage = await strangerContext.newPage();
      await seedRegisteredSession(strangerPage, {
        label: `stranger-${testInfo.project.name}`,
      });
      await strangerPage.goto("/projects");
      await expect(strangerPage.getByRole("heading", { name: "Projects" })).toBeVisible();
      // The owner's project does not leak into the stranger's listing —
      // `listProjects` is scoped to the caller's own uid.
      await expect(strangerPage.getByText("No projects yet")).toBeVisible();

      // Navigating straight to the owner's project URL: Firestore's security
      // rules deny the read (`isMember` requires owner or collaborator), and
      // the repository maps that `permission-denied` onto the same
      // `not_found` result an unknown project ID would produce — so this
      // reads as "not found" rather than a crash or a leaked existence check.
      await strangerPage.goto(projectUrl);
      await expect(
        strangerPage.getByRole("heading", { name: "This groove is broken" }),
      ).toBeVisible();
    } finally {
      await ownerContext.close();
      await strangerContext.close();
    }
  });
});

test.describe("destructive confirmation", () => {
  test("deleting a project requires confirmation, and the deletion persists across reload", async ({
    page,
  }) => {
    await page.goto("/projects");
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    const name = await openedProjectName(page);

    await page.goto("/projects");
    await expect(page.getByText(name)).toBeVisible();

    // Cancelling the confirmation leaves the project in place.
    await page.getByRole("button", { name: `Delete ${name}`, exact: true }).click();
    const dialog = page.getByRole("alertdialog", {
      name: /delete this project/i,
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /^cancel$/i }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText(name)).toBeVisible();

    // Confirming actually deletes it.
    await page.getByRole("button", { name: `Delete ${name}`, exact: true }).click();
    await page
      .getByRole("alertdialog", { name: /delete this project/i })
      .getByRole("button", { name: /^delete$/i })
      .click();
    await expect(page.getByText("No projects yet")).toBeVisible();

    // The deletion is a real write against the emulator, not just local
    // state — a reload still shows it gone.
    await reloadPage(page);
    await expect(page.getByText("No projects yet")).toBeVisible();
  });
});

// `LOOP-001`: the dashboard's project-management surface — rename, duplicate,
// and a confirmed delete that acts only on the row it was invoked on. Moved
// here from the retired mock-backend suite's `smoke.spec.ts`; the persisted
// delete above is the same surface's reload half.
test.describe("dashboard project management", () => {
  test("renames, duplicates, and deletes a project from the dashboard", async ({
    page,
  }) => {
    await page.goto("/projects");
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    const name = await openedProjectName(page);

    // Return to the dashboard via the editor's client-side "Projects" link, the
    // way a producer leaves the editor.
    await page.getByRole("link", { name: /projects/i }).click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByText(name)).toBeVisible();

    // Rename.
    await page.getByRole("button", { name: /rename/i }).click();
    await page.getByRole("textbox", { name: `Rename ${name}` }).fill("My First Groove");
    await page.getByRole("button", { name: /^save$/i }).click();
    await expect(page.getByText("My First Groove")).toBeVisible();
    await expect(page.getByText(name, { exact: true })).not.toBeVisible();

    // Duplicate: an independent second project appears alongside it.
    await page.getByRole("button", { name: /duplicate/i }).click();
    await expect(page.getByText("My First Groove copy")).toBeVisible();
    await expect(page.getByText("My First Groove", { exact: true })).toBeVisible();

    // Delete requires confirmation. Only the duplicate's card is targeted
    // (its text is a superset of the original's, so filtering on the full
    // "... copy" text is what tells the two cards apart).
    const duplicateCard = page
      .getByRole("row")
      .filter({ hasText: "My First Groove copy" });
    await duplicateCard.getByRole("button", { name: /^delete /i }).click();
    const dialog = page.getByRole("alertdialog", {
      name: /delete this project/i,
    });
    await expect(dialog).toBeVisible();

    // Cancelling keeps it.
    await dialog.getByRole("button", { name: /^cancel$/i }).click();
    await expect(page.getByText("My First Groove copy")).toBeVisible();

    // Confirming removes only that one.
    await duplicateCard.getByRole("button", { name: /^delete /i }).click();
    await page
      .getByRole("alertdialog", { name: /delete this project/i })
      .getByRole("button", { name: /^delete$/i })
      .click();
    // Against a real backend the confirmation stays up, naming the project,
    // until the delete is written; wait for it to close so the check below
    // reads the list, not the dialog's message.
    await expect(dialog).toBeHidden();
    await expect(page.getByText("My First Groove copy")).not.toBeVisible();
    await expect(page.getByText("My First Groove", { exact: true })).toBeVisible();
  });
});
