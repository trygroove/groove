import { SENTRY_DSN, sentryEndpoints } from "../../../../scripts/security-headers.mjs";
import { CANARY_HOST } from "../../support/hostingServer.mjs";
import { expect, test } from "../support/test";

// The security headers on the built app (GRV-7), run by
// `playwright.hosting.config.ts` only: the dev server the everyday suite uses
// serves none of them. The `@sanity` specs run under the same policy in the
// same run, and its teardown fails on any violation they cause.

/** Collects the page's CSP violations as the browser raises them. */
async function watchViolations(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = seen;
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
  return () =>
    page.evaluate(
      () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
    );
}

test.describe("the hosted build's security headers", { tag: "@hosting" }, () => {
  test("serves an enforced policy and the other headers on every path", async ({
    request,
  }) => {
    for (const path of ["/", "/projects", "/projects/prj_missing"]) {
      const response = await request.get(path, { headers: { accept: "text/html" } });
      const headers = response.headers();
      const csp = headers["content-security-policy"];
      expect(csp, path).toContain("default-src 'self'");
      expect(csp, path).toContain("style-src 'self';");
      expect(csp, path).toContain("frame-ancestors 'none'");
      expect(csp, path).not.toMatch(/unsafe-inline|unsafe-eval/);
      expect(headers["content-security-policy-report-only"], path).toBeUndefined();
      expect(headers["x-content-type-options"], path).toBe("nosniff");
      expect(headers["referrer-policy"], path).toBe("strict-origin-when-cross-origin");
      expect(headers["x-frame-options"], path).toBe("DENY");
      expect(headers["strict-transport-security"], path).toMatch(/^max-age=/);
      expect(headers["permissions-policy"], path).toContain("microphone=(self)");
    }
  });

  test("runs the landing page's one inline script under the policy", async ({ page }) => {
    const violations = await watchViolations(page);
    // A deep link is served the app shell; `/` keeps the prerendered page,
    // whose inline script only the hash allows.
    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: /Finish the tracks you start/ }),
    ).toBeVisible();
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    await expect(page.getByRole("button", { name: "Start playback" })).toBeVisible();
    expect(await violations()).toEqual([]);
  });

  test("reports a violation to Sentry's CSP endpoint", async ({ page, context }) => {
    const { report } = sentryEndpoints(SENTRY_DSN);
    const endpoint = new URL(report);
    const received: string[] = [];
    // Answered here, so a planted violation never reaches the real project.
    await context.route(`${endpoint.origin}${endpoint.pathname}**`, async (route) => {
      received.push(route.request().postData() ?? "");
      await route.fulfill({ status: 204 });
    });

    await page.goto("/");
    await page.evaluate((host) => {
      const image = new Image();
      image.src = `https://${host}/planted.png`;
      document.body.append(image);
    }, CANARY_HOST);

    await expect.poll(() => received.length, { timeout: 15_000 }).toBeGreaterThan(0);
    const body = JSON.parse(received[0]) as { "csp-report": Record<string, string> };
    expect(body["csp-report"]["blocked-uri"]).toContain(CANARY_HOST);
    expect(body["csp-report"]["effective-directive"]).toBe("img-src");
    expect(body["csp-report"].disposition).toBe("enforce");
  });
});
