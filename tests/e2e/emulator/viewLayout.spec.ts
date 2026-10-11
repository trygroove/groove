import { seedDisclosureAnswered } from "./support/assistant";
import { expect, type Locator, type Page, test } from "./support/test";
import {
  dock,
  emptyScreen,
  pressView,
  sequenceView,
  type ViewName,
} from "./support/views";

// GRV-53: the five views share one frame, the arrangement's. The header is
// the same height in every view, every view starts where the arrangement does
// and runs edge to edge and down under the dock, and the docked assistant
// carries one border only, the composer's. jsdom has no layout, so only a
// browser can say any of it.

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function boxOf(locator: Locator, what: string): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${what} has no box on screen`);
  return box;
}

interface Frame {
  header: Box;
  view: Box;
  dock: Box;
}

/** The view on screen: the one element the editor's body holds. */
const viewRoot = (page: Page): Locator => page.locator(".editor-body > *").first();

/**
 * The header row's box (inside any padding a view gives it to cover its
 * gutters) and the view's, at the top of the document.
 */
async function frame(page: Page, what: string): Promise<Frame> {
  await page.evaluate(() => window.scrollTo(0, 0));
  const header = await page.locator(".editor-header").evaluate((element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const top = Number.parseFloat(style.paddingTop);
    const right = Number.parseFloat(style.paddingRight);
    const bottom = Number.parseFloat(style.paddingBottom);
    const left = Number.parseFloat(style.paddingLeft);
    return {
      x: box.x + left,
      y: box.y + top,
      width: box.width - left - right,
      height: box.height - top - bottom,
    };
  });
  return {
    header,
    view: await boxOf(viewRoot(page), `${what}'s view`),
    dock: await boxOf(dock(page), "the view dock"),
  };
}

/** A view's frame is the arrangement's: same header, same edges, and its
 * background runs on behind the dock. */
function expectSameFrame(what: string, actual: Frame, reference: Frame): void {
  expect.soft(actual.header, `${what}: the header`).toEqual(reference.header);
  expect
    .soft(
      { x: actual.view.x, y: actual.view.y, width: actual.view.width },
      `${what}: the view's top-left corner and width`,
    )
    .toEqual({ x: reference.view.x, y: reference.view.y, width: reference.view.width });
  expect
    .soft(
      actual.view.y + actual.view.height,
      `${what}: the view's background runs on behind the dock`,
    )
    .toBeGreaterThanOrEqual(actual.dock.y + actual.dock.height);
}

async function openStarterClip(page: Page): Promise<void> {
  const ready = page.getByTestId("arrangement-view-ready");
  await expect(ready).toBeVisible();
  const pixelsPerTick = Number(await ready.getAttribute("data-pixels-per-tick"));
  const rulerHeight = Number(await ready.getAttribute("data-ruler-height"));
  const rowHeight = Number(await ready.getAttribute("data-row-height"));
  await page.locator(".arrangement-layer-interactive").dblclick({
    position: { x: 384 * pixelsPerTick, y: rulerHeight + rowHeight / 2 },
  });
  await expect(sequenceView(page)).toBeVisible();
}

test.describe("view layout", () => {
  test("every view sits in the arrangement's frame", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/projects");
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    await page.getByTestId("arrangement-view-ready").waitFor();
    const reference = await frame(page, "Arrangement");
    expect(reference.header.height).toBe(40);
    // The arrangement's timeline itself runs under the dock: its grid is the
    // reference every other view's background matches.
    const timeline = await boxOf(page.locator(".arrangement-panel"), "the timeline");
    expect(timeline.y + timeline.height).toBeGreaterThanOrEqual(
      reference.dock.y + reference.dock.height,
    );

    // The sequence view with no clip opened: the empty screen is the view.
    await pressView(page, "Sequence");
    await expect(emptyScreen(page, "No clip selected")).toBeVisible();
    expectSameFrame("Sequence, empty", await frame(page, "Sequence"), reference);

    await pressView(page, "Arrangement");
    await openStarterClip(page);
    expectSameFrame("Sequence", await frame(page, "Sequence"), reference);

    for (const view of ["Instrument", "Library", "Mixer"] as const satisfies ViewName[]) {
      await pressView(page, view);
      await expect(viewRoot(page)).toBeVisible();
      if (view === "Library") {
        await expect(page.getByRole("region", { name: /Library/ })).toBeVisible();
      }
      expectSameFrame(view, await frame(page, view), reference);
    }
  });

  test("every view is full bleed to the window's edges, with no frame round it", async ({
    page,
  }) => {
    const viewport = { width: 1440, height: 900 };
    await page.setViewportSize(viewport);
    await page.goto("/projects");
    await page.getByRole("button", { name: "New Project" }).click();
    await page.getByTestId("arrangement-view-ready").waitFor();

    for (const view of [
      "Arrangement",
      "Sequence",
      "Instrument",
      "Library",
      "Mixer",
    ] as const satisfies ViewName[]) {
      if (view !== "Arrangement") await pressView(page, view);
      await expect(viewRoot(page)).toBeVisible();
      // The Instrument and Mixer views scroll the document: their foot is at
      // the bottom of it.
      await page.evaluate(() =>
        window.scrollTo(0, document.documentElement.scrollHeight),
      );
      const box = await boxOf(viewRoot(page), `${view}'s view`);
      expect
        .soft(
          { left: box.x, right: box.x + box.width, bottom: box.y + box.height },
          `${view}: the view runs to the window's left, right and bottom edges`,
        )
        .toEqual({ left: 0, right: viewport.width, bottom: viewport.height });
    }

    // Docked, the assistant takes the right edge: the arrangement meets it
    // with no strip of the editor's black between them.
    await pressView(page, "Arrangement");
    await page.getByRole("button", { name: "Assistant", exact: true }).click();
    const panel = page.getByRole("region", { name: "Assistant", exact: true });
    await panel.getByRole("button", { name: "Dock to the right", exact: true }).click();
    await expect(panel).toHaveAttribute("data-mode", "docked");
    const arrangement = await boxOf(viewRoot(page), "the arrangement");
    const assistant = await boxOf(panel, "the docked assistant");
    expect(arrangement.x + arrangement.width, "the arrangement meets the assistant").toBe(
      assistant.x,
    );
  });

  test("the instrument's rack and the mixer's desk run to the view's edges", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/projects");
    await page.getByRole("button", { name: "New Project" }).click();
    await page.getByTestId("arrangement-view-ready").waitFor();

    await pressView(page, "Instrument");
    const instrument = await boxOf(viewRoot(page), "the instrument view");
    const rack = await boxOf(page.locator(".instrument-view-body"), "the rack");
    expect(rack.y, "the rack starts at the view's top").toBe(instrument.y);
    expect(rack.x + rack.width, "the rack runs to the view's right edge").toBe(
      instrument.x + instrument.width,
    );

    await pressView(page, "Mixer");
    const mixerView = await boxOf(viewRoot(page), "the mixer view");
    const desk = await boxOf(page.locator(".mixer"), "the mixer");
    expect({ x: desk.x, y: desk.y, width: desk.width }).toEqual({
      x: mixerView.x,
      y: mixerView.y,
      width: mixerView.width,
    });
  });

  test("the docked assistant has one border, the composer's, in the editor's tone", async ({
    page,
    invitedProducer,
  }) => {
    // The composer's border is checked, so the disclosure has been answered (GRV-8).
    await seedDisclosureAnswered(invitedProducer.uid);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/projects");
    await page.getByRole("button", { name: "New Project" }).click();
    await page.getByTestId("arrangement-view-ready").waitFor();
    await page.getByRole("button", { name: "Assistant", exact: true }).click();
    const panel = page.getByRole("region", { name: "Assistant", exact: true });
    await panel.getByRole("button", { name: "Dock to the right", exact: true }).click();
    await expect(panel).toHaveAttribute("data-mode", "docked");

    const editorBackground = await page.evaluate(() =>
      getComputedStyle(document.body).getPropertyValue("--color-background").trim(),
    );
    const edges = await panel.evaluate((root) => {
      const borders: string[] = [];
      for (const element of [root, ...root.querySelectorAll("*")]) {
        if (element.closest(".assistant-panel-edge")) continue;
        const style = getComputedStyle(element);
        const name = `${element.tagName.toLowerCase()}.${element.getAttribute("class")}`;
        for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
          const width = style.getPropertyValue(`border-${side.toLowerCase()}-width`);
          if (
            style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== "none" &&
            width !== "0px"
          ) {
            borders.push(
              `${name} border-${side.toLowerCase()} ${width} ${style.getPropertyValue(`border-${side.toLowerCase()}-color`)}`,
            );
          }
        }
        if (style.boxShadow !== "none")
          borders.push(`${name} box-shadow ${style.boxShadow}`);
      }
      return borders;
    });
    const tone = await page.evaluate((colour) => {
      const probe = document.createElement("div");
      probe.style.color = colour;
      document.body.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    }, editorBackground);
    expect(edges).toEqual([`div.assistant-panel-composer border-top 1px ${tone}`]);
  });
});
