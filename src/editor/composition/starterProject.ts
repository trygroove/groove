import type { Project, Song } from "../../domain/entities";
import {
  createDrumMachineInstrument,
  createDrumPad,
  createEmptySong,
  createFactoryContext,
  createNewProjectMaster,
  createNoteClip,
  createNoteEvent,
  createPlacement,
  createProjectMetadata,
  createTrack,
} from "../../domain/factories";
import { derivePackDependencies } from "../../domain/packs";
import { assertProject } from "../../domain/parse";
import { TICKS_PER_BAR, TICKS_PER_SIXTEENTH } from "../../domain/time";
import { createFactoryAsset } from "../../library/factoryLibrary";
import { STEPS_PER_BAR } from "../sequence/stepEditorModel";
import { PRESETS, type Preset, presetHits } from "../sequence/stepGenerators";
import { generateProjectName, type RandomSource } from "./projectName";

function fourOnTheFloor(): Preset {
  const preset = PRESETS.find((candidate) => candidate.id === "four_on_the_floor");
  if (!preset) throw new Error("The four_on_the_floor preset is missing");
  return preset;
}

/**
 * Builds a fresh `FND-009` starter project: one drum-machine track ("BD") with
 * a single "BD" pad whose kick resolves through a real factory pack from the
 * generated library manifest (`src/library/factoryLibrary.ts`), and a one-bar
 * four-on-the-floor clip of pad hits placed once (#496: a drum machine is the
 * one-shot player, a sampler the tonal instrument) — the same shape `src/domain/fixtures.ts`'s
 * `createSliceFixtureProject` pins for tests, but with real (non-seeded) IDs
 * and the current time, for "New Project" to hand to the repository. The
 * project is named by `generateProjectName` ("Mood Energy"), not "Untitled".
 * Its master carries a Limiter in place of the hidden safety limiter (#937).
 *
 * This is deliberately the smallest project the `FND-009` 16-step slice needs
 * to be playable immediately, not the richer dashboard creation flow
 * (blank/template/duplicate, genre, etc.) — that is `LOOP-001`'s scope.
 */
export function createStarterProject(
  ownerId: string,
  random: RandomSource = Math.random,
): Project {
  const context = createFactoryContext();

  // `CNT-001`: the sound, its pack, its delivery path, and its audio metadata
  // all come from the generated manifest. Nothing here restates them, so the
  // starter cannot drift from the library it resolves against.
  const asset = createFactoryAsset(context, "starterKick");

  const kickPad = createDrumPad(context, { name: "BD", assetId: asset.id });
  const track = createTrack(context, {
    name: "BD",
    order: 0,
    instrument: createDrumMachineInstrument([kickPad]),
  });

  const clip = createNoteClip(context, {
    trackId: track.id,
    name: "Four on the floor",
    lengthTicks: TICKS_PER_BAR,
    // The Generate panel's own preset, so pressing Four on the floor on this
    // row finds it already there and writes nothing (GRV-154).
    events: presetHits(fourOnTheFloor(), STEPS_PER_BAR).map((hit) =>
      createNoteEvent(context, {
        startTicks: hit.step * TICKS_PER_SIXTEENTH,
        durationTicks: TICKS_PER_SIXTEENTH,
        velocity: hit.velocity,
        padId: kickPad.id,
      }),
    ),
  });

  const placement = createPlacement(context, {
    clipId: clip.id,
    trackId: track.id,
    startTicks: 0,
    durationTicks: TICKS_PER_BAR,
  });

  const song: Song = {
    ...createEmptySong(120),
    // A visible Limiter on the master, not the hidden safety limiter (#937).
    master: createNewProjectMaster(context),
    tracks: [track],
    placements: [placement],
    assets: [asset],
  };

  return assertProject({
    metadata: createProjectMetadata(context, {
      ownerId,
      name: generateProjectName(random),
      template: "starter",
      packDependencies: derivePackDependencies(song),
    }),
    song,
    clips: [clip],
  });
}
