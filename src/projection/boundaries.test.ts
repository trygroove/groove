import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The architecture's load-bearing import rules, enforced (GRV-79). CLAUDE.md
 * and docs/architecture.html describe them in prose; this is the form that
 * fails CI. One scanner reads every non-test source file under `src/` and
 * checks its imports (`import`, `import type`, side-effect imports, dynamic
 * `import()` and `export ... from`).
 *
 * Widening an allowance below is a deliberate, reviewable edit: add the file
 * to the list and say why beside it.
 */

const sourceRoot = join(process.cwd(), "src");

interface ImportSite {
  file: string; // repo-relative, forward slashes
  specifier: string;
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const IMPORT_PATTERN = /\b(?:from|import)\s*\(?\s*["']([^"'\n]+)["']/g;

/** Every module specifier a source text imports, comments excluded. */
function importedSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...code.matchAll(IMPORT_PATTERN)].map((match) => match[1] as string);
}

function collect(): ImportSite[] {
  return walk(sourceRoot).flatMap((path) => {
    const file = `src/${relative(sourceRoot, path).split(sep).join("/")}`;
    return importedSpecifiers(readFileSync(path, "utf8")).map((specifier) => ({
      file,
      specifier,
    }));
  });
}

const isFirebase = (s: string) => s === "firebase" || s.startsWith("firebase/");
const isTone = (s: string) => s === "tone" || s.startsWith("tone/");
const isSolid = (s: string) =>
  s === "solid-js" || s.startsWith("solid-js/") || s.startsWith("@solidjs/");
const isAnthropicSdk = (s: string) =>
  s === "@anthropic-ai/sdk" || s.startsWith("@anthropic-ai/sdk/");

/** Files under a directory prefix. */
const under = (prefix: string) => (file: string) => file.startsWith(prefix);

interface Rule {
  name: string;
  /** Which importing files the rule governs. */
  scope: (file: string) => boolean;
  /** Which specifiers are restricted. */
  restricted: (specifier: string) => boolean;
  /** Governed files that may import a restricted specifier anyway, each with its reason. */
  allowed: Record<string, string>;
}

const RULES: Rule[] = [
  {
    name: "src/domain and src/commands import no Firebase, Tone or Solid",
    scope: (f) => under("src/domain/")(f) || under("src/commands/")(f),
    restricted: (s) => isFirebase(s) || isTone(s) || isSolid(s),
    allowed: {},
  },
  {
    name: "src/projection imports no Firebase, Tone, Solid or test framework",
    scope: under("src/projection/"),
    restricted: (s) => isFirebase(s) || isTone(s) || isSolid(s) || s === "vitest",
    allowed: {},
  },
  {
    name: "firebase/firestore is imported only by the repository modules",
    scope: () => true,
    restricted: (s) => s === "firebase/firestore" || s.startsWith("firebase/firestore/"),
    allowed: {
      "src/persistence/firestoreProjectRepository.ts": "the schema-v1 ProjectRepository",
      "src/persistence/firestoreFavouritesRepository.ts": "the favourites repository",
      "src/persistence/firestoreProfileRepository.ts":
        "the producer's profile and memory (GRV-25)",
      "src/userLibrary/firebaseUserLibraryRepository.ts":
        "the personal library's packs (#282)",
      "src/access/firestoreAccessRepository.ts": "the alpha allowlist (#854)",
      "src/firebaseConfig.ts":
        "initialises the Firestore instance, with the emulator hookup",
    },
  },
  {
    name: "firebase/storage is imported only by the user library repository",
    scope: () => true,
    restricted: (s) => s === "firebase/storage" || s.startsWith("firebase/storage/"),
    allowed: {
      "src/userLibrary/firebaseUserLibraryRepository.ts": "personal library audio (#282)",
    },
  },
  {
    name: "tone is imported only under src/audio",
    scope: (f) => !under("src/audio/")(f),
    restricted: isTone,
    allowed: {
      "src/library/toneAuditionEngine.ts":
        "auditions a library sound outside any project graph; the engine behind the library browser",
    },
  },
  {
    name: "src/assistant imports no Firebase, Tone or the Anthropic SDK",
    scope: under("src/assistant/"),
    restricted: (s) => isFirebase(s) || isTone(s) || isAnthropicSdk(s),
    allowed: {},
  },
  {
    name: "the Anthropic SDK belongs to functions/, not src/",
    scope: () => true,
    restricted: isAnthropicSdk,
    allowed: {},
  },
];

/** Violations of one rule over a set of import sites, as readable lines. */
function violationsOf(rule: Rule, sites: ImportSite[]): string[] {
  return sites
    .filter(
      (site) =>
        rule.scope(site.file) &&
        rule.restricted(site.specifier) &&
        !(site.file in rule.allowed),
    )
    .map((site) => `${site.file} imports "${site.specifier}"`);
}

describe("import boundaries", () => {
  const sites = collect();

  it("has source files to check", () => {
    expect(new Set(sites.map((site) => site.file)).size).toBeGreaterThan(100);
  });

  for (const rule of RULES) {
    it(rule.name, () => {
      expect(violationsOf(rule, sites)).toEqual([]);
    });

    it(`${rule.name}: every allowance is still used`, () => {
      for (const file of Object.keys(rule.allowed)) {
        const used = sites.some(
          (site) => site.file === file && rule.restricted(site.specifier),
        );
        expect(used, `${file} no longer needs its allowance`).toBe(true);
      }
    });
  }

  it("sees every import form", () => {
    const found = importedSpecifiers(`
      import a from "one";
      import type { B } from "two";
      import "three";
      const c = await import("four");
      export { d } from "five";
      export * from "six";
      import {
        e,
      } from "seven";
      // import x from "commented";
    `);
    expect(found).toEqual(["one", "two", "three", "four", "five", "six", "seven"]);
  });

  it("flags a deliberate violation of each rule", () => {
    const probe = (file: string, specifier: string) => [{ file, specifier }];
    const cases: Array<[number, string, string]> = [
      [0, "src/domain/x.ts", "firebase/auth"],
      [0, "src/commands/x.ts", "solid-js"],
      [1, "src/projection/x.ts", "tone"],
      [2, "src/editor/x.ts", "firebase/firestore"],
      [3, "src/editor/x.ts", "firebase/storage"],
      [4, "src/editor/x.ts", "tone"],
      [5, "src/assistant/x.ts", "firebase/functions"],
      [6, "src/editor/x.ts", "@anthropic-ai/sdk"],
    ];
    for (const [index, file, specifier] of cases) {
      const rule = RULES[index] as Rule;
      expect(violationsOf(rule, probe(file, specifier)), rule.name).toHaveLength(1);
    }
  });
});
