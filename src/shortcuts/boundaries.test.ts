import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * One shortcut controller per app (GRV-186), enforced. `ShortcutRoot` mounts it
 * on the window and every surface registers a scope on it with
 * `useShortcutScope`. A second controller, or a second `keydown` listener on
 * the window, is how two surfaces came to run on one key press (GRV-148): each
 * applied the dispatch rules on its own, knowing nothing of the other.
 *
 * Every non-test source file under `src/` outside `src/shortcuts/` is scanned.
 * Test files are not: a test may build a controller to hand to `ShortcutRoot`.
 */

const sourceRoot = join(process.cwd(), "src");

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// Comments are dropped, so prose that names the class is not a construction.
// A string literal is matched first and kept, so a `//` inside one is not
// taken for the start of a comment.
const STRING_OR_COMMENT =
  /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

const withoutComments = (source: string) =>
  source.replace(STRING_OR_COMMENT, (_match, literal?: string) => literal ?? "");

/** `new ShortcutController(`, however it was imported or aliased by name. */
const CONSTRUCTS_CONTROLLER = /\bnew\s+ShortcutController\s*\(/;

/** A `keydown` listener on the window: `window.addEventListener("keydown", …)`
 * or a controller's `attach(window)`. */
const WINDOW_KEYDOWN =
  /\b(?:window|globalThis|self)\s*\.\s*addEventListener\(\s*["'`]keydown|\.attach\(\s*(?:window|globalThis|self)\s*\)/;

function offends(source: string): boolean {
  const code = withoutComments(source);
  return CONSTRUCTS_CONTROLLER.test(code) || WINDOW_KEYDOWN.test(code);
}

describe("one shortcut controller (GRV-186)", () => {
  it("is constructed and attached to the window only inside src/shortcuts", () => {
    const offenders = walk(sourceRoot)
      .map((path) => `src/${relative(sourceRoot, path).split(sep).join("/")}`)
      .filter((file) => !file.startsWith("src/shortcuts/"))
      .filter((file) => offends(readFileSync(join(process.cwd(), file), "utf8")));

    expect(
      offenders,
      "register a scope with useShortcutScope instead of a controller of your own",
    ).toEqual([]);
  });

  it("catches the per-surface controller this replaced, and the shapes a new one would take", () => {
    for (const source of [
      // `useShortcuts`, verbatim, as 14 surfaces called it.
      "const controller = new ShortcutController(options);\nonSettled(() => controller.attach(window));",
      "new ShortcutController({ handlers, contexts })",
      'window.addEventListener("keydown", onKey);',
      "globalThis.addEventListener('keydown', listener)",
      "controller.attach(window)",
    ]) {
      expect(offends(source), source).toBe(true);
    }
    for (const source of [
      "// a `new ShortcutController(...)` per surface is what GRV-186 removed",
      'element.addEventListener("pointerdown", onPointer);',
      "useShortcutScope({ handlers, contexts })",
    ]) {
      expect(offends(source), source).toBe(false);
    }
  });
});
