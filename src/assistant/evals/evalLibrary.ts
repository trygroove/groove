/**
 * The library an eval turn carries when its case asks for one (GRV-129), so
 * the model is offered `recommend_sounds` as it is in the editor, and where
 * it aims each recommendation can be judged (`recommendationTargets`).
 *
 * A fixed, hand-kept stand-in for what the editor sends
 * (`libraryContext`, `src/editor/assistant/assistantLibrary.ts`): the drum
 * pack the starter project's kick comes from, by its real ID and name, with a
 * few of each drum part, and a bass pack the project does not use. Its
 * sounds' names and tags are stand-ins; what matters to the model is that it
 * has a kick, a snare and a hat to choose from, by ID.
 */
import type { AssistantLibraryContext, AssistantLibrarySound } from "../protocol";

/** The starter kick's own pack, Core Electronic Drums. */
export const EVAL_DRUM_PACK_ID = "pak_SdlN_OazweXrwury0j27Y";

function oneShot(
  id: string,
  name: string,
  role: string,
  tags: readonly string[],
  inProject = false,
): AssistantLibrarySound {
  return { id, name, role, type: "one-shot", tags: [...tags], inProject };
}

const DRUM_SOUNDS: readonly AssistantLibrarySound[] = [
  oneShot("sg-one-shot-drums-kick-0001", "Rounded Club Kick", "kick", ["house"], true),
  oneShot("sg-one-shot-drums-kick-0002", "Tight House Kick", "kick", ["house", "dry"]),
  oneShot("sg-one-shot-drums-kick-0004", "Soft Rounded Kick", "kick", ["lofi", "warm"]),
  oneShot("sg-one-shot-drums-snare-0001", "Tight Studio Snare", "snare", ["dry"]),
  oneShot("sg-one-shot-drums-snare-0002", "Crack Snare", "snare", ["bright", "techno"]),
  oneShot("sg-one-shot-drums-clap-0001", "Classic House Clap", "clap", ["house"]),
  oneShot("sg-one-shot-drums-closed-hat-0001", "Closed Hat", "closed-hat", ["tight"]),
  oneShot("sg-one-shot-drums-closed-hat-0002", "Ticky Hat", "closed-hat", ["techno"]),
  oneShot("sg-one-shot-drums-open-hat-0001", "Open Hat", "open-hat", ["house"]),
];

const BASS_SOUNDS: readonly AssistantLibrarySound[] = [
  oneShot("sg-one-shot-bass-sub-0001", "Round Sub", "bass", ["sub"]),
  oneShot("sg-one-shot-bass-sub-0002", "Gritty Sub", "bass", ["sub", "gritty"]),
];

/** The library a case that asks for one is sent with. */
export function evalLibrary(): AssistantLibraryContext {
  return {
    packs: [
      {
        id: EVAL_DRUM_PACK_ID,
        name: "Core Electronic Drums",
        publisher: "Groove",
        version: "1.1.0",
        description:
          "The role-complete, lightly processed drum foundation: kicks, snares, claps, closed and open hats.",
        soundCount: DRUM_SOUNDS.length,
        inProject: true,
        sounds: [...DRUM_SOUNDS],
      },
      {
        id: "pak_FH8gyASzYiWGCrtpKZ-Ho",
        name: "Core Bass",
        publisher: "Groove",
        version: "1.0.0",
        description: "Subs and plucked basses.",
        soundCount: BASS_SOUNDS.length,
        inProject: false,
        sounds: [...BASS_SOUNDS],
      },
    ],
  };
}

/** The drum part a sound plays, by its library role, or null for any other. */
export function drumPartOf(role: string): "kick" | "snare" | "hat" | null {
  if (role === "kick") return "kick";
  if (role === "snare" || role === "clap") return "snare";
  if (/hat$/.test(role)) return "hat";
  return null;
}
