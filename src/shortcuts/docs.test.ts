import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { POINTER_MODIFIERS, pointerModifierLabel } from "./pointerGestures";
import { SHORTCUTS, shortcutLabels } from "./registry";
import { SHORTCUT_GROUP_LABELS } from "./types";

/**
 * `docs/shortcuts.md` is the human copy of the registry — the PRD `KEY-01`
 * requirement that "browser conflicts and Groove deviations from Ableton
 * are documented rather than handled inconsistently". Prose drifts silently;
 * this is what stops it.
 */
const doc = readFileSync(join(process.cwd(), "docs/shortcuts.md"), "utf8");

/** Just the mapping table, so the later conflict tables cannot be mistaken for it. */
const mappingTable = doc
  .slice(doc.indexOf("## The mapping"), doc.indexOf("## Deviations"))
  .split("\n");

/** The row of the mapping table that documents one action. */
function rowFor(actionId: string): string {
  const row = mappingTable.find((line) => line.startsWith(`| \`${actionId}\` |`));
  if (!row) throw new Error(`docs/shortcuts.md has no row for ${actionId}`);
  return row;
}

describe("docs/shortcuts.md", () => {
  it("documents every registered action, and no unregistered one", () => {
    const documented = mappingTable
      .map((line) => /^\| `([a-z_]+\.[a-z0-9_]+)` \|/.exec(line)?.[1])
      .filter((id): id is string => id !== undefined);
    expect(documented.sort()).toEqual(SHORTCUTS.map((shortcut) => shortcut.id).sort());
  });

  it("states each action's keys on both platforms, and its guide group", () => {
    for (const shortcut of SHORTCUTS) {
      const row = rowFor(shortcut.id);
      expect(row, `${shortcut.id} label`).toContain(shortcut.label);
      expect(row, `${shortcut.id} mac keys`).toContain(
        `\`${shortcutLabels(shortcut, "mac").join(" / ")}\``,
      );
      expect(row, `${shortcut.id} other keys`).toContain(
        `\`${shortcutLabels(shortcut, "other").join(" / ")}\``,
      );
      expect(row, `${shortcut.id} group`).toContain(
        SHORTCUT_GROUP_LABELS[shortcut.group],
      );
      for (const context of shortcut.contexts) {
        expect(row, `${shortcut.id} context ${context}`).toContain(context);
      }
    }
  });

  it("names the Live combination behind every deviation", () => {
    for (const shortcut of SHORTCUTS) {
      if (shortcut.ableton.kind !== "differs") continue;
      expect(rowFor(shortcut.id), `${shortcut.id} deviation`).toContain(
        shortcut.ableton.abletonKeys,
      );
      // And again in the deviations section, with the reason.
      expect(doc).toContain(shortcut.ableton.abletonKeys);
    }
  });

  it("documents every pointer modifier, on both platforms, with its Live keys", () => {
    const table = doc
      .slice(doc.indexOf("## Pointer modifiers"), doc.indexOf("## Browser and OS"))
      .split("\n");
    const documented = table
      .map((line) => /^\| `([a-z_]+\.[a-z_]+)` \|/.exec(line)?.[1])
      .filter((id): id is string => id !== undefined);
    expect(documented.sort()).toEqual(POINTER_MODIFIERS.map((entry) => entry.id).sort());
    for (const entry of POINTER_MODIFIERS) {
      const row = table.find((line) => line.startsWith(`| \`${entry.id}\` |`)) ?? "";
      expect(row).toContain(entry.label);
      expect(row).toContain(`\`${pointerModifierLabel(entry, "mac")}\``);
      expect(row).toContain(`\`${pointerModifierLabel(entry, "other")}\``);
      if (entry.ableton.kind !== "solid_groove") {
        expect(row).toContain(entry.ableton.abletonKeys);
      }
    }
  });

  it("documents every browser combination the registry takes over", () => {
    for (const shortcut of SHORTCUTS) {
      if (!shortcut.browserConflict) continue;
      expect(doc).toContain(shortcut.browserConflict.note);
    }
  });
});

/**
 * The scan is deliberately limited to `src/` — the shipped web app, which is
 * the only code a user's keystrokes ever reach. Build tooling under `scripts/`
 * and the Playwright suites drive or generate the app from outside it; a
 * `keydown` there is a test pressing a key, not a second place a mapping is
 * defined.
 */
const SOURCE_ROOT = join(process.cwd(), "src");
const SHORTCUTS_DIR = join(SOURCE_ROOT, "shortcuts");

/** Every `.ts`/`.tsx` file under `src/`, tests included. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** `keydown`/`keyup`/`keypress` installed anywhere but the controller. */
const OWN_KEY_LISTENER = /addEventListener\(\s*["'`]key(?:down|up|press)/;

/**
 * A `KeyboardEvent`'s `key`/`code` read for a mapping. Matching on `.key ===`
 * alone is too blunt — `key` and `code` are ordinary property names elsewhere
 * in the app (`factoryLibrary`'s library key, a parse issue's `code`) — so a
 * hit needs one of the two things that make a read a *keyboard* read:
 * a receiver that is an event, or a comparison against a named key.
 */
const EVENT_KEY_READ =
  /\b(?:e|ev|evt|event|keyboardEvent|keyEvent)\.(?:key|code)\s*[=!]==/;

/** `key === "Escape"`, including via a destructured `key`, whatever it is read from. */
const NAMED_KEY_COMPARISON =
  /\b(?:key|code)\s*[=!]==\s*(["'`])(?:Escape|Enter|Tab|Backspace|Delete|Space|Shift|Control|Meta|Alt|CapsLock|Arrow(?:Up|Down|Left|Right)|Home|End|Page(?:Up|Down)|F\d{1,2}|Key[A-Z]|Digit\d|[A-Za-z?/ ])\1/;

/** Every rule that says "this file reads keystrokes itself". */
function readsKeystrokes(source: string): boolean {
  return (
    OWN_KEY_LISTENER.test(source) ||
    EVENT_KEY_READ.test(source) ||
    NAMED_KEY_COMPARISON.test(source)
  );
}

/**
 * The `KEY-01` claim that key combinations "are not independently duplicated
 * across components" is only true while `src/shortcuts/` is the one place a
 * `KeyboardEvent` is inspected for a mapping. `LOOP-014` migrated the two
 * component-owned listeners that predated the registry (`usePlaybackHotkey`,
 * `ConfirmDialog`); this is what stops a third from appearing.
 */
describe("key handling lives only in src/shortcuts", () => {
  it("has no component comparing a key or installing its own keydown listener", () => {
    const offenders = sourceFiles(SOURCE_ROOT)
      .filter((path) => !path.startsWith(SHORTCUTS_DIR))
      .filter((path) => readsKeystrokes(readFileSync(path, "utf8")))
      .map((path) => relative(process.cwd(), path));

    expect(
      offenders,
      "register a handler with useShortcutScope instead of reading KeyboardEvent directly",
    ).toEqual([]);
  });

  it("catches the listeners LOOP-014 removed, and not an ordinary `key`/`code`", () => {
    // Verbatim from the two handlers this task migrated, plus the shapes a
    // third would most likely take.
    for (const line of [
      'window.addEventListener("keydown", handleKeyDown);',
      'document.addEventListener("keyup", onKeyUp);',
      'if (event.key === "Escape") props.onCancel();',
      "if (e.key !== ' ') return;",
      "if (evt.code === expected) return;",
      'const { key } = event; if (key === "Escape") close();',
    ]) {
      expect(readsKeystrokes(line), line).toBe(true);
    }

    // Properties that merely share a name. The first is the false positive
    // that made this guard fail on `main`.
    for (const line of [
      "const entry = FACTORY_LIBRARY.find((candidate) => candidate.key === key);",
      'issues.some((issue) => issue.code === "unsupported_schema_version")',
      "return assets.filter((asset) => asset.key === selectedKey);",
    ]) {
      expect(readsKeystrokes(line), line).toBe(false);
    }
  });
});
