import { reloadPage } from "./support/reload";
import { expect, type Locator, type Page, test } from "./support/test";

// #892: a project made before the factory packs moved from 1.0.0 to 1.1.0 pins
// Core Electronic Drums at 1.0.0, and production serves only 1.1.0. Inserting a
// 1.1.0 sound into it used to be refused by the one-version-per-pack invariant
// and leave the library open with nothing said. Now the insert moves the
// project's pin to 1.1.0 in the same transaction, without asking, because every
// sound the project already uses from the pack is still in 1.1.0.
//
// The project is made the way any is, then aged: its stored documents are
// rewritten through the Firestore emulator's REST API (the `owner` token
// bypasses the rules) so every pack pin reads 1.0.0, exactly what an older
// project carries. A reload then opens it from the emulator.

const firestoreEmulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const DOCUMENTS = `http://${firestoreEmulatorHost}/v1/projects/demo-solid-groove/databases/(default)/documents`;
const CURRENT = "1.1.0";
const OLDER = "1.0.0";

// The Library view (#817), as the core flows name it.
const library = (page: Page): Locator =>
  page.getByRole("region", { name: "Library", exact: true });

/** A Firestore REST value, as far as rewriting pack versions needs. */
type FirestoreValue = {
  stringValue?: string;
  mapValue?: { fields?: Record<string, FirestoreValue> };
  arrayValue?: { values?: FirestoreValue[] };
  [key: string]: unknown;
};

/** Every `packVersion`/`version` at the current release, set to the older one. */
function agePins(fields: Record<string, FirestoreValue>): Record<string, FirestoreValue> {
  const age = (key: string, value: FirestoreValue): FirestoreValue => {
    if ((key === "packVersion" || key === "version") && value.stringValue === CURRENT) {
      return { stringValue: OLDER };
    }
    if (value.mapValue?.fields) {
      return { mapValue: { fields: agePins(value.mapValue.fields) } };
    }
    if (value.arrayValue?.values) {
      return {
        arrayValue: { values: value.arrayValue.values.map((item) => age("", item)) },
      };
    }
    return value;
  };
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, age(key, value)]),
  );
}

/** Rewrites one stored document's pack pins to the older version. */
async function ageDocument(page: Page, path: string): Promise<number> {
  const url = `${DOCUMENTS}/${path}`;
  const headers = { Authorization: "Bearer owner" };
  const response = await page.request.get(url, { headers });
  expect(response.ok(), `GET ${path}`).toBe(true);
  const document = (await response.json()) as { fields: Record<string, FirestoreValue> };
  const before = JSON.stringify(document.fields);
  const fields = agePins(document.fields);
  const aged = before.split(`"stringValue":"${CURRENT}"`).length - 1;
  const patched = await page.request.patch(url, { headers, data: { fields } });
  expect(patched.ok(), `PATCH ${path}`).toBe(true);
  return aged;
}

test("inserting a 1.1.0 sound into a project pinned to 1.0.0 lands, and survives a reload", async ({
  page,
}) => {
  await page.goto("/projects");
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByTestId("arrangement-view-ready").waitFor();
  const projectId = /\/projects\/([^/]+)/.exec(new URL(page.url()).pathname)?.[1];
  if (!projectId) throw new Error(`no project id in ${page.url()}`);

  // Leave the editor first, so nothing it saves races the rewrite.
  await page.goto("/projects");
  const pins =
    (await ageDocument(page, `projects/${projectId}`)) +
    (await ageDocument(page, `projects/${projectId}/song/current`));
  expect(pins, "the new project carried no pack pin to age").toBeGreaterThan(0);

  await page.goto(`/projects/${projectId}/instrument`);
  const drums = page.getByRole("region", { name: "Drum machine: BD" });
  await drums.getByRole("button", { name: "Audition BD", exact: true }).click();
  const slot = drums.getByRole("button", { name: "Sample for BD", exact: true });
  // The slot's name alone: the slot also carries the Library's key (#817).
  const slotName = slot.locator(".sample-slot-name");
  const was = (await slotName.textContent())?.trim();
  await slot.click();
  await expect(library(page)).toBeVisible();

  // Any kick but the one the pad already plays.
  const rows = library(page)
    .getByRole("list", { name: "Sounds", exact: true })
    .getByRole("listitem");
  await expect(rows.nth(1)).toBeVisible();
  const candidates = rows.getByRole("button", { name: /^Audition / });
  let chosen = "";
  for (let index = 0; index < (await candidates.count()); index += 1) {
    const label = (await candidates.nth(index).getAttribute("aria-label")) ?? "";
    const name = label.replace(/^Audition /, "");
    if (name && name !== was) {
      chosen = name;
      await candidates.nth(index).click();
      break;
    }
  }
  expect(chosen).not.toBe("");
  await library(page)
    .getByRole("button", { name: `Insert ${chosen}` })
    .click();

  // Insert goes back to the instrument, where the slot shows the new sound.
  await expect(library(page)).toBeHidden();
  await expect(slotName).toHaveText(chosen);

  // Saved at the new pin: a reload from the emulator still plays it.
  await expect(page.locator(".save-status")).toHaveText("Saved", { timeout: 15_000 });
  await reloadPage(page);
  await expect(
    page
      .getByRole("region", { name: "Drum machine: BD" })
      .getByRole("button", { name: "Sample for BD", exact: true })
      .locator(".sample-slot-name"),
  ).toHaveText(chosen);
});
