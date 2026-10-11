/**
 * A small library, as an assistant turn carries it (GRV-23), for tests of the
 * recommendation tool, its validation and the emulator's script. Two packs: a
 * drum pack the project uses, with kicks of every kind of dustiness, and an FX
 * pack it does not.
 */
import type {
  AssistantLibraryContext,
  AssistantLibraryPack,
  AssistantLibrarySound,
} from "../assistant/protocol";

export const DRUM_PACK_ID = "pak_drums00000000000000";
export const FX_PACK_ID = "pak_fx000000000000000000";

function sound(
  id: string,
  name: string,
  role: string,
  tags: readonly string[],
  overrides: Partial<AssistantLibrarySound> = {},
): AssistantLibrarySound {
  return {
    id,
    name,
    role,
    type: "one-shot",
    tags: [...tags],
    inProject: false,
    ...overrides,
  };
}

const DRUMS: AssistantLibraryPack = {
  id: DRUM_PACK_ID,
  name: "Core Drums",
  publisher: "Groove",
  version: "1.1.0",
  description: "Kicks, snares and hats.",
  soundCount: 5,
  inProject: true,
  sounds: [
    sound("kick-clean", "Clean Club Kick", "kick", ["house", "clean"], {
      inProject: true,
    }),
    sound("kick-tight", "Tight Kick", "kick", ["house", "dry"]),
    sound("kick-warm", "Warm Kick", "kick", ["lofi", "warm"]),
    sound("kick-dusty", "Dusty Kick", "kick", ["lofi", "gritty", "warm"]),
    sound("snare-dusty", "Dusty Snare", "snare", ["lofi", "gritty"]),
  ],
};

const FX: AssistantLibraryPack = {
  id: FX_PACK_ID,
  name: "Transitions",
  publisher: "Groove",
  version: "1.0.0",
  description: "Risers and impacts.",
  soundCount: 2,
  inProject: false,
  sounds: [
    sound("fx-impact", "Big Impact", "impact", ["cinematic"]),
    sound("fx-riser", "Long Riser", "riser", ["cinematic"], { type: "loop" }),
  ],
};

/** The test library: the drum pack, then the FX pack. */
export function buildAssistantLibrary(): AssistantLibraryContext {
  return { packs: [structuredClone(DRUMS), structuredClone(FX)] };
}
