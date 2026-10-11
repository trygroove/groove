import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Onboarding (GRV-25), from a flow's side: the profile a fresh account starts
 * with, and the locators CF-035 reads.
 *
 * ## Why every seeded account has been through onboarding
 *
 * Every account that has not completed or skipped onboarding is taken to the
 * welcome (`/welcome`) when it opens the dashboard. Almost every spec starts
 * from "a fresh invited producer on the dashboard", and none of them is about
 * onboarding, so `seedRegisteredSession` writes each fresh account a profile
 * that has skipped it, the way a producer who chose "Skip to the studio"
 * already has one. CF-035, the flow that is about onboarding, asks for an
 * account with no profile at all.
 *
 * Written through the Firestore emulator's REST API with its `owner` bearer
 * token, which bypasses security rules the way the Admin SDK's credential
 * does; the document is the shape `src/persistence/profileDocuments.ts`
 * encodes.
 *
 * ## Locators
 *
 * Written from GRV-25's spec against accessible names and roles only:
 *
 *  - the welcome: a `main` whose level-1 heading is Cue's name;
 *  - Cue's question: a region named "Cue asks", its options buttons named
 *    by their labels, a "Skip this question" button, and a text box for the
 *    answer in the producer's own words ("Artists you love" on the first
 *    question, "Something else" on the others) with a "Send the answer"
 *    button;
 *  - "Skip to the studio", and at the end "Open the studio";
 *  - the memory card: a region named "Saved to memory", with an unticked
 *    checkbox to share the answers' choices;
 *  - in the editor, Cue's panel: a region named "Cue", holding the
 *    conversation (a log named "Conversation").
 */

const firestoreEmulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PROJECT_ID = "demo-solid-groove";

/** The assistant's name, as the product spells it. */
export const CUE = "Cue";

/**
 * Writes `uid` a profile that has skipped onboarding, with nothing in memory,
 * so the dashboard opens as it always has.
 */
export async function seedSkippedOnboarding(uid: string): Promise<void> {
  const url =
    `http://${firestoreEmulatorHost}/v1/projects/${PROJECT_ID}/databases/(default)` +
    `/documents/users/${encodeURIComponent(uid)}/profile/current`;
  const now = String(Date.now());
  const emptyList = { arrayValue: {} };
  const response = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        schemaVersion: { integerValue: "1" },
        onboarding: { stringValue: "skipped" },
        onboardedAt: { integerValue: now },
        memory: {
          mapValue: {
            fields: {
              taste: emptyList,
              artists: { stringValue: "" },
              experience: { nullValue: null },
              goal: { nullValue: null },
              learn: emptyList,
              gear: emptyList,
            },
          },
        },
        notes: emptyList,
        laterQuestions: emptyList,
        validationConsent: { booleanValue: false },
        lastNudgeDay: { nullValue: null },
        modifiedAt: { integerValue: now },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `The Firestore emulator refused to seed a profile (${response.status}): ` +
        `${await response.text()}`,
    );
  }
}

/** The welcome page. */
export const welcome = (page: Page): Locator => page.getByRole("main");

/** Cue's question, on the welcome or in the panel. */
export const cueAsks = (scope: Page | Locator): Locator =>
  scope.getByRole("region", { name: `${CUE} asks` });

export const askOption = (scope: Page | Locator, label: string): Locator =>
  cueAsks(scope).getByRole("button", { name: label, exact: true });

export const askText = (scope: Page | Locator, name: string): Locator =>
  cueAsks(scope).getByRole("textbox", { name });

export const sendAnswer = (scope: Page | Locator): Locator =>
  cueAsks(scope).getByRole("button", { name: "Send the answer" });

export const skipQuestion = (scope: Page | Locator): Locator =>
  cueAsks(scope).getByRole("button", { name: "Skip this question" });

export const memoryCard = (page: Page): Locator =>
  page.getByRole("region", { name: "Saved to memory" });

/** Cue's panel in the editor. */
export const cuePanel = (page: Page): Locator =>
  page.getByRole("region", { name: CUE, exact: true });

/** The conversation, on the welcome or in the panel. */
export const conversationIn = (scope: Page | Locator): Locator =>
  scope.getByRole("log", { name: "Conversation" });

/** Waits for Cue's next question to be `question`. */
export async function expectQuestion(page: Page, question: RegExp): Promise<void> {
  await expect(cueAsks(page)).toBeVisible();
  await expect(cueAsks(page)).toContainText(question);
}
