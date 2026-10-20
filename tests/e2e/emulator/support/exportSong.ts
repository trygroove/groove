import { expect, type Locator, type Page } from "@playwright/test";
import { reloadPage } from "./reload";

/**
 * The song both export core flows build before they export it: steps 1 to 7
 * of CF-021 (stereo WAV) and CF-022 (stems), which the register words
 * identically so the two exports are measured against the same project.
 *
 * It lives here rather than in each spec because the two copies would have to
 * be kept word for word in step, and a drift between them would make one flow
 * quietly test a different song. Every `step()` caption is still the flow's own
 * wording, and the spec passes its own `step` in, so each flow's walkthrough is
 * captured under its own ID.
 *
 * The UI it drives is the UI other live flows already drive, named the same
 * way: the step grid (CF-001), the piano roll (CF-017), the library modal and
 * the loop's track (CF-005), the device chain (CF-012) and the master strip
 * (CF-007). Only the export itself is new, and that is in the specs.
 */

export type Step = (caption: string) => Promise<void>;

/** Musical time at 192 PPQ in the alpha's fixed 4/4 (`src/domain/time.ts`). */
const TICKS_PER_BAR = 4 * 192;

/**
 * The one-shot step 4 loads on the Piano track: the register names it
 * (Tonal Elements, role `key`; the library has no sound called a piano). It is
 * named here, once, so the flow finds the same sound however the browser
 * orders results.
 */
export const PIANO_SOUND = "Tine Electric Key";

export interface ExportSong {
  readonly projectUrl: string;
  readonly projectName: string;
  /** The song tempo, in BPM, as the header shows it. */
  readonly tempo: number;
  /** The loop's track, named for the loop it carries (CF-005). */
  readonly loopTrack: string;
  /** How long the loop's clip is, in bars, as the loop panel states it. */
  readonly loopBars: number;
}

/**
 * The step 1 drum patterns, pad by pad, as the steps that are on: the starter
 * track's "BD" pad, and the "HH" and "CP" pads of the added "Drums" track. A
 * new project's starter drum machine has only a "BD" pad, while a drum-machine
 * track added in the editor carries the full starter kit (`STARTER_KIT` in
 * `src/instrument/instrumentKinds.ts`), which is why the hats and clap go on a
 * track of their own.
 */
const KICK = { BD: [1, 5, 9, 13] } as const;
const DRUMS = {
  HH: [3, 7, 11, 15],
  CP: [5, 13],
} as const;

/** The track names in track order, the loop's track aside (named for its loop). */
const tracksInOrder = (loopTrack: string): string[] => [
  "BD",
  "Drums",
  "Bass",
  loopTrack,
  "Piano",
];

/** Arrangement rows, in the order steps 1 to 4 add the tracks. */
const ROW = { BD: 0, Drums: 1, Bass: 2, loop: 3, Piano: 4 } as const;

const BASS_NOTES = [
  "C2, step 1, 1 step",
  "D♯2, step 5, 1 step",
  "C2, step 9, 1 step",
  "G2, step 13, 1 step",
];

const PIANO_NOTES = [
  "C3, step 1, 1 step",
  "D♯3, step 1, 1 step",
  "G3, step 1, 1 step",
  "A♯3, step 9, 1 step",
];

// --- Surfaces, by role and name -------------------------------------------

/** The arrangement's interaction canvas: a `<canvas>`, so a class (CF-001). */
const timeline = (page: Page): Locator => page.locator(".arrangement-layer-interactive");

export const trackList = (page: Page): Locator =>
  page.getByRole("list", { name: "Arrangement tracks" }).getByRole("listitem");

const sequenceEditor = (page: Page): Locator =>
  page.getByRole("region", { name: "Sequence editor" });

const selectedPlacements = (page: Page): Locator =>
  page.getByTestId("placement-selection").locator("li");

const viewLink = (page: Page, name: "Arrangement" | "Instrument" | "Mixer"): Locator =>
  page.getByRole("navigation", { name: "Views" }).getByRole("link", { name });

const library = (page: Page): Locator =>
  page.getByRole("region", { name: "Library", exact: true });
const librarySearch = (page: Page): Locator =>
  library(page).getByRole("searchbox", { name: "Search sounds" });

const railSelect = (page: Page, track: string): Locator =>
  page
    .getByRole("list", { name: "Tracks" })
    .getByRole("button", { name: `Edit ${track}`, exact: true });

const trackDevices = (page: Page): Locator =>
  page
    .getByRole("region", { name: "Device chain" })
    .getByRole("list", { name: "Device chain" })
    .getByRole("listitem");

const mixer = (page: Page): Locator => page.getByRole("region", { name: "Mixer" });
const masterView = (page: Page): Locator =>
  page.getByRole("region", { name: "Master effects" });
const masterDevices = (page: Page): Locator =>
  masterView(page).getByRole("list", { name: "Master chain" }).getByRole("listitem");

// --- The arrangement ------------------------------------------------------

async function barOneOfRow(page: Page, row: number): Promise<{ x: number; y: number }> {
  const root = page.getByTestId("arrangement-view-ready");
  const pixelsPerTick = Number(await root.getAttribute("data-pixels-per-tick"));
  const rulerHeight = Number(await root.getAttribute("data-ruler-height"));
  const rowHeight = Number(await root.getAttribute("data-row-height"));
  expect(pixelsPerTick).toBeGreaterThan(0);
  expect(rowHeight).toBeGreaterThan(0);
  return {
    x: 0.5 * TICKS_PER_BAR * pixelsPerTick,
    y: rulerHeight + row * rowHeight + rowHeight / 2,
  };
}

async function openClip(page: Page, row: number): Promise<Locator> {
  await timeline(page).dblclick({ position: await barOneOfRow(page, row) });
  await expect(sequenceEditor(page)).toBeVisible();
  return sequenceEditor(page);
}

/** Back to the arrangement with `1`: the sequence view is a view (UI-002). */
async function closeEditor(page: Page): Promise<void> {
  await page.keyboard.press("1");
  await expect(sequenceEditor(page)).toHaveCount(0);
  await page.getByTestId("arrangement-view-ready").waitFor();
}

/** Types a new name over a track's own, from its header in the arrangement. */
async function renameTrack(page: Page, from: string, to: string): Promise<void> {
  await page
    .getByRole("button", { name: `Edit ${from}`, exact: true })
    .getByText(from, { exact: true })
    .click();
  const name = page.getByRole("textbox", { name: "Track name" });
  await name.fill(to);
  await name.press("Enter");
  await expect(
    page.getByRole("button", { name: `Edit ${to}`, exact: true }),
  ).toBeVisible();
}

// --- The step grid (CF-001) -----------------------------------------------

const padStep = (editor: Locator, pad: string, step: number, state: "on" | "off") =>
  editor.getByRole("button", { name: `${pad}, step ${step}, ${state}`, exact: true });

/** The steps of `pad`'s row that are on, read off the grid. */
async function padStepsOn(editor: Locator, pad: string): Promise<number[]> {
  const names = await editor
    .getByRole("button", { name: new RegExp(`^${pad}, step \\d+, on$`) })
    .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""));
  return names.map((name) => Number(name.match(/step (\d+)/)?.[1])).sort((a, b) => a - b);
}

async function expectPattern(
  editor: Locator,
  pattern: Readonly<Record<string, readonly number[]>>,
): Promise<void> {
  for (const [pad, steps] of Object.entries(pattern)) {
    await expect.poll(() => padStepsOn(editor, pad)).toEqual([...steps]);
  }
}

// --- The piano roll (CF-017) ----------------------------------------------

const pitchPattern = (pitch: string): string => pitch.replace("♯", "[♯#]");

const pitchRow = (editor: Locator, pitch: string): Locator =>
  editor
    .getByRole("group", { name: "Pitches" })
    .getByRole("button", { name: new RegExp(`^${pitchPattern(pitch)}(\\W*Off)?$`) });

const rulerStep = (editor: Locator, step: number): Locator =>
  editor
    .getByRole("group", { name: "Ruler" })
    .getByRole("button", { name: `Step ${step}`, exact: true });

async function box(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const found = await target.boundingBox();
  if (!found) throw new Error("expected a visible element to measure");
  return found;
}

async function clickCell(page: Page, editor: Locator, pitch: string, step: number) {
  const row = await box(pitchRow(editor, pitch));
  const column = await box(rulerStep(editor, step));
  await page.mouse.click(column.x + column.width / 2, row.y + row.height / 2);
}

async function noteNames(editor: Locator): Promise<string[]> {
  const names = await editor
    .getByRole("listbox", { name: "Notes" })
    .getByRole("option")
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute("aria-label") ?? el.textContent ?? ""),
    );
  return names.map((name) => name.replace(/#/g, "♯").replace(/\s+/g, " ").trim()).sort();
}

async function expectNotes(editor: Locator, expected: readonly string[]): Promise<void> {
  await expect.poll(() => noteNames(editor)).toEqual([...expected].sort());
}

async function writeNotes(page: Page, editor: Locator, notes: readonly string[]) {
  await expect(editor.getByRole("region", { name: /^Piano roll\b/ })).toBeVisible();
  for (const note of notes) {
    const [pitch, step] = note.split(", step ");
    await clickCell(page, editor, pitch, Number.parseInt(step, 10));
  }
  await expectNotes(editor, notes);
}

// --- The library (CF-005) -------------------------------------------------

/** The first listed loop stating a tempo other than the song's. */
async function loopAtAnotherTempo(page: Page, songTempo: number): Promise<string> {
  const rows = library(page).getByRole("list", { name: "Sounds", exact: true });
  await expect(rows.getByRole("listitem").first()).toBeVisible();
  const listed = await rows.getByRole("listitem").evaluateAll((items) =>
    items.map((item) => ({
      name: item.querySelector(".sound-row-name")?.textContent ?? "",
      text: item.textContent ?? "",
    })),
  );
  for (const { name, text } of listed) {
    const sourceTempo = Number(text.match(/(\d+)\s*BPM/)?.[1] ?? Number.NaN);
    if (Number.isFinite(sourceTempo) && sourceTempo !== songTempo) return name;
  }
  throw new Error(`No loop in the library states a tempo other than ${songTempo} BPM.`);
}

/**
 * Steps 1 to 7 of CF-021 and CF-022: builds the five-track song, with its
 * devices, and plays it once.
 */
export async function buildExportSong(
  page: Page,
  step: Step,
  canAssertPlayback: boolean,
): Promise<ExportSong> {
  // 1. Create a new project. It opens with the starter drum machine, its "BD"
  //    pad four on the floor. Add a drum-machine track named "Drums", and on
  //    it put the "HH" pad on every offbeat and the "CP" pad on beats 2 and 4.
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await page.getByRole("button", { name: "New Project" }).click();
  await expect(page).toHaveURL(/\/projects\/prj_/);
  const projectUrl = page.url();
  await page.getByTestId("arrangement-view-ready").waitFor();
  await expect(trackList(page)).toHaveText(["BD"]);
  const projectName = (
    (await page.getByRole("heading", { level: 1 }).textContent()) ?? ""
  ).trim();
  expect(projectName).not.toBe("");
  const tempo = Number(
    await page.getByRole("spinbutton", { name: "Tempo (BPM)" }).inputValue(),
  );
  expect(tempo).toBeGreaterThan(0);

  await expectPattern(await openClip(page, ROW.BD), KICK);
  await closeEditor(page);

  await page.getByRole("button", { name: "Add drum machine track" }).click();
  await expect(trackList(page)).toHaveText(["BD", "Drum machine"]);
  await renameTrack(page, "Drum machine", "Drums");
  await expect(trackList(page)).toHaveText(["BD", "Drums"]);
  const drums = await openClip(page, ROW.Drums);
  for (const pad of ["HH", "CP"] as const) {
    for (const on of DRUMS[pad]) {
      await padStep(drums, pad, on, "off").click();
      await expect(padStep(drums, pad, on, "on")).toBeVisible();
    }
  }
  await expectPattern(drums, DRUMS);
  await step(
    "Add a drum-machine track named Drums: hats on the offbeats, clap on 2 and 4",
  );
  await closeEditor(page);

  // 2. Add a synth track named "Bass" and write a bassline in the piano roll:
  //    C2 on steps 1 and 9, D♯2 on step 5, G2 on step 13.
  await page.getByRole("button", { name: "Add synth track" }).click();
  await expect(trackList(page)).toHaveText(["BD", "Drums", "Synth"]);
  await renameTrack(page, "Synth", "Bass");
  await expect(trackList(page)).toHaveText(["BD", "Drums", "Bass"]);
  const bass = await openClip(page, ROW.Bass);
  await writeNotes(page, bass, BASS_NOTES);
  await step("Add a synth track named Bass and write a bassline");
  await closeEditor(page);

  // 3. Add a loop from the library: a drum loop recorded at a different tempo
  //    from the project's. It lands on a new track as a clip starting at bar 1.
  await page.getByRole("button", { name: "Add loop from library" }).click();
  await expect(library(page)).toBeVisible();
  await librarySearch(page).fill("loop");
  const loopTrack = await loopAtAnotherTempo(page, tempo);
  await library(page)
    .getByRole("button", { name: `Audition ${loopTrack}`, exact: true })
    .click();
  // Enter inserts and goes back to the arrangement (UI-002).
  await page.keyboard.press("Enter");
  await expect(library(page)).toHaveCount(0);
  await expect(trackList(page)).toHaveText(["BD", "Drums", "Bass", loopTrack]);
  await timeline(page).click({ position: await barOneOfRow(page, ROW.loop) });
  await expect(selectedPlacements(page)).toHaveCount(1);
  // How long the loop's clip is decides where the song ends, which CF-021's
  // outcome measures the file against. The loop panel says so (INS-02).
  const loopEditor = await openClip(page, ROW.loop);
  const loopPanel = loopEditor.getByRole("region", { name: "Audio loop" });
  await expect(loopPanel).toContainText(loopTrack);
  const loopBars = Number(
    ((await loopPanel.textContent()) ?? "").match(/Length\s*([\d.]+)\s*bars?/)?.[1] ??
      Number.NaN,
  );
  expect(loopBars).toBeGreaterThan(0);
  await closeEditor(page);
  await step("Add a drum loop from the library at bar 1");

  // 4. Add a sampler track named "Piano" and load the "Tine Electric Key"
  //    one-shot from the library. In the piano roll write a C minor chord on step 1 (C3, D♯3 and
  //    G3 at once) and a single A♯3 on step 9, so the sample plays at four
  //    pitches and three at a time.
  //
  // The library searches every pack from any slot, so the sound is found by name.
  await page.getByRole("button", { name: "Add sampler track" }).click();
  await expect(trackList(page)).toHaveText(["BD", "Drums", "Bass", loopTrack, "Sampler"]);
  await renameTrack(page, "Sampler", "Piano");
  await viewLink(page, "Instrument").click();
  await railSelect(page, "Piano").click();
  await expect(railSelect(page, "Piano")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Sample", exact: true }).click();
  await expect(library(page)).toBeVisible();
  await librarySearch(page).fill(PIANO_SOUND);
  await library(page)
    .getByRole("button", { name: `Audition ${PIANO_SOUND}`, exact: true })
    .click();
  await page.keyboard.press("Enter");
  await expect(library(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sample", exact: true })).toContainText(
    PIANO_SOUND,
  );

  await viewLink(page, "Arrangement").click();
  await page.getByTestId("arrangement-view-ready").waitFor();
  const piano = await openClip(page, ROW.Piano);
  await writeNotes(page, piano, PIANO_NOTES);
  await step("Add a sampler track named Piano, load Tine Electric Key, write a chord");
  await closeEditor(page);

  // 5. Add a reverb to the Piano track's effects.
  await viewLink(page, "Instrument").click();
  await railSelect(page, "Piano").click();
  await expect(trackDevices(page)).toHaveCount(0);
  await page
    .getByRole("region", { name: "Device chain" })
    .getByRole("group", { name: "Add device" })
    .getByRole("button", { name: "Add reverb device" })
    .click();
  await expect(trackDevices(page)).toHaveText([/Reverb/]);
  await step("Add a reverb to the Piano track");

  // 6. Switch to the mixer and select the master strip. Add a saturator, then
  //    a compressor, to the master's effects.
  await viewLink(page, "Mixer").click();
  await mixer(page).getByRole("button", { name: "Master" }).click();
  await expect(masterView(page)).toBeVisible();
  const addToMaster = masterView(page).getByRole("group", { name: "Add device" });
  await addToMaster.getByRole("button", { name: "Add saturator device" }).click();
  await addToMaster.getByRole("button", { name: "Add compressor device" }).click();
  // A new project's master starts with its Limiter (#937); the two land before
  // it, so the Limiter stays last and still limits everything on the master.
  await expect(masterDevices(page)).toHaveText([/Saturator/, /Compressor/, /Limiter/]);
  await step("Add a saturator, then a compressor, to the master");

  // 7. There are now five tracks, each with a clip in bar 1. Play the song,
  //    then stop.
  await viewLink(page, "Arrangement").click();
  await page.getByTestId("arrangement-view-ready").waitFor();
  await expect(trackList(page)).toHaveText(tracksInOrder(loopTrack));
  for (let row = 0; row < 5; row += 1) {
    await timeline(page).click({ position: await barOneOfRow(page, row) });
    await expect(selectedPlacements(page)).toHaveCount(1);
  }
  await page.getByRole("button", { name: "Start playback" }).click();
  if (canAssertPlayback) {
    await expect(page.getByRole("button", { name: "Stop playback" })).toBeVisible();
    await page.getByRole("button", { name: "Stop playback" }).click();
  } else {
    // Playback is not asserted here, but it may have started: WebKit plays
    // (the button flips to "Stop playback") while Firefox's resume never
    // settles. Stop it if it did, so the song is idle either way.
    await page
      .getByRole("button", { name: "Stop playback" })
      .click({ timeout: 3_000 })
      .catch(() => undefined);
  }
  await expect(page.getByRole("button", { name: "Start playback" })).toBeVisible();
  await step("Five tracks, each with a clip in bar 1 — play, then stop");

  return { projectUrl, projectName, tempo, loopTrack, loopBars };
}

/**
 * Reloads the page and asserts the song is exactly as steps 1 to 7 left it:
 * the same five tracks, the same clips and notes, the reverb on Piano, and the
 * saturator then the compressor on the master. Exporting must not edit it.
 */
export async function reloadAndExpectSongUnchanged(
  page: Page,
  song: ExportSong,
): Promise<void> {
  // The save status is how the editor reports a revision-checked write has
  // completed, so the reload tests persistence rather than a race (CF-016).
  await expect(page.locator(".save-status")).toHaveText("Saved", { timeout: 10_000 });
  await reloadPage(page);
  await expect(page).toHaveURL(song.projectUrl);
  await page.getByTestId("arrangement-view-ready").waitFor();
  await expect(trackList(page)).toHaveText(tracksInOrder(song.loopTrack));

  await expectPattern(await openClip(page, ROW.BD), KICK);
  await closeEditor(page);
  await expectPattern(await openClip(page, ROW.Drums), DRUMS);
  await closeEditor(page);
  await expectNotes(await openClip(page, ROW.Bass), BASS_NOTES);
  await closeEditor(page);
  await expect(
    (await openClip(page, ROW.loop)).getByRole("region", { name: "Audio loop" }),
  ).toContainText(song.loopTrack);
  await closeEditor(page);
  await expectNotes(await openClip(page, ROW.Piano), PIANO_NOTES);
  await closeEditor(page);

  await viewLink(page, "Instrument").click();
  await railSelect(page, "Piano").click();
  await expect(page.getByRole("button", { name: "Sample", exact: true })).toContainText(
    PIANO_SOUND,
  );
  await expect(trackDevices(page)).toHaveText([/Reverb/]);

  await viewLink(page, "Mixer").click();
  await mixer(page).getByRole("button", { name: "Master" }).click();
  await expect(masterDevices(page)).toHaveText([/Saturator/, /Compressor/, /Limiter/]);
}

/** The song's length from bar 1 to the end of its last clip, in seconds. */
export function songSeconds(song: ExportSong): number {
  // Every clip but the loop is the one bar a new track opens with.
  const bars = Math.max(1, song.loopBars);
  return (bars * 4 * 60) / song.tempo;
}
