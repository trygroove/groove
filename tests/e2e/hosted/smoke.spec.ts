import { expect, type Page, test } from "@playwright/test";
import { SMOKE_QA_SLOT } from "../../../scripts/access/qaPool";
import { requestAccessUrl } from "../../../site.config.mjs";
import { passWelcome, qaSignInUnavailable, signInAsQaAccount } from "./qaSession";

// PRD `OPS-01` post-deploy smoke test. Runs against `SMOKE_URL` (the real
// deployed Firebase Hosting URL) with real Firebase Authentication and
// Firestore -- see tests/e2e/hosted/playwright.config.ts. A failing run here is treated
// as a failed deploy: the `deploy` job in .github/workflows/ci.yml runs this
// immediately after `firebase deploy` and does not consider the deploy
// successful until it passes.
//
// This intentionally does not reuse tests/e2e/mock/smoke.spec.ts: that suite drives the
// in-memory mock backend (`VITE_DEV_BACKEND=mock`) against a local dev
// server, which proves the UI works but nothing about whether the deployed
// build can actually reach production Firebase Authentication, Firestore, and
// security rules.
//
// #854 made the alpha invite-only and retired guest start, so the signed-in
// part runs as the allowlisted QA account `testuser0` (#1055), signed in
// through a custom token (`./qaSession.ts`, docs/runbooks/alpha-allowlist.md).
// The signed-out tests prove the deployed build loads, offers its two entry
// points, and keeps a visitor with no session out of the app.
//
// Every first page load carries `?internal=1`, so smoke traffic is excluded
// from the product's measures (`src/shared/internalTraffic.ts`).
test.describe("hosted alpha smoke test", () => {
  test("loads the landing page with Request an invite and Sign in", async ({ page }) => {
    await page.goto("/?internal=1");
    await expect(
      page.getByRole("heading", { level: 1, name: /Finish the tracks you start/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Request an invite" }).first(),
    ).toHaveAttribute("href", requestAccessUrl);
    await expect(page.getByRole("button", { name: "Sign in" }).first()).toBeEnabled();
  });

  test("keeps a visitor with no session out of the app", async ({ page }) => {
    // A deep link is served the app shell, boots the Firebase SDK, finds no
    // session, and sends the visitor to the landing page rather than making
    // them a guest.
    await page.goto("/projects?internal=1");
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");
    await expect(
      page.getByRole("heading", { level: 1, name: /Finish the tracks you start/ }),
    ).toBeVisible();
  });

  test("serves the not-on-the-alpha-list page", async ({ page }) => {
    await page.goto("/not-invited?internal=1");
    await expect(
      page.getByRole("heading", { name: "You're not on the alpha list yet" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Request access" })).toHaveAttribute(
      "href",
      requestAccessUrl,
    );
  });
});

test.describe("hosted alpha smoke test, signed in", () => {
  /** The project this test made, and so the only one it may delete. */
  let createdId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdId) await deleteProject(page, createdId);
    createdId = null;
  });

  test("creates a project, opens it, and starts audio after a gesture", async ({
    page,
  }) => {
    const unavailable = qaSignInUnavailable();
    test.skip(
      unavailable !== null,
      `${unavailable} A fork's pull request gets no secrets, so the signed-in ` +
        "smoke test is skipped; the signed-out tests still ran.",
    );

    await signInAsQaAccount(page, SMOKE_QA_SLOT);
    await page.goto("/projects?internal=1");
    await passWelcome(page);
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

    // The account has no seeded project, so the smoke test creates one. That
    // also proves the Firestore write path and security rules end to end.
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/[^/?#]+$/);
    createdId = new URL(page.url()).pathname.split("/").pop() ?? null;

    // Audio start after a user gesture (autoplay policies require one).
    const playButton = page.getByRole("button", { name: "Start playback" });
    await expect(playButton).toBeVisible();
    await playButton.click();
    await expect(page.getByRole("button", { name: "Stop playback" })).toBeVisible();
  });
});

/**
 * Deletes one project by its ID, through the project list a person would use.
 * Only that one: the deploy's smoke test and any number of previews can be
 * signed in as `testuser0` at once, each with a project of its own open.
 */
async function deleteProject(page: Page, projectId: string): Promise<void> {
  await page.goto("/projects");
  const row = page
    .locator("tr")
    .filter({ has: page.locator(`a[href="/projects/${projectId}"]`) });
  await row.getByRole("button", { name: /^Delete / }).click();
  await page
    .getByRole("alertdialog", { name: /delete this project/i })
    .getByRole("button", { name: /^delete$/i })
    .click();
  await expect(row).toHaveCount(0);
  // From the server, not just the page.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.locator(`a[href="/projects/${projectId}"]`)).toHaveCount(0);
}
