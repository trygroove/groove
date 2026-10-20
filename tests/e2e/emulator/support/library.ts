import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { reloadPage } from "./reload";
import { expectView, pressView } from "./views";

/**
 * What the redesigned library's core flows (CF-023 to CF-026 and CF-030, #449
 * and #817) share: the way from the dashboard to a drum pad's sample slot, the
 * locators for the Library view, and a read of the library the emulator suite
 * serves.
 *
 * It lives here rather than in each spec so the four contracts name the same
 * surface the same way. Each spec keeps its own numbered steps, assertions and
 * `step()` captions.
 *
 * **Every library locator below is assumed.** None of this UI exists yet. They
 * come from #449's decisions and the reference design (`docs/library-browser.html`,
 * on `claude/keen-hamilton-vdhzy4`), matched by role and purpose as CF-005 does.
 * The implementing PRs build to these names, or say in their body why one had
 * to change:
 *
 *  - the library is a **view** (#817), a region named "Library" that fills the
 *    page at `/projects/:id/library`. There is no dialog and no close button:
 *    `3` goes back to the instrument without inserting;
 *  - the header is a heading that names the target as a path, starting
 *    "Inserting into" ("Inserting into BD › Drum machine › BD");
 *  - its readouts are groups named "In the slot" (the sound the slot holds
 *    now, which follows each insert) and "Hearing" (the one selected);
 *  - the rail has buttons whose names start "Browse packs", "All sounds" and
 *    "Favourites", the one in view marked `aria-current`, and the project's
 *    packs in a group named "In this project";
 *  - family tabs are tabs named for the family ("Drums…"); category chips are
 *    toggle buttons named for the category ("Kick…", "Impact…");
 *  - the genre menu opens from a button named "Any genre" and holds a
 *    checkbox per genre, named for it ("House…");
 *  - the result count reads "<n> sounds";
 *  - sounds are a list named "Sounds" (or "Similar sounds"); each row has an
 *    "Audition <name>" button, a "Favourite <name>" toggle and a
 *    "Sounds like <name>" button;
 *  - the primary action is a button whose name starts "Insert <name>". It does
 *    what `Enter` does: it inserts and goes back to the instrument view
 *    (`Shift+Enter` inserts and stays in the library);
 *  - a sample slot is still a button named "Sample for <pad>", showing the
 *    sound's name, the library's icon and the key `4`. The slot the library is
 *    aimed at is marked `aria-current="true"`.
 *
 * The rest is surface that exists today: the drum machine region and its
 * pads' "Audition <pad>" and "Sample for <pad>" buttons (#447), the slot's
 * `.sample-slot-name` (the one part of the slot that is only the sound's
 * name), and the header's "Undo" button. The views are `./views.ts`'s.
 */

export type Step = (caption: string) => Promise<void>;

/** A regular expression that matches `text` literally. */
export const literal = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// --- The editor --------------------------------------------------------------

/** The starter track's drum machine, as the instrument view shows it (#447). */
export const drumMachine = (page: Page): Locator =>
  page.getByRole("region", { name: "Drum machine: BD" });

/** One pad's sample slot: a button naming the sound it holds (#447). */
export const sampleSlot = (page: Page, pad: string): Locator =>
  drumMachine(page).getByRole("button", { name: `Sample for ${pad}`, exact: true });

/**
 * The sound a slot names. Read off its name alone, because the slot also
 * carries the library's key, `4` (#817).
 */
export async function slotSound(page: Page, pad: string): Promise<string> {
  const name = sampleSlot(page, pad).locator(".sample-slot-name");
  return ((await name.textContent()) ?? "").trim();
}

/** The header's undo button. It is named "Undo" alone while history is empty. */
export const emptyUndo = (page: Page): Locator =>
  page.getByRole("button", { name: "Undo", exact: true });

/**
 * Create a new project from the dashboard and go to the instrument view,
 * where the starter drum machine's pads are. Returns the project's address.
 */
export async function newProjectOnInstrumentView(page: Page): Promise<string> {
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await page.getByRole("button", { name: "New Project" }).click();
  await expect(page).toHaveURL(/\/projects\/prj_[^/]+$/);
  const projectUrl = page.url();
  await page.getByTestId("arrangement-view-ready").waitFor();
  await goToInstrumentView(page);
  return projectUrl;
}

export async function goToInstrumentView(page: Page): Promise<void> {
  await pressView(page, "Instrument");
  await expect(drumMachine(page)).toBeVisible();
}

/** Select a pad: its name button selects it, so the pad editor shows its slot. */
export async function selectPad(page: Page, pad: string): Promise<void> {
  await drumMachine(page)
    .getByRole("button", { name: `Audition ${pad}`, exact: true })
    .click();
  await expect(sampleSlot(page, pad)).toBeVisible();
}

/** Select a pad and press its sample slot: the editor goes to the Library view. */
export async function openPadSlot(page: Page, pad: string): Promise<void> {
  await selectPad(page, pad);
  await expect(sampleSlot(page, pad)).toContainText("4");
  await sampleSlot(page, pad).click();
  await expectView(page, "Library");
  await expect(library(page)).toBeVisible();
  await expect(libraryHeader(page)).toContainText(pad);
}

/** Press `3`: back to the instrument without inserting anything. */
/** The Insert button inserted and went back to the instrument view (UI-002). */
export async function insertedBackToInstrument(page: Page): Promise<void> {
  await expect(library(page)).toHaveCount(0);
  await expect(drumMachine(page)).toBeVisible();
}

export async function backToInstrument(page: Page): Promise<void> {
  await pressView(page, "Instrument");
  await expect(library(page)).toHaveCount(0);
  await expect(drumMachine(page)).toBeVisible();
}

/**
 * Wait for the editor to report the last edit written, then reload and come
 * back to the instrument view. `.save-status` is the class CF-004, CF-005 and
 * CF-007 read: the save indicator has no role of its own.
 */
export async function reloadOnInstrumentView(
  page: Page,
  projectUrl: string,
): Promise<void> {
  await expect(page.locator(".save-status")).toHaveText("Saved", { timeout: 10_000 });
  await reloadPage(page);
  await expect(page).toHaveURL(`${projectUrl}/instrument`);
  await expect(drumMachine(page)).toBeVisible();
}

// --- The Library view (assumed; see the header) -------------------------------

// Exact: the library's own keys sheet ("Library keys", #813) is a dialog
// inside it, and a substring match would find both while it is open.
export const library = (page: Page): Locator =>
  page.getByRole("region", { name: "Library", exact: true });

export const libraryHeader = (page: Page): Locator =>
  library(page).getByRole("heading", { name: /^Inserting into / });

export const readout = (page: Page, name: "In the slot" | "Hearing"): Locator =>
  library(page).getByRole("group", { name });

export const railButton = (
  page: Page,
  name: "Browse packs" | "All sounds" | "Favourites" | "Recently heard",
): Locator => library(page).getByRole("button", { name: new RegExp(`^${name}\\b`) });

export const projectPacks = (page: Page): Locator =>
  library(page).getByRole("group", { name: "In this project" });

export const familyTab = (page: Page, family: string): Locator =>
  library(page).getByRole("tab", { name: new RegExp(`^${literal(family)}\\b`) });

export const categoryChip = (page: Page, category: string): Locator =>
  library(page).getByRole("button", { name: new RegExp(`^${literal(category)}\\b`) });

export const soundList = (page: Page): Locator =>
  library(page).getByRole("list", { name: "Sounds", exact: true });

export const similarList = (page: Page): Locator =>
  library(page).getByRole("list", { name: "Similar sounds", exact: true });

export const audition = (scope: Locator, name: string): Locator =>
  scope.getByRole("button", { name: `Audition ${name}`, exact: true });

export const insertButton = (page: Page, name: string): Locator =>
  library(page).getByRole("button", { name: new RegExp(`^Insert ${literal(name)}\\b`) });

/** The result count, "<n> sounds", as a number. */
export async function resultCount(page: Page): Promise<number> {
  const text = await library(page)
    .getByText(/^\d+ sounds?$/)
    .first()
    .textContent();
  return Number(text?.match(/\d+/)?.[0] ?? Number.NaN);
}

/**
 * The sound names a list shows, top to bottom, read off its audition buttons
 * (their `aria-label`, as CF-005 reads its rows).
 */
export async function listedNames(list: Locator): Promise<string[]> {
  // Every list these flows read has sounds in it; wait for the first to render.
  await expect(list.getByRole("listitem").first()).toBeVisible();
  const buttons = list.getByRole("button", { name: /^Audition / });
  const labels = await buttons.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("aria-label") ?? ""),
  );
  return labels.map((label) => label.replace(/^Audition /, ""));
}

/**
 * Select a sound and check the library says so: it is the one you are
 * hearing, and it is the one Insert would put in the slot.
 */
export async function expectSelected(page: Page, name: string): Promise<void> {
  await expect(readout(page, "Hearing")).toContainText(name);
  await expect(insertButton(page, name)).toBeVisible();
}

// --- The library the emulator suite serves ------------------------------------

/**
 * One sound in the delivered library, read from the same pack index and
 * manifests the app fetches. The emulator suite serves whatever
 * `bun run library:build` writes to `public/samples/starter-library` (see
 * `tests/e2e/emulator/playwright.config.ts`), so this is the flows' fixture
 * library: the specs derive what the UI must show from it rather than naming
 * sounds, and a precondition it does not meet fails loudly by name.
 */
export interface DeliveredSound {
  readonly name: string;
  readonly pack: string;
  readonly packId: string;
  readonly family: string;
  readonly role: string;
  readonly type: string;
  readonly genres: readonly string[];
}

const LIBRARY_ROOT = "/samples/starter-library";

interface PackIndex {
  readonly packs: readonly { id: string; name: string; manifestPath: string }[];
}
interface PackManifest {
  readonly assets: readonly {
    name: string;
    family: string;
    role: string;
    type: string;
    tags?: { genres?: string[] };
  }[];
}

async function getJson<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`${LIBRARY_ROOT}/${path}`);
  expect(response.ok(), `${path} is served`).toBe(true);
  return (await response.json()) as T;
}

export async function deliveredLibrary(page: Page): Promise<DeliveredSound[]> {
  const index = await getJson<PackIndex>(page.request, "packs/index.json");
  const sounds: DeliveredSound[] = [];
  for (const pack of index.packs) {
    const manifest = await getJson<PackManifest>(page.request, pack.manifestPath);
    for (const asset of manifest.assets) {
      sounds.push({
        name: asset.name,
        pack: pack.name,
        packId: pack.id,
        family: asset.family,
        role: asset.role,
        type: asset.type,
        genres: asset.tags?.genres ?? [],
      });
    }
  }
  return sounds;
}

/** The one-shots of one family's role (drums' "kick", fx's "impact"), as a category lists them. */
export const oneShots = (
  sounds: readonly DeliveredSound[],
  family: string,
  role: string,
) =>
  sounds.filter((s) => s.family === family && s.role === role && s.type === "one-shot");

/** The one-shots of one drum role ("kick"), which a pad's list opens on. */
export const drumOneShots = (sounds: readonly DeliveredSound[], role: string) =>
  oneShots(sounds, "drums", role);

/** Fail by name when the served library lacks what a flow's preconditions state. */
export function precondition(met: unknown, flow: string, what: string): asserts met {
  if (!met) {
    throw new Error(
      `${flow} precondition not met by the served library: ${what}. See the spec's header.`,
    );
  }
}
