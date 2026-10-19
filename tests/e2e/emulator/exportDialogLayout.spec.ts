import { expect, type Page, test } from "@playwright/test";

/**
 * EXP-004's "no layout shift" acceptance criterion: the Export dialog's lanes,
 * Downloads row, footer readouts, actions box and one-line message slot keep
 * their bounding rects across choosing a format, picking tracks, an over-budget
 * note, rendering, a failure and a cancel. The real dialog is mounted over the
 * real app styles with an export the test drives by hand, so a fifty-track,
 * ten-minute project "renders" without rendering a second of audio.
 */

const HARNESS = "/tests/e2e/emulator/support/exportDialogHarness.tsx";

type Rect = readonly [number, number, number, number];

/** What must not move, by selector. `nth` picks among several matches. */
const FIXED: Record<string, { selector: string; nth?: number }> = {
  dialog: { selector: ".export-shell" },
  head: { selector: ".export-head" },
  formats: { selector: ".export-cards" },
  ruler: { selector: ".track-ruler" },
  lanes: { selector: ".track-lanes-scroll" },
  downloads: { selector: ".downloads" },
  footer: { selector: ".export-footer" },
  readoutOne: { selector: ".export-slot", nth: 0 },
  readoutTwo: { selector: ".export-slot", nth: 1 },
  actions: { selector: ".export-actions" },
  message: { selector: ".export-message" },
};

async function harness(page: Page, fn: string, ...args: unknown[]): Promise<void> {
  await page.evaluate(
    async ({ path, fn, args }) => {
      const module = await import(/* @vite-ignore */ path);
      return module[fn](...args);
    },
    { path: HARNESS, fn, args },
  );
}

async function rects(page: Page): Promise<Record<string, Rect>> {
  // Two frames, so a change that lands on the next paint is counted.
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
  return page.evaluate((fixed) => {
    const out: Record<string, [number, number, number, number]> = {};
    for (const [name, { selector, nth }] of Object.entries(fixed)) {
      const box = document.querySelectorAll(selector)[nth ?? 0]?.getBoundingClientRect();
      if (!box) throw new Error(`${name} (${selector}) is not on the page`);
      out[name] = [box.left, box.top, box.width, box.height];
    }
    return out;
  }, FIXED);
}

test.describe("Export dialog layout", () => {
  test("keeps its lanes, Downloads row, footer and message slot still in every state", async ({
    page,
  }) => {
    await page.goto("/");
    await harness(page, "mountExportDialog", "over");
    const dialog = page.getByRole("dialog", { name: "Export" });
    await expect(dialog).toBeVisible();
    const note = dialog.locator(".export-note");
    const alert = dialog.getByRole("alert");
    const options = dialog.getByRole("option");

    const baseline = await rects(page);
    /** The state just reached, proved to be the one intended, and nothing moved. */
    const stillAt = async (state: string, proof: () => Promise<void>) => {
      await proof();
      expect(await rects(page), state).toEqual(baseline);
    };

    await stillAt("stereo", () => expect(note).toHaveText(""));

    await dialog.getByRole("radio", { name: "Stems (ZIP)" }).check();
    await stillAt("stems over budget, with its note", () =>
      expect(note).toHaveText(/is over the 2 GiB browser limit, so stems come as 4 ZIPs/),
    );

    await options.nth(2).click({ modifiers: ["ControlOrMeta"] });
    await options.nth(5).click({ modifiers: ["ControlOrMeta", "Shift"] });
    await stillAt("tracks picked", () =>
      expect(dialog.getByText("4 picked")).toBeVisible(),
    );
    await dialog.getByRole("button", { name: "Clear picked tracks" }).click();

    await options.nth(0).click();
    await stillAt("a track turned off", () =>
      expect(options.nth(0)).toHaveAccessibleName(/left out$/),
    );
    await options.nth(0).click();

    await dialog.getByRole("button", { name: "Export", exact: true }).click();
    await harness(page, "progress", 0.5);
    await stillAt("rendering ZIP 1", () =>
      expect(dialog.getByText("ZIP 1 of 4 · bar")).toBeVisible(),
    );

    await harness(page, "finish");
    await harness(page, "progress", 0.4);
    await stillAt("rendering ZIP 2, with ZIP 1 downloaded", () =>
      expect(dialog.getByText("ZIP 2 of 4 · bar")).toBeVisible(),
    );

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await stillAt("cancelled, with a resume point", () =>
      expect(note).toHaveText(/^Stopped\. ZIP 1 of 4 is in your downloads/),
    );

    await dialog.getByRole("button", { name: "Resume from ZIP 2" }).click();
    await harness(page, "progress", 0.3);
    await harness(page, "fail");
    await stillAt("a ZIP failed", () =>
      expect(alert).toContainText("ZIP 2 failed: a sound could not be loaded"),
    );

    await dialog.getByRole("radio", { name: "Stereo WAV" }).check();
    await stillAt("back to stereo", () => expect(alert).toHaveText(""));
    await dialog.getByRole("button", { name: "Export", exact: true }).click();
    await harness(page, "progress", 0.5);
    await stillAt("rendering the stereo mix", () =>
      expect(dialog.getByText(/^bar \d+ of \d+$/)).toBeVisible(),
    );
  });

  test("gives the song's name every pixel the readouts leave, and ellipsizes only then", async ({
    page,
  }) => {
    await page.goto("/");
    const measure = () =>
      page.evaluate(() => {
        const title = document.querySelector(".export-title h2") as HTMLElement;
        const readout = document.querySelector(".export-head .export-readout");
        return {
          // To a tenth of a pixel: Firefox lays text out on a finer grid
          // than Chromium, so the same 32px gap measures 31.99998px there.
          gap:
            Math.round(
              ((readout?.getBoundingClientRect().left ?? 0) -
                title.getBoundingClientRect().right) *
                10,
            ) / 10,
          clipped: title.scrollWidth > title.clientWidth,
        };
      });
    await harness(page, "mountExportDialog", "fits", "Night Bus");
    await expect(page.getByRole("dialog", { name: "Export" })).toBeVisible();
    // A short name keeps the readouts right beside it, at the row's 32px gap.
    expect(await measure()).toEqual({ gap: 32, clipped: false });

    await harness(page, "mountExportDialog", "fits", "Reference arrangement");
    expect(await measure()).toEqual({ gap: 32, clipped: false });

    // A name too long for the row fills it, up to the readouts, and clips there.
    await harness(
      page,
      "mountExportDialog",
      "fits",
      "A reference arrangement long enough to need the whole row",
    );
    expect(await measure()).toEqual({ gap: 32, clipped: true });
  });

  test("labels the ruler at least 56px apart on a long song, at any width", async ({
    page,
  }) => {
    await page.goto("/");
    await harness(page, "mountExportDialog", "over");
    const dialog = page.getByRole("dialog", { name: "Export" });
    await expect(dialog).toBeVisible();
    const closest = () =>
      page.evaluate(() => {
        const lefts = [...document.querySelectorAll(".track-ruler-marks span")].map(
          (label) => label.getBoundingClientRect().left,
        );
        return Math.min(...lefts.slice(1).map((left, i) => left - lefts[i]));
      });
    for (const width of [1280, 900]) {
      await page.setViewportSize({ width, height: 800 });
      await expect.poll(closest).toBeGreaterThanOrEqual(56);
    }
  });

  test("sizes the lanes to a short song's tracks, with the Downloads row right under them", async ({
    page,
  }) => {
    await page.goto("/");
    const measure = () =>
      page.evaluate(() => {
        const box = (selector: string) =>
          document.querySelector(selector)?.getBoundingClientRect();
        return {
          rows: document.querySelectorAll('.export-shell [role="option"]').length,
          lanes: box(".track-lanes-scroll")?.height,
          gap: (box(".downloads")?.top ?? 0) - (box(".track-lanes")?.bottom ?? 0),
        };
      });
    // A 7-track song has no empty space under its last lane (#841).
    await harness(page, "mountExportDialog", "few");
    await expect(page.getByRole("dialog", { name: "Export" })).toBeVisible();
    const few = await measure();
    expect(few.rows).toBeLessThan(10);
    expect(few).toEqual({ rows: few.rows, lanes: few.rows * 24, gap: 0 });

    // A long list stops at the cap and scrolls inside it.
    await harness(page, "mountExportDialog", "over");
    expect((await measure()).lanes).toBe(250);
  });

  test("keeps the same frame for stems that fit one ZIP", async ({ page }) => {
    await page.goto("/");
    await harness(page, "mountExportDialog", "fits");
    const dialog = page.getByRole("dialog", { name: "Export" });
    await expect(dialog).toBeVisible();
    const stereo = await rects(page);
    await dialog.getByRole("radio", { name: "Stems (ZIP)" }).check();
    await expect(dialog.locator(".export-note")).toHaveText(
      "Stems over 2 GiB come as several ZIPs in track order. These fit in one.",
    );
    expect(await rects(page)).toEqual(stereo);
  });

  test("keeps Close and Export reachable in a short or a narrow window (GRV-153)", async ({
    page,
  }) => {
    await page.goto("/");
    await harness(page, "mountExportDialog", "over");
    const dialog = page.getByRole("dialog", { name: "Export" });
    await expect(dialog).toBeVisible();
    for (const size of [
      { width: 1280, height: 420 },
      { width: 375, height: 700 },
      { width: 375, height: 420 },
    ]) {
      await page.setViewportSize(size);
      for (const name of ["Close", "Export"]) {
        const button = dialog.getByRole("button", { name, exact: true });
        // The dialog may scroll, but only the way a producer can scroll it: the wheel.
        const shell = (await dialog.boundingBox()) ?? { x: 0, y: 0, width: 1, height: 1 };
        await page.mouse.move(shell.x + shell.width / 2, shell.y + 8);
        await page.mouse.wheel(4000, 4000);
        await page.evaluate(
          () =>
            new Promise((done) =>
              requestAnimationFrame(() => requestAnimationFrame(done)),
            ),
        );
        const hit = await button.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const top = document.elementFromPoint(
            box.left + box.width / 2,
            box.top + box.height / 2,
          );
          return {
            inside:
              box.left >= 0 &&
              box.top >= 0 &&
              box.right <= window.innerWidth &&
              box.bottom <= window.innerHeight,
            hit: top === el || el.contains(top),
          };
        });
        expect(hit, `${name} at ${size.width}x${size.height}`).toEqual({
          inside: true,
          hit: true,
        });
      }
    }
  });
});

test.describe("Export complete screen", () => {
  // GRV-158: a one-word project name must not push the heading off the top of the
  // dialog, run the file name past its right edge, or spill the sleeve's caption
  // into the right-hand panel. Stems at 1280x720, as the report found it.
  test("keeps the heading, file name and sleeve inside the dialog for a long one-word name", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await harness(
      page,
      "mountExportDialog",
      "few",
      "summer_anthem_final_mix_v12_with_new_vocals_and_extra_bass_MASTER",
    );
    const dialog = page.getByRole("dialog", { name: "Export" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("radio", { name: "Stems (ZIP)" }).check();
    await dialog.getByRole("button", { name: "Export", exact: true }).click();
    await harness(page, "finish");
    await expect(page.locator(".export-done")).toBeVisible();
    // Let the staggered rise finish, so the boxes are where they settle.
    await page.evaluate(() =>
      Promise.all(document.getAnimations().map((animation) => animation.finished)),
    );
    const boxes = await page.evaluate(() => {
      const box = (selector: string) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`${selector} is not on the page`);
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      };
      // The text's own extent: a word wider than its box paints past the box's edge.
      const textRight = (selector: string) => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector(selector) as Element);
        return range.getBoundingClientRect().right;
      };
      return {
        dialog: box(".export-shell"),
        out: box(".export-out"),
        heading: box(".export-out h3"),
        caption: { ...box(".export-out p"), right: textRight(".export-out p") },
        sleeve: box(".export-sleeve"),
      };
    });
    const { dialog: frame, out, heading, caption, sleeve } = boxes;
    // The heading is whole and in view: inside its column and under the dialog's top.
    expect.soft(heading.top, "heading top").toBeGreaterThanOrEqual(out.top);
    expect.soft(heading.bottom, "heading bottom").toBeLessThanOrEqual(out.bottom);
    expect.soft(heading.top, "heading in dialog").toBeGreaterThanOrEqual(frame.top);
    expect.soft(heading.right, "heading right").toBeLessThanOrEqual(out.right);
    // The file name stays within the dialog's right edge.
    expect.soft(caption.right, "file name right").toBeLessThanOrEqual(frame.right);
    // The sleeve stays in the left panel, clear of the right one.
    expect.soft(sleeve.right, "sleeve right").toBeLessThanOrEqual(out.left);
  });
});
