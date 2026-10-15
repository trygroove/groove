/**
 * The eval fixtures by name (GRV-108): the projects `fixtures.ts` builds, and
 * the JSON fixtures saved beside them in `src/assistant/evals/fixtures/`.
 *
 * `bun run assistant:try -- new <fixture>` starts a session on one, and a
 * JSON eval case (`cases/<id>.json`) names the one it runs against. A JSON
 * fixture is a whole project as `serializeProject` writes it, frozen by
 * `save-case` at the moment before the request it was saved with; it is read
 * back through `parseProject`, so one that no longer parses is refused rather
 * than repaired.
 *
 * Node only: it reads the directory with `node:fs`. Nothing the app bundles
 * imports it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Project } from "../../domain/entities";
import { formatIssue, parseProject } from "../../domain/parse";
import {
  createArrangementProject,
  createBdOnlyProject,
  createBdSketchProject,
  createHouseLoopProject,
  createKitSketchProject,
  createTechnoDrumsProject,
  createTechnoLoopProject,
} from "./fixtures";

/** The projects `fixtures.ts` builds, by the name a session or a case uses. */
export const TS_FIXTURES: Readonly<Record<string, () => Project>> = {
  "kit-sketch": createKitSketchProject,
  "house-loop": createHouseLoopProject,
  arrangement: createArrangementProject,
  "techno-drums": createTechnoDrumsProject,
  "techno-loop": createTechnoLoopProject,
  "bd-only": () => createBdOnlyProject(),
  "bd-sketch": createBdSketchProject,
};

/**
 * Where the JSON fixtures live, from the repository root the tools run in
 * (`bun run`, Vitest). Not from `import.meta.url`, which Vitest's jsdom
 * environment does not give as a file URL.
 */
export function jsonFixturesDir(): string {
  return resolve("src/assistant/evals/fixtures");
}

/** A fixture or case name: lower-case words joined by hyphens. */
export const FIXTURE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The JSON fixtures in `dir`, by name, sorted. */
export function jsonFixtureNames(dir = jsonFixturesDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

/** Every fixture name a session can start on. */
export function fixtureNames(dir = jsonFixturesDir()): string[] {
  return [...Object.keys(TS_FIXTURES), ...jsonFixtureNames(dir)];
}

/** Parses a JSON fixture's text, or throws saying what is wrong with it. */
export function parseFixtureJson(text: string, label: string): Project {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${label} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = parseProject(raw);
  if (!parsed.ok) {
    throw new Error(
      `${label} is not a valid project: ${parsed.issues.slice(0, 3).map(formatIssue).join("; ")}`,
    );
  }
  return parsed.value;
}

/**
 * The fixture called `name`: a `fixtures.ts` builder, or a JSON fixture in
 * `dir`, read once and parsed afresh on every call so each run gets its own
 * project. Throws naming the fixtures there are when there is no such one.
 */
export function namedFixture(name: string, dir = jsonFixturesDir()): () => Project {
  const builder = Object.hasOwn(TS_FIXTURES, name) ? TS_FIXTURES[name] : undefined;
  if (builder) return builder;
  const path = join(dir, `${name}.json`);
  if (!FIXTURE_NAME.test(name) || !existsSync(path)) {
    throw new Error(
      `No eval fixture "${name}". Fixtures: ${fixtureNames(dir).join(", ")}`,
    );
  }
  const text = readFileSync(path, "utf8");
  const label = `The fixture ${path}`;
  parseFixtureJson(text, label);
  return () => parseFixtureJson(text, label);
}
