import { newProject } from "./support/assistant";
import { expect, test } from "./support/test";
import { pressView } from "./support/views";

// GRV-57: the editor fits the page area beside a classic vertical scrollbar,
// not the whole window. It was `width: 100vw`, which ignores the scrollbar and
// left Sign out under it plus a horizontal scrollbar. Playwright hides
// scrollbars in headless Chromium, so bring the classic one back. Its width is
// whatever the browser draws (15px in some, 8px in newer ones), so the test
// measures it rather than assuming one.
//
// Chromium-family only: `--hide-scrollbars` is a Chromium flag, and headless
// Firefox and WebKit draw overlay scrollbars that take no room (clientWidth is
// the full 1280), so there is no classic scrollbar to fit beside and no
// launch option that makes one. The CSS under test is engine-neutral.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test.describe("editor width beside a classic scrollbar", () => {
  for (const view of ["Mixer", "Instrument"] as const) {
    test(`${view} fits the page area`, async ({ page, browserName }) => {
      test.skip(
        browserName !== "chromium",
        "needs a classic scrollbar, which only Chromium's --hide-scrollbars switch can restore",
      );
      await page.setViewportSize({ width: 1280, height: 720 });
      await newProject(page);
      await pressView(page, view);

      const m = await page.evaluate(() => {
        const de = document.documentElement;
        const right = (selector: string) =>
          document.querySelector(selector)?.getBoundingClientRect().right ?? Number.NaN;
        const account = [
          ...document.querySelectorAll<HTMLElement>(".editor-header button"),
        ]
          .filter((b) => /^(Sign out|Log in)$/.test(b.textContent?.trim() ?? ""))
          .map((b) => b.getBoundingClientRect().right);
        return {
          // The classic scrollbar's width, whatever the browser draws it at.
          scrollbar: window.innerWidth - de.clientWidth,
          clientWidth: de.clientWidth,
          scrollWidth: de.scrollWidth,
          verticalScroll: de.scrollHeight > de.clientHeight,
          header: right(".editor-header"),
          editor: right(".editor"),
          account: account[0] ?? Number.NaN,
        };
      });

      // The setup is a real classic scrollbar: the window less its width, which
      // is measured rather than assumed.
      expect(m.verticalScroll).toBe(true);
      expect(m.scrollbar).toBeGreaterThan(0);
      expect(m.header).toBeLessThanOrEqual(m.clientWidth);
      expect(m.editor).toBeLessThanOrEqual(m.clientWidth);
      expect(m.account).toBeLessThanOrEqual(m.clientWidth);
      expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);
    });
  }
});
