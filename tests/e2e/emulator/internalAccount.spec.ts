import { expect, test } from "@playwright/test";
import {
  accountClaims,
  seedRegisteredSession,
  updateOwnAccount,
} from "./support/authSession";

/**
 * Internal accounts (GRV-113), end to end against the Auth emulator: what
 * makes an account's sessions internal traffic is the `internal` custom claim
 * in its ID token, which only trusted code (`bun run internal:grant`, QA pool
 * provisioning) can set. The address plays no part, and the account cannot
 * give itself the claim.
 *
 * The analytics half (the person and event properties a marked browser sends)
 * is `AuthProvider.test.tsx`'s and `analytics.test.ts`'s; this proves the
 * claim reaches the browser through a real ID token and marks its storage.
 */

/** `INTERNAL_TRAFFIC_STORAGE_KEY` in `src/shared/internalTraffic.ts`. */
const INTERNAL_TRAFFIC_STORAGE_KEY = "sg_internal_traffic";

function internalFlag(page: import("@playwright/test").Page) {
  return page.evaluate(
    (key) => window.localStorage.getItem(key),
    INTERNAL_TRAFFIC_STORAGE_KEY,
  );
}

test.describe("an internal account", () => {
  test("marks the browser internal when it signs in", async ({ page }, testInfo) => {
    await seedRegisteredSession(page, {
      label: `internal-${testInfo.project.name}`,
      internal: true,
    });

    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

    await expect.poll(() => internalFlag(page)).toBe("true");
  });

  test("an account without the claim leaves the browser unmarked", async ({
    page,
  }, testInfo) => {
    await seedRegisteredSession(page, {
      label: `cohort-${testInfo.project.name}`,
    });

    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    // The claim is read from the token the session already holds, so a second
    // is ample for a flagged account's mark to have landed (see above).
    await page.waitForTimeout(1_000);

    expect(await internalFlag(page)).toBeNull();
  });

  test("cannot be made by the account itself", async ({ page }, testInfo) => {
    const session = await seedRegisteredSession(page, {
      label: `selfgrant-${testInfo.project.name}`,
    });

    // The token is good for what an account may change about itself, so the
    // refusal below is about the claim and nothing else.
    const rename = await updateOwnAccount(session.idToken, { displayName: "Renamed" });
    expect(rename.ok).toBe(true);

    const response = await updateOwnAccount(session.idToken, {
      customAttributes: JSON.stringify({ internal: true }),
    });

    expect(response.ok).toBe(false);
    expect(await response.text()).toContain("INSUFFICIENT_PERMISSION");
    expect(await accountClaims(session.uid)).not.toHaveProperty("internal");
  });
});
