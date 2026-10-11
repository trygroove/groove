import { expect, type Locator, type Page } from "@playwright/test";
import {
  ASSISTANT_DISCLOSURE_VERSION,
  preferenceDocPath,
} from "../../../../src/assistant/transcripts";

/**
 * Shared steps and locators for the assistant's core flows (CF-027, CF-028).
 *
 * Every locator below was written from #72 and its reference design,
 * `docs/assistant-panel.html`, before the assistant existed, against
 * accessible names and roles only, so the implementation is free to arrange
 * its markup. The panel (#849), the conversation (GRV-26) and the proposal
 * card (GRV-5) meet them as written.
 *
 *  - the header's "Assistant" button (`aria-keyshortcuts` carries Ctrl+K/⌘K);
 *  - the panel: a region named "Assistant", whose header has "Minimise",
 *    "Dock to the right", "Float" and "Close" buttons. Minimised, the region
 *    is the header bar alone, and a click on its title floats it again;
 *  - its resize edge: a separator named "Resize height" while floating and
 *    "Resize width" while docked;
 *  - the composer: a textbox named "Message the assistant", and a button named
 *    "Scope: <what>" that says what the assistant reads and may change;
 *  - the conversation: a log named "Conversation";
 *  - a proposal: a region named "Proposal" with "Preview", "Apply" and "Cancel"
 *    buttons, which says "Applied" once it has been;
 *  - a recommended pack (GRV-23, CF-034): a region named "Recommended pack:
 *    <pack>", with a list named "Sounds" whose items each hold a "Hear <sound>"
 *    button, and "Try on <slot>", "Keep", "Put back", "Pack demo" and "Open in
 *    library" buttons. Its status line is an `output`.
 *
 * Existing editor names it reads: the header's "Swing" button, whose title is
 * "Swing <n>%" (#447), the mixer's "Volume for <track>" slider (CF-008), and
 * the view dock's links (CF-008).
 */

// --- The editor --------------------------------------------------------------

/** The arrangement view. It has no accessible name, so its ready marker is used. */
export const arrangement = (page: Page): Locator =>
  page.getByTestId("arrangement-view-ready");

/** The header's swing control. Its title reads out the song's swing. */
export const swing = (page: Page): Locator =>
  page.getByRole("button", { name: "Swing", exact: true });

/** The song's swing as the header reads it out, e.g. 50. */
export async function swingPercent(page: Page): Promise<number> {
  const title = (await swing(page).getAttribute("title")) ?? "";
  const match = title.match(/(\d+)%/);
  if (!match) throw new Error(`the swing control reads "${title}"`);
  return Number(match[1]);
}

/** A track's volume fader on the mixer. */
export const volume = (page: Page, track: string): Locator =>
  page.getByRole("slider", { name: `Volume for ${track}` });

/**
 * Create a new project from the dashboard and wait for its arrangement.
 * Returns the project's address.
 */
export async function newProject(page: Page): Promise<string> {
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await page.getByRole("button", { name: "New Project" }).click();
  await expect(page).toHaveURL(/\/projects\/prj_[^/]+$/);
  const projectUrl = page.url();
  await arrangement(page).waitFor();
  return projectUrl;
}

/** Go to one of the editor's views through the view dock. */
export async function goToView(page: Page, name: "Arrangement" | "Mixer"): Promise<void> {
  await page
    .getByRole("navigation", { name: "Views" })
    .getByRole("link", { name })
    .click();
}

/** Wait for the last edit to be written, then reload. */
export async function reloadSaved(page: Page): Promise<void> {
  await expect(page.locator(".save-status")).toHaveText("Saved", { timeout: 10_000 });
  await page.reload();
}

// --- The assistant -----------------------------------------------------------

/** The header button that opens and closes the assistant. */
export const assistantButton = (page: Page): Locator =>
  page.getByRole("button", { name: "Assistant", exact: true });

/** The assistant panel, floating or docked. */
export const panel = (page: Page): Locator =>
  page.getByRole("region", { name: "Assistant", exact: true });

export const panelButton = (page: Page, name: string): Locator =>
  panel(page).getByRole("button", { name, exact: true });

export const resizeEdge = (page: Page, name: "Resize height" | "Resize width"): Locator =>
  panel(page).getByRole("separator", { name });

/** The disclosure the assistant shows before the first message (GRV-8). */
export const disclosure = (page: Page): Locator =>
  panel(page).getByRole("region", { name: "About the assistant" });

/**
 * Answers the disclosure a fresh account meets the first time it opens the
 * assistant (GRV-8), and waits for the composer it gives way to. Declining is
 * the default: keeping or not, the assistant behaves the same.
 */
export async function answerDisclosure(
  page: Page,
  answer: "Keep for 30 days" | "Don't keep them" = "Don't keep them",
): Promise<void> {
  await disclosure(page).getByRole("button", { name: answer, exact: true }).click();
  await expect(composer(page)).toBeVisible();
}

/**
 * Records `uid` as having answered the disclosure already, as an account
 * that met it in an earlier session has (GRV-8). Written through the
 * Firestore emulator's REST API with its `owner` token, which bypasses the
 * rules the way the `assistantRetention` function's admin credential does:
 * no client may write the answer itself.
 */
export async function seedDisclosureAnswered(uid: string, retain = false): Promise<void> {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
  const url =
    `http://${host}/v1/projects/demo-solid-groove/databases/(default)/documents/` +
    preferenceDocPath(uid);
  const response = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        schemaVersion: { integerValue: "1" },
        retain: { booleanValue: retain },
        disclosureVersion: { integerValue: String(ASSISTANT_DISCLOSURE_VERSION) },
        answeredAt: { integerValue: String(Date.now()) },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `The Firestore emulator refused the disclosure answer (${response.status}): ` +
        `${await response.text()}`,
    );
  }
}

export const composer = (page: Page): Locator =>
  panel(page).getByRole("textbox", { name: "Message the assistant" });

export const scope = (page: Page): Locator =>
  panel(page).getByRole("button", { name: /^Scope\b/ });

export const conversation = (page: Page): Locator =>
  panel(page).getByRole("log", { name: "Conversation" });

export const proposal = (page: Page): Locator =>
  panel(page)
    .getByRole("region", { name: /^Proposal\b/ })
    .last();

export const proposalButton = (
  page: Page,
  name: "Preview" | "Apply" | "Cancel",
): Locator => proposal(page).getByRole("button", { name: new RegExp(`^${name}\\b`) });

/** The newest recommended pack in the conversation (GRV-23). */
export const recommendation = (page: Page): Locator =>
  panel(page)
    .getByRole("region", { name: /^Recommended pack\b/ })
    .last();

export const recommendationButton = (page: Page, name: string): Locator =>
  recommendation(page).getByRole("button", { name: new RegExp(`^${name}\\b`) });

/** The sounds a recommended pack lists, in its order. */
export const recommendedSounds = (page: Page): Locator =>
  recommendation(page).getByRole("list", { name: "Sounds" }).getByRole("listitem");

/** The name of the sound a recommendation lists at `index`, read off its Hear button. */
export async function recommendedSound(page: Page, index: number): Promise<string> {
  const hear = recommendedSounds(page)
    .nth(index)
    .getByRole("button", { name: /^Hear\b/ });
  const label = (await hear.getAttribute("aria-label")) ?? "";
  const name = label.replace(/^Hear\s+/, "").trim();
  if (!name) throw new Error(`the recommendation's sound ${index + 1} has no name`);
  return name;
}

/** The Ctrl+K / ⌘K chord, as Playwright spells it for either platform. */
export const ASSISTANT_CHORD = "ControlOrMeta+k";

/** A box on screen, or a failure that names what had none. */
export async function boxOf(
  locator: Locator,
  what: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${what} has no box on screen`);
  return box;
}

/** Drag a locator's centre by (dx, dy) with the mouse. */
export async function drag(
  page: Page,
  handle: Locator,
  dx: number,
  dy: number,
): Promise<void> {
  const box = await boxOf(handle, "the resize edge");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}
