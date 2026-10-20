import { expect, test } from "@playwright/test";
import { seedRegisteredSession } from "./support/authSession";
import { reloadPage } from "./support/reload";

/**
 * Proves {@link seedRegisteredSession} — the harness plumbing that gets a flow
 * whose precondition is "signed in to an account" to its starting line without
 * driving the login control (see that module for why).
 *
 * It needs proving *here* rather than only in the flows that use it: every
 * flow that starts signed in rests on it (#854 retired guest start), so a
 * failure here explains a wall of red flows in one line. These are the tests
 * that fail if the SDK changes how it persists a user. Against the emulator rather than the mock
 * backend for the obvious reason — a session that restores from storage is
 * exactly what the mock backend has none of.
 */

/** What a guest is told, and a signed-in account is not (`UpgradeAccountPrompt`). */
const GUEST_NOTICE = /You're working as a guest/;

// Part of the per-PR `@sanity` subset (.github/workflows/ci.yml).
test.describe("a seeded registered session", { tag: "@sanity" }, () => {
  test("arrives on the dashboard signed in to an account, not as a guest", async ({
    page,
  }, testInfo) => {
    await seedRegisteredSession(page, {
      label: `seeded-${testInfo.project.name}`,
    });

    await page.goto("/projects");

    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect(page.getByText(GUEST_NOTICE)).toHaveCount(0);
  });

  test("survives a reload, because it is genuinely persisted", async ({
    page,
  }, testInfo) => {
    await seedRegisteredSession(page, {
      label: `reloaded-${testInfo.project.name}`,
    });

    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

    // The step every flow ends on. If the session only lived in the page's
    // memory, this is where it would be sent back to the landing page.
    await reloadPage(page);

    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect(page.getByText(GUEST_NOTICE)).toHaveCount(0);
  });

  // Without this, the assertions above would pass just as happily against an
  // app that let anyone in: a visitor with no session is not signed in as
  // anyone (#854), and the dashboard sends them to the landing page.
  test("is a different state from no session at all, which is sent to the landing page", async ({
    page,
  }) => {
    await page.goto("/projects");

    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByRole("heading", { level: 1, name: /Finish the tracks you start/ }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "New Project" })).toHaveCount(0);
  });
});
