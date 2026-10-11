import { describe, expect, it } from "vitest";
import { type ChordEvent, matchesChord, parseChord, type ShortcutPlatform } from "./keys";
import {
  chordsFor,
  matchShortcut,
  preferFocused,
  RESERVED_CHORDS,
  resolveContexts,
  SHORTCUT_ACTION_IDS,
  SHORTCUTS,
  shortcutById,
  shortcutLabel,
  shortcutSections,
  shortcutsInContext,
} from "./registry";
import type { ShortcutContext } from "./types";
import {
  FOCUS_CONTEXTS,
  MODAL_OWNED_CONTEXTS,
  SHORTCUT_CONTEXTS,
  SHORTCUT_GROUPS,
} from "./types";

const PLATFORMS: readonly ShortcutPlatform[] = ["mac", "other"];

/** The event a chord would produce on the given platform. */
function chordEvent(
  chord: {
    key: string;
    mod: boolean;
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
  },
  platform: ShortcutPlatform,
): ChordEvent {
  return {
    key: chord.key,
    metaKey: platform === "mac" ? chord.mod : false,
    ctrlKey: platform === "mac" ? chord.ctrl : chord.mod,
    altKey: chord.alt,
    shiftKey: chord.shift,
  };
}

describe("registry shape", () => {
  it("has exactly one definition per pinned action ID", () => {
    expect(SHORTCUTS.map((shortcut) => shortcut.id).sort()).toEqual(
      [...SHORTCUT_ACTION_IDS].sort(),
    );
  });

  it("gives every entry keys, a group, a context, and an Ableton position", () => {
    for (const shortcut of SHORTCUTS) {
      expect(shortcut.keys.mac.length).toBeGreaterThan(0);
      expect(shortcut.keys.other.length).toBeGreaterThan(0);
      expect(SHORTCUT_GROUPS).toContain(shortcut.group);
      expect(shortcut.contexts.length).toBeGreaterThan(0);
      for (const context of shortcut.contexts) {
        expect(SHORTCUT_CONTEXTS).toContain(context);
      }
      if (shortcut.ableton.kind === "differs") {
        // A deviation is only documented if it says what it deviates from.
        expect(shortcut.ableton.abletonKeys.length).toBeGreaterThan(0);
        expect(shortcut.ableton.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it("parses every declared key on both platforms", () => {
    for (const shortcut of SHORTCUTS) {
      for (const platform of PLATFORMS) {
        expect(chordsFor(shortcut, platform).length).toBeGreaterThan(0);
      }
    }
  });

  it("encodes the PRD KEY-01 mapping table", () => {
    expect(shortcutLabel("transport.play_stop", "mac")).toBe("Space");
    expect(shortcutLabel("transport.continue", "other")).toBe("Shift+Space");
    expect(shortcutLabel("edit.undo", "mac")).toBe("Cmd+Z");
    expect(shortcutLabel("edit.undo", "other")).toBe("Ctrl+Z");
    expect(shortcutLabel("edit.redo", "mac")).toBe("Cmd+Shift+Z");
    expect(shortcutLabel("edit.redo", "other")).toBe("Ctrl+Y");
    expect(shortcutLabel("edit.duplicate", "other")).toBe("Ctrl+D");
    expect(shortcutLabel("arrangement.split_clip", "mac")).toBe("E");
    expect(shortcutLabel("clip.quantize", "mac")).toBe("Q");
    expect(shortcutLabel("arrangement.toggle_loop", "mac")).toBe("L");
    expect(shortcutLabel("clip.toggle_draw_mode", "mac")).toBe("B");
    expect(shortcutLabel("arrangement.toggle_automation_view", "mac")).toBe("A");
    expect(shortcutLabel("view.zoom_to_selection", "mac")).toBe("Z");
    expect(shortcutLabel("view.zoom_back", "mac")).toBe("X");
    expect(shortcutLabel("view.zoom_in", "mac")).toBe("+");
    expect(shortcutLabel("view.zoom_out", "mac")).toBe("-");
    expect(shortcutLabel("transport.metronome", "mac")).toBe("O");
    expect(shortcutLabel("transport.toggle_loop", "mac")).toBe("Shift+L");
    expect(shortcutLabel("transport.toggle_loop", "other")).toBe("Shift+L");
    expect(shortcutLabel("view.close_surface", "mac")).toBe("Escape");
    expect(shortcutLabel("help.shortcut_guide", "mac")).toBe("?");
  });

  it("records the browser-safe deviations from Live as deviations", () => {
    for (const id of [
      "arrangement.split_clip",
      "arrangement.toggle_loop",
      "clip.quantize",
    ] as const) {
      expect(shortcutById(id).ableton.kind).toBe("differs");
    }
    expect(shortcutById("transport.play_stop").ableton.kind).toBe("follows");
    expect(shortcutById("help.shortcut_guide").ableton.kind).toBe("solid_groove");
  });

  it("puts the five views on 1-5, in the order of the drill-down (UI-002)", () => {
    const views = ["arrangement", "sequence", "instrument", "library", "mixer"] as const;
    for (const [index, view] of views.entries()) {
      expect(shortcutLabel(`view.show_${view}`, "other")).toBe(String(index + 1));
    }
  });

  it("opens a clip on Enter, inserts and goes back on Enter, and stays on Shift+Enter (UI-002)", () => {
    expect(shortcutLabel("arrangement.open_clip", "other")).toBe("Enter");
    expect(shortcutById("arrangement.open_clip").contexts).toEqual(["arrangement"]);
    expect(shortcutLabel("library.insert_and_return", "mac")).toBe("Enter");
    expect(shortcutLabel("library.insert", "mac")).toBe("Shift+Enter");
    expect(shortcutById("library.insert_and_return").contexts).toEqual(["library"]);
  });
});

describe("conflict rules", () => {
  it("claims no browser- or OS-reserved combination", () => {
    for (const platform of PLATFORMS) {
      const reserved = RESERVED_CHORDS.map((spec) => parseChord(spec, platform));
      for (const shortcut of SHORTCUTS) {
        for (const chord of chordsFor(shortcut, platform)) {
          const clash = reserved.find((other) =>
            matchesChord(other, chordEvent(chord, platform), platform),
          );
          expect(
            clash,
            `${shortcut.id} claims reserved ${JSON.stringify(chord)}`,
          ).toBeUndefined();
        }
      }
    }
  });

  it("documents every cancellable browser combination it does take over", () => {
    // Cmd/Ctrl+D bookmarks the page. The PRD mapping wins, but only with the
    // override written down.
    expect(shortcutById("edit.duplicate").browserConflict?.note).toMatch(/bookmark/i);
    // Ctrl+K focuses the browser's search box on Windows and Linux (#849).
    expect(shortcutById("assistant.toggle").browserConflict?.note).toMatch(/search box/i);
  });

  /** Every shortcut another one in the same active set would also match. */
  function ambiguousIn(
    active: readonly ShortcutContext[],
    platform: ShortcutPlatform,
  ): string[] {
    const eligible = shortcutsInContext(active);
    const clashes: string[] = [];
    for (const shortcut of eligible) {
      for (const chord of chordsFor(shortcut, platform)) {
        const matches = eligible.filter((other) =>
          chordsFor(other, platform).some((otherChord) =>
            matchesChord(otherChord, chordEvent(chord, platform), platform),
          ),
        );
        // A focus context outranks the ambient ones for its own keys.
        if (preferFocused(matches, resolveContexts(active)).length > 1) {
          clashes.push(matches.map((match) => match.id).join(" vs "));
        }
      }
    }
    return clashes;
  }

  it("never lets two shortcuts match the same event in one context", () => {
    for (const platform of PLATFORMS) {
      for (const context of SHORTCUT_CONTEXTS) {
        expect(
          ambiguousIn([context], platform),
          `ambiguous in ${context} on ${platform}`,
        ).toEqual([]);
      }
    }
  });

  // A real surface activates a *set* of contexts, not one: `EditorView` runs
  // `["editor", "step_editor"]`. Checking single contexts would let two
  // mappings that are individually unambiguous collide once both their
  // surfaces are on screen together, so every pair is checked too.
  it("never lets two shortcuts match the same event in any pair of contexts", () => {
    for (const platform of PLATFORMS) {
      for (const first of SHORTCUT_CONTEXTS) {
        for (const second of SHORTCUT_CONTEXTS) {
          if (first === second) continue;
          // `library` is only ever active beside `dialog` (see the live sets
          // below), so a pair that pairs it with anything else is not a screen.
          if (MODAL_OWNED_CONTEXTS.some((c) => c === first || c === second)) continue;
          // One element has focus, so two focus contexts are never live together.
          if (FOCUS_CONTEXTS.includes(first) && FOCUS_CONTEXTS.includes(second)) continue;
          expect(
            ambiguousIn([first, second], platform),
            `ambiguous in ${first}+${second} on ${platform}`,
          ).toEqual([]);
        }
      }
    }
  });

  // The context sets surfaces actually activate today. Pairs cover these, but
  // naming them keeps the guarantee attached to real screens as sets grow past
  // two contexts.
  it("never lets two shortcuts match the same event in a live surface's context set", () => {
    const LIVE_CONTEXT_SETS: readonly (readonly ShortcutContext[])[] = [
      ["editor", "step_editor"],
      ["editor", "step_editor", "selection"],
      ["editor", "arrangement", "timeline", "selection"],
      ["editor", "piano_roll", "timeline", "selection"],
      ["editor", "step_editor", "piano_roll", "selection", "sequence_editor"],
      ["editor", "value_field", "sequence_editor"],
      ["editor", "automation_lane", "timeline", "selection"],
      ["dialog"],
      ["dialog", "library"],
      ["library"],
      ["dialog", "export_tracks"],
      ["editor", "gesture"],
      ["editor", "step_editor", "resize_edge"],
      [
        "editor",
        "step_editor",
        "piano_roll",
        "selection",
        "sequence_editor",
        "resize_edge",
      ],
    ];
    for (const platform of PLATFORMS) {
      for (const active of LIVE_CONTEXT_SETS) {
        expect(
          ambiguousIn(active, platform),
          `ambiguous in ${active.join("+")} on ${platform}`,
        ).toEqual([]);
      }
    }
  });
});

describe("context resolution", () => {
  it("always includes global", () => {
    expect(resolveContexts([])).toEqual(["global"]);
    expect(resolveContexts(["editor"])).toEqual(["global", "editor"]);
  });

  it("suppresses every other context while a dialog is active", () => {
    expect(resolveContexts(["dialog", "editor"])).toEqual(["dialog"]);
    const inDialog = shortcutsInContext(["dialog", "editor", "selection"]);
    expect(inDialog.map((shortcut) => shortcut.id)).toEqual(["view.close_surface"]);
  });

  it("keeps the export list's keys firing inside the dialog, and only there", () => {
    const key = (k: string, extra: Partial<ChordEvent> = {}) =>
      ({
        key: k,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        ...extra,
      }) as ChordEvent;
    const within: readonly ShortcutContext[] = ["dialog", "export_tracks", "editor"];
    const id = (event: ChordEvent, active = within) =>
      matchShortcut(event, "other", active)?.id;
    expect(id(key("ArrowUp"))).toBe("export.focus_previous");
    expect(id(key("ArrowDown"))).toBe("export.focus_next");
    expect(id(key("ArrowUp", { shiftKey: true }))).toBe("export.extend_previous");
    expect(id(key("ArrowDown", { shiftKey: true }))).toBe("export.extend_next");
    expect(id(key(" "))).toBe("export.toggle_focused");
    expect(id(key("Enter"))).toBe("export.toggle_focused");
    expect(id(key("a", { ctrlKey: true }))).toBe("export.pick_all");
    // Escape is still the dialog's own close, not the list's.
    expect(id(key("Escape"))).toBe("view.close_surface");
    // With the list unfocused the dialog claims none of them, and the editor behind
    // it stays suppressed (Space is not play/stop, Mod+A is not select all).
    expect(id(key(" "), ["dialog", "editor"])).toBeUndefined();
    expect(
      id(key("a", { ctrlKey: true }), ["dialog", "editor", "selection"]),
    ).toBeUndefined();
    // Outside a dialog the context is inert for the editor's own keys.
    expect(id(key(" "), ["editor"])).toBe("transport.play_stop");
  });

  it("keeps library beside dialog, and only there", () => {
    expect(resolveContexts(["dialog", "library", "editor"])).toEqual([
      "dialog",
      "library",
    ]);
    // Without the library open, a plain dialog is unchanged.
    expect(resolveContexts(["dialog", "editor"])).toEqual(["dialog"]);
    const inLibrary = shortcutsInContext(["dialog", "library", "editor"]).map(
      (s) => s.id,
    );
    expect(inLibrary).toContain("library.insert");
    expect(inLibrary).toContain("view.close_surface");
    expect(inLibrary).toContain("help.shortcut_guide");
    expect(inLibrary).not.toContain("transport.play_stop");
    const inEditor = shortcutsInContext(["editor"]).map((s) => s.id);
    expect(inEditor.some((id) => id.startsWith("library."))).toBe(false);
  });

  it("has at least one shortcut registered in every declared context", () => {
    for (const context of SHORTCUT_CONTEXTS) {
      const registered = SHORTCUTS.filter((shortcut) =>
        shortcut.contexts.includes(context),
      );
      expect(registered.length, `no shortcut in ${context}`).toBeGreaterThan(0);
    }
  });

  it("dispatches the right action in every declared context", () => {
    const expected: Record<ShortcutContext, { key: string; mod?: boolean; id: string }> =
      {
        global: { key: "z", mod: true, id: "edit.undo" },
        editor: { key: " ", id: "transport.play_stop" },
        arrangement: { key: "e", id: "arrangement.split_clip" },
        step_editor: { key: "q", id: "clip.quantize" },
        piano_roll: { key: "q", id: "clip.quantize" },
        automation_lane: { key: "b", id: "clip.toggle_draw_mode" },
        timeline: { key: "+", id: "view.zoom_in" },
        selection: { key: "x", mod: true, id: "edit.cut" },
        sequence_editor: { key: "1", id: "view.show_arrangement" },
        dialog: { key: "escape", id: "view.close_surface" },
        library: { key: "s", id: "library.similar" },
        gesture: { key: "escape", id: "view.close_surface" },
        loop_brace: { key: "arrowleft", id: "arrangement.loop_move_earlier" },
        clip_list: { key: "arrowdown", id: "arrangement.clip_next" },
        value_field: { key: "arrowup", id: "value.nudge_up" },
        export_tracks: { key: "arrowup", id: "export.focus_previous" },
        resize_edge: { key: "arrowup", id: "assistant.grow" },
        composer: { key: "enter", id: "assistant.send" },
        assistant_ask: { key: "1", id: "assistant.ask_option_1" },
      };
    for (const context of SHORTCUT_CONTEXTS) {
      const probe = expected[context];
      const match = matchShortcut(
        {
          key: probe.key,
          metaKey: false,
          ctrlKey: probe.mod === true,
          altKey: false,
          shiftKey: false,
        },
        "other",
        [context],
      );
      expect(match?.id, `no dispatch in ${context}`).toBe(probe.id);
    }
  });

  it("does not fire an arrangement shortcut from the step editor", () => {
    expect(
      matchShortcut(
        {
          key: "e",
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
        "other",
        ["step_editor"],
      ),
    ).toBeUndefined();
  });
});

describe("guide sections", () => {
  it("groups in PRD KEY-02 order and drops groups with no shortcuts yet", () => {
    const sections = shortcutSections();
    expect(sections.map((section) => section.group)).toEqual([
      "transport",
      "global_editing",
      "arrangement",
      "clips_notes",
      "automation",
      "mixer_devices",
      "browser",
      "navigation",
    ]);
    expect(sections.every((section) => section.shortcuts.length > 0)).toBe(true);
  });

  it("puts every shortcut into exactly one section", () => {
    const grouped = shortcutSections().flatMap((section) => section.shortcuts);
    expect(grouped).toHaveLength(SHORTCUTS.length);
  });

  describe("the focused clip list's keys (#76)", () => {
    const arrow = (key: string) =>
      ({
        key,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
      }) as ChordEvent;

    it("step through the clips in place of the track the arrows select elsewhere", () => {
      expect(matchShortcut(arrow("ArrowDown"), "other", ["editor"])?.id).toBe(
        "track.select_next",
      );
      const active: readonly ShortcutContext[] = ["editor", "arrangement", "clip_list"];
      expect(matchShortcut(arrow("ArrowDown"), "other", active)?.id).toBe(
        "arrangement.clip_next",
      );
      expect(matchShortcut(arrow("ArrowUp"), "mac", active)?.id).toBe(
        "arrangement.clip_previous",
      );
    });

    it("extend the selection with Shift+Up/Down and resize with (Alt+)Shift+Left/Right", () => {
      const active: readonly ShortcutContext[] = ["editor", "arrangement", "clip_list"];
      const shifted = (key: string) => ({ ...arrow(key), shiftKey: true }) as ChordEvent;
      expect(matchShortcut(shifted("ArrowDown"), "other", active)?.id).toBe(
        "arrangement.clip_extend_next",
      );
      expect(matchShortcut(shifted("ArrowUp"), "mac", active)?.id).toBe(
        "arrangement.clip_extend_previous",
      );
      expect(matchShortcut(shifted("ArrowLeft"), "other", active)?.id).toBe(
        "arrangement.clip_shorten",
      );
      expect(matchShortcut(shifted("ArrowRight"), "mac", active)?.id).toBe(
        "arrangement.clip_lengthen",
      );
      const optionShifted = (key: string) =>
        ({ ...arrow(key), shiftKey: true, altKey: true }) as ChordEvent;
      expect(matchShortcut(optionShifted("ArrowLeft"), "mac", active)?.id).toBe(
        "arrangement.clip_start_earlier",
      );
      expect(matchShortcut(optionShifted("ArrowRight"), "other", active)?.id).toBe(
        "arrangement.clip_start_later",
      );
      // Nowhere else: the editor has no meaning for them to take over.
      expect(matchShortcut(shifted("ArrowRight"), "mac", ["editor"])).toBeUndefined();
    });

    it("leave Enter to open the clip and Space to play", () => {
      const active: readonly ShortcutContext[] = ["editor", "arrangement", "clip_list"];
      expect(matchShortcut(arrow("Enter"), "other", active)?.id).toBe(
        "arrangement.open_clip",
      );
      expect(matchShortcut(arrow(" "), "other", active)?.id).toBe("transport.play_stop");
    });
  });

  describe("the focused loop brace's keys", () => {
    const arrow = (key: string, shiftKey = false) =>
      ({ key, shiftKey, ctrlKey: false, metaKey: false, altKey: false }) as ChordEvent;

    it("act only while the brace has focus", () => {
      expect(matchShortcut(arrow("ArrowLeft"), "other", ["editor"])?.id).toBe(
        "track.move_left",
      );
      expect(
        matchShortcut(arrow("ArrowLeft"), "other", ["editor", "loop_brace"])?.id,
      ).toBe("arrangement.loop_move_earlier");
    });

    it("map each arrow, plain and shifted, to its own action", () => {
      const active: readonly ShortcutContext[] = ["editor", "loop_brace"];
      const id = (key: string, shift: boolean) =>
        matchShortcut(arrow(key, shift), "mac", active)?.id;
      expect(id("ArrowRight", false)).toBe("arrangement.loop_move_later");
      expect(id("ArrowLeft", true)).toBe("arrangement.loop_shorten");
      expect(id("ArrowRight", true)).toBe("arrangement.loop_lengthen");
    });

    it("leaves every other mapping live while it is focused", () => {
      expect(matchShortcut(arrow(" "), "other", ["editor", "loop_brace"])?.id).toBe(
        "transport.play_stop",
      );
    });

    it("only narrows when a focus mapping is among the matches", () => {
      const matches = [shortcutById("track.move_left")];
      expect(preferFocused(matches, ["global", "editor", "loop_brace"])).toEqual(matches);
    });

    it("rank the open piano roll over the editor, and a focused field over both", () => {
      const roll: readonly ShortcutContext[] = ["editor", "piano_roll", "selection"];
      expect(matchShortcut(arrow("ArrowUp"), "mac", ["editor"])?.id).toBe(
        "track.select_previous",
      );
      expect(matchShortcut(arrow("ArrowUp"), "mac", roll)?.id).toBe("note.move_up");
      expect(matchShortcut(arrow("ArrowLeft"), "mac", roll)?.id).toBe(
        "note.move_earlier",
      );
      expect(matchShortcut(arrow("ArrowUp"), "mac", [...roll, "value_field"])?.id).toBe(
        "value.nudge_up",
      );
    });
  });
});

describe("the assistant's keys (#849)", () => {
  const press = (key: string, extra: Partial<ChordEvent> = {}) =>
    ({
      key,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ...extra,
    }) as ChordEvent;

  it("toggles the assistant with Cmd+K on a Mac and Ctrl+K elsewhere", () => {
    expect(matchShortcut(press("k", { metaKey: true }), "mac", ["editor"])?.id).toBe(
      "assistant.toggle",
    );
    expect(matchShortcut(press("k", { ctrlKey: true }), "other", ["editor"])?.id).toBe(
      "assistant.toggle",
    );
    expect(shortcutLabel("assistant.toggle", "mac")).toBe("Cmd+K");
    expect(shortcutLabel("assistant.toggle", "other")).toBe("Ctrl+K");
    // A modal takes the keyboard: Ctrl+K does nothing under it.
    expect(
      matchShortcut(press("k", { ctrlKey: true }), "other", ["dialog", "editor"]),
    ).toBeUndefined();
  });

  it("resizes from a focused edge, in place of what the arrows mean behind it", () => {
    const edge: readonly ShortcutContext[] = ["editor", "step_editor", "resize_edge"];
    const id = (key: string, shiftKey = false) =>
      matchShortcut(press(key, { shiftKey }), "other", edge)?.id;
    expect(id("ArrowUp")).toBe("assistant.grow");
    expect(id("ArrowLeft")).toBe("assistant.grow");
    expect(id("ArrowDown")).toBe("assistant.shrink");
    expect(id("ArrowRight")).toBe("assistant.shrink");
    expect(id("ArrowUp", true)).toBe("assistant.grow_more");
    expect(id("ArrowRight", true)).toBe("assistant.shrink_more");
    // Unfocused, the arrows keep their editor meaning.
    expect(matchShortcut(press("ArrowUp"), "other", ["editor"])?.id).toBe(
      "track.select_previous",
    );
  });
});
