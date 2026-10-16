import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test } from "@playwright/test";
import { persistedUid } from "../../support/firebaseSession";
import { signInAsQaAccount } from "../qaSession";
import { ACCOUNT_FILE, BUILD_FILE, SESSION_FILE, sweepSlot } from "./paths";

// One signed-in session per agent per run, made here and nowhere else (#859,
// #1055). Agent slot n signs in as the allowlisted QA account `testuser<n>`,
// which no other agent shares, and its cleanup (`cleanup.sweep.ts`) deletes
// every project that account owns, so a slot starts each run empty. The
// account owns nothing but the sweep's own projects, so it cannot read or
// change anyone else's (firestore.rules).
test("sign this agent in as its QA account", async ({ page }) => {
  test.skip(existsSync(SESSION_FILE), "This run's session already exists.");

  const account = await signInAsQaAccount(page, sweepSlot());

  // `?internal=1` marks the browser as team traffic, so the sweep's sessions
  // are excluded from the product's measures (`src/shared/internalTraffic.ts`).
  // The flag is kept in localStorage, which the saved session carries to every
  // spec the agent runs.
  await page.goto("/projects?internal=1");
  // An account that has not been through onboarding (GRV-25) is taken to the
  // welcome instead. The session is saved as it is, so the agent meets the
  // product as a producer would; it is not skipped on the agent's behalf.
  await expect(page).toHaveURL(/\/(projects|welcome)(\?|$)/);
  await expect(
    page
      .getByRole("heading", { name: "Projects" })
      .or(page.getByRole("button", { name: "Skip to the studio" }))
      .first(),
  ).toBeVisible();

  const sha = await page.locator("[data-release-sha]").getAttribute("data-release-sha");
  mkdirSync(dirname(BUILD_FILE), { recursive: true });
  writeFileSync(BUILD_FILE, `${JSON.stringify({ sha })}\n`);

  // The app has restored the installed user, not signed in some other way.
  await expect.poll(() => persistedUid(page)).toBe(account.uid);
  mkdirSync(dirname(SESSION_FILE), { recursive: true });
  writeFileSync(ACCOUNT_FILE, `${account.uid}\n`);
  await page.context().storageState({ path: SESSION_FILE, indexedDB: true });
});
