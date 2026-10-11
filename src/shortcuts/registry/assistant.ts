// The assistant panel's shortcuts (#849, GRV-26, GRV-42): summoning it,
// resizing it from its focused edge, sending from its composer, and answering
// a question it asks. Part of the one shortcut registry: see `../registry.ts`.

import type { AbletonParity } from "../types";
import { define, type ShortcutDefinition } from "./define";

/** The assistant panel's shortcut actions. */
export const ASSISTANT_SHORTCUT_IDS = [
  "assistant.toggle",
  "assistant.grow",
  "assistant.shrink",
  "assistant.grow_more",
  "assistant.shrink_more",
  "assistant.send",
  "assistant.ask_option_1",
  "assistant.ask_option_2",
  "assistant.ask_option_3",
  "assistant.ask_option_4",
  "assistant.ask_option_5",
  "assistant.ask_option_6",
  "assistant.ask_option_7",
  "assistant.ask_option_8",
  "assistant.ask_finish",
  "assistant.ask_hear",
] as const;

/** The `1`-`8` mappings, in option order: `ASK_OPTION_SHORTCUT_IDS[0]` picks the first. */
export const ASK_OPTION_SHORTCUT_IDS = [
  "assistant.ask_option_1",
  "assistant.ask_option_2",
  "assistant.ask_option_3",
  "assistant.ask_option_4",
  "assistant.ask_option_5",
  "assistant.ask_option_6",
  "assistant.ask_option_7",
  "assistant.ask_option_8",
] as const satisfies readonly (typeof ASSISTANT_SHORTCUT_IDS)[number][];

const ASK_PARITY: AbletonParity = {
  kind: "solid_groove",
  reason:
    "Live has no assistant; number keys pick an answer, as an agent harness's options do.",
};

/**
 * A question the assistant asks (GRV-42), while focus is in the panel and not
 * in a text box: `1`-`8` pick its options, as the chips number them, and
 * Enter sends a multi-select's picks.
 */
const ASK_OPTION_KEYS: readonly ShortcutDefinition[] = ASK_OPTION_SHORTCUT_IDS.map(
  (id, index) =>
    define({
      id,
      label: `Pick answer ${index + 1}`,
      description: `Picks the assistant's question's option ${index + 1}: it answers a single choice, and toggles one of several.`,
      group: "navigation",
      contexts: ["assistant_ask"],
      keys: String(index + 1),
      ableton: ASK_PARITY,
    }),
);

const RESIZE_EDGE_PARITY: AbletonParity = {
  kind: "solid_groove",
  reason:
    "Live has no assistant panel; the arrows move a focused separator, as the ARIA separator pattern does.",
};

/**
 * The assistant panel's focused resize edge (#849): the top edge while it
 * floats, the left edge while it is docked. Each action takes the arrow for
 * either orientation, so "grow" is the same action on both edges.
 */
function resizeKey(
  id: (typeof ASSISTANT_SHORTCUT_IDS)[number],
  label: string,
  description: string,
  keys: readonly string[],
): ShortcutDefinition {
  return define({
    id,
    label,
    description,
    keys,
    group: "navigation",
    contexts: ["resize_edge"],
    repeatable: true,
    ableton: RESIZE_EDGE_PARITY,
  });
}

const ASSISTANT_RESIZE_KEYS: readonly ShortcutDefinition[] = [
  resizeKey(
    "assistant.grow",
    "Grow the assistant",
    "Moves the focused resize edge out 16px: taller while it floats, wider while it is docked.",
    ["ArrowUp", "ArrowLeft"],
  ),
  resizeKey(
    "assistant.shrink",
    "Shrink the assistant",
    "Moves the focused resize edge in 16px: shorter while it floats, narrower while it is docked.",
    ["ArrowDown", "ArrowRight"],
  ),
  resizeKey(
    "assistant.grow_more",
    "Grow the assistant more",
    "Moves the focused resize edge out 64px.",
    ["Shift+ArrowUp", "Shift+ArrowLeft"],
  ),
  resizeKey(
    "assistant.shrink_more",
    "Shrink the assistant more",
    "Moves the focused resize edge in 64px.",
    ["Shift+ArrowDown", "Shift+ArrowRight"],
  ),
];

export const ASSISTANT_SHORTCUTS: readonly ShortcutDefinition[] = [
  define({
    id: "assistant.toggle",
    label: "Open or close the assistant",
    description: "Opens the assistant where you left it, or closes it.",
    group: "navigation",
    contexts: ["editor"],
    keys: "Mod+K",
    // A chord types nothing, so it works from a focused field too, including
    // the assistant's own composer.
    textEntry: "allowed",
    ableton: {
      kind: "solid_groove",
      reason:
        "Live has no assistant; Cmd/Ctrl+K is the web's convention for summoning one.",
    },
    browserConflict: {
      keys: "Cmd/Ctrl+K",
      note: "Ctrl+K focuses the browser's search box in Chrome and Firefox on Windows and Linux. Groove cancels the default while the editor is open.",
    },
  }),
  ...ASSISTANT_RESIZE_KEYS,
  define({
    id: "assistant.send",
    label: "Send the message",
    description:
      "Sends what is in the assistant's composer. Shift+Enter adds a line instead.",
    group: "navigation",
    contexts: ["composer"],
    keys: "Enter",
    // The composer is text entry, and Enter is what sends from it.
    textEntry: "allowed",
    ableton: {
      kind: "solid_groove",
      reason: "Live has no assistant; Enter sends, as it does in any chat composer.",
    },
  }),
  ...ASK_OPTION_KEYS,
  define({
    id: "assistant.ask_finish",
    label: "Send the answers",
    description:
      "Sends the options picked in the assistant's question when it takes several.",
    group: "navigation",
    contexts: ["assistant_ask"],
    keys: "Enter",
    // The chips are toggles: Space presses one, and Enter sends the picks.
    focusedControl: "allowed",
    ableton: ASK_PARITY,
  }),
  define({
    id: "assistant.ask_hear",
    label: "Hear the answer",
    description:
      "Plays the focused option's sound, when the assistant's question has one. With focus elsewhere in the panel, Space plays and stops the song as usual.",
    group: "navigation",
    contexts: ["assistant_ask"],
    keys: "Space",
    // A chip with a sound takes Space to play it; one without keeps it, so
    // Space presses it, as it does any button.
    focusedControl: "allowed",
    ableton: ASK_PARITY,
  }),
];
