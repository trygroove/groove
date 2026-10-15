import type { Page, Request } from "@playwright/test";
import {
  answerDisclosure,
  assistantButton,
  composer,
  conversation,
  newProject,
} from "./support/assistant";
import { expect, test } from "./support/test";

/**
 * A tutorial video the assistant recommends (GRV-16, ADR 0009), against the
 * real gateway in the Functions emulator. Its scripted provider answers
 * `[video]` with two videos, and the emulator's check vouches for only one,
 * so one card shows and the other is dropped. YouTube's player is stubbed
 * here, so the suite never depends on YouTube, and every request bound for
 * Google is recorded to prove none leaves before Play.
 */

/** `EMULATOR_VIDEO` in `src/assistant/emulatorProvider.ts`. */
const EMULATOR_VIDEO = {
  videoId: "tH9LHIyJ0c8",
  title: "How to Make an Acid Bassline with the TB-303 by Roland Cloud",
  channel: "pointblank music school",
};

const GOOGLE = /(^|\.)(youtube|youtube-nocookie|ytimg|googlevideo|ggpht)\.com$/;

async function recordGoogle(page: Page): Promise<Request[]> {
  const sent: Request[] = [];
  await page.route(
    (url) => GOOGLE.test(url.hostname),
    async (route) => {
      sent.push(route.request());
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>player</title><p>Stub player</p>",
      });
    },
  );
  return sent;
}

test.describe("a tutorial video the assistant recommends", () => {
  test("is a still card until Play, then plays in the privacy-enhanced player", async ({
    page,
  }) => {
    const sent = await recordGoogle(page);
    await newProject(page);
    await assistantButton(page).click();
    await answerDisclosure(page);
    await composer(page).fill("How do I get that acid squelch? [video]");
    await page.keyboard.press("Enter");

    const card = conversation(page).getByRole("region", { name: /^Tutorial video:/ });
    // The emulator's check dropped the video that does not exist.
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(EMULATOR_VIDEO.title);
    await expect(card).toContainText(EMULATOR_VIDEO.channel);
    await expect(card).toContainText(/YouTube's terms/);
    await expect(card.locator("iframe")).toHaveCount(0);
    expect(sent).toHaveLength(0);

    await card.getByRole("button", { name: /^Play / }).click();
    const frame = card.locator("iframe");
    await expect(frame).toHaveAttribute(
      "src",
      new RegExp(
        `^https://www\\.youtube-nocookie\\.com/embed/${EMULATOR_VIDEO.videoId}\\?`,
      ),
    );
    // Focus stays in the card, out of the player.
    await expect(card.getByRole("button", { name: "Close video" })).toBeFocused();
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    for (const request of sent) {
      expect(new URL(request.url()).hostname).toBe("www.youtube-nocookie.com");
      // Groove's origin at most, never the project's path.
      expect(request.headers().referer ?? "").not.toMatch(/\/projects\//);
    }

    // Full screen fills the window with the same player; Escape puts it back.
    await card.getByRole("button", { name: "Full screen" }).click();
    const viewport = page.viewportSize();
    const box = await frame.boundingBox();
    expect(box?.width).toBe(viewport?.width);
    // Over the app's chrome too: the release badge is under the player.
    const badge = await page.locator(".release-badge").boundingBox();
    if (!badge) throw new Error("no release badge");
    const onTop = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest(".assistant-video-expanded") != null,
      { x: badge.x + badge.width / 2, y: badge.y + badge.height / 2 },
    );
    expect(onTop).toBe(true);
    await page.keyboard.press("Escape");
    await expect(card).not.toHaveClass(/assistant-video-expanded/);
    // One press puts the video back and nothing else: the panel stays open.
    await expect(page.getByRole("region", { name: "Cue" })).toBeVisible();

    await card.getByRole("button", { name: "Close video" }).click();
    await expect(card.locator("iframe")).toHaveCount(0);
  });
});
