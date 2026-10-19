import type { Page } from "@playwright/test";

/**
 * Reload the page, and survive WebKit aborting the navigation.
 *
 * Playwright's WebKit sometimes rejects `page.reload()` with "WebKit encountered
 * an internal error" (GRV-124): the browser dropped the navigation, so the page
 * was never reloaded and nothing about the app is under test yet. Only that
 * failure is retried, once, and it is retried as a navigation to the same URL;
 * any other error, and a second failure, still fails the test. Callers go on to
 * assert the state they expect after the reload, so a reload that did not
 * restore it still fails there.
 */
export async function reloadPage(page: Page): Promise<void> {
  try {
    await page.reload();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !/WebKit encountered an internal error/.test(error.message)
    ) {
      throw error;
    }
    await page.goto(page.url());
  }
}
