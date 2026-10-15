import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The structural half of PRD `OPS-03` / ADR 0001 decision 1: "application code
 * does not call the Sentry SDK directly."
 *
 * A comment saying so is a convention; this is the check that makes it a fact.
 * The same shape as `src/projection/boundaries.test.ts`, and the same rule
 * `src/persistence` applies to `firestoreProjectRepository.ts`: the one module
 * that touches the vendor SDK is kept out of the directory barrel, so reaching
 * it requires naming it, and naming it fails here.
 */

const sourceRoot = join(process.cwd(), "src");

/** The single module allowed to import the Sentry SDK. */
const SENTRY_SDK_OWNER = join("monitoring", "sentrySink.ts");

/** The single module allowed to import the analytics SDK (GRV-106). */
const ANALYTICS_SDK_OWNER = join("analytics", "posthogTransport.ts");

/** Names a barrel must not export, ignoring the prose above the exports. */
function exportedSpecifiers(barrelPath: string): string[] {
  const source = readFileSync(barrelPath, "utf8");
  return [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
}

function sourceFiles(directory = sourceRoot): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      files.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

/** Every module specifier a file imports, static or dynamic. */
function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [
    ...[...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]),
    ...[...source.matchAll(/import\s*\(\s*"([^"]+)"/g)].map((match) => match[1]),
  ];
}

function importersOf(prefix: string): string[] {
  return sourceFiles()
    .filter((file) => importsOf(file).some((specifier) => specifier.startsWith(prefix)))
    .map((file) => relative(sourceRoot, file));
}

describe("the Sentry SDK is reachable from exactly one module (ADR 0001)", () => {
  it("has source files to check", () => {
    expect(sourceFiles().length).toBeGreaterThan(20);
  });

  it("is imported by sentrySink.ts and nothing else", () => {
    expect(importersOf("@sentry/")).toEqual([SENTRY_SDK_OWNER]);
  });

  it("is not re-exported from the monitoring barrel", () => {
    // Being absent from the barrel is what stops application code reaching
    // the SDK by accident through `~/monitoring`.
    expect(exportedSpecifiers(join(sourceRoot, "monitoring", "index.ts"))).not.toContain(
      "./sentrySink",
    );
  });

  it("is reached only through the composition root, and only dynamically", () => {
    // A static import would pull the SDK into the entry chunk and break the
    // "lazily after first paint" requirement; scripts/verify-bundle-budget.mjs
    // checks the built output, and this checks the source.
    const importers = sourceFiles().filter((file) =>
      importsOf(file).some((specifier) => specifier.includes("sentrySink")),
    );
    expect(importers.map((file) => relative(sourceRoot, file))).toEqual(["telemetry.ts"]);

    const telemetry = readFileSync(join(sourceRoot, "telemetry.ts"), "utf8");
    expect(telemetry).toMatch(/await import\("\.\/monitoring\/sentrySink"\)/);
    expect(telemetry).not.toMatch(/^import .*sentrySink/m);
  });
});

describe("the analytics vendor SDK is reachable from exactly one module", () => {
  it("is imported by the transport and nothing else", () => {
    expect(importersOf("posthog-js")).toEqual([ANALYTICS_SDK_OWNER]);
  });

  it("is imported only dynamically, so it stays out of the entry chunk", () => {
    const source = readFileSync(join(sourceRoot, ANALYTICS_SDK_OWNER), "utf8");
    expect(source).toMatch(/await import\("posthog-js"\)/);
    expect(source).not.toMatch(/^import (?!type ).*"posthog-js"/m);
  });

  it("leaves Google Analytics out entirely", () => {
    expect(importersOf("firebase/analytics")).toEqual([]);
  });

  it("is not re-exported from the analytics barrel", () => {
    expect(exportedSpecifiers(join(sourceRoot, "analytics", "index.ts"))).not.toContain(
      "./posthogTransport",
    );
  });
});

describe("the catalog and the scrubbing rules stay vendor-free", () => {
  // They are the two things a test must be able to exercise directly over the
  // whole surface, including events and breadcrumbs later tasks add.
  const VENDOR_FREE = [
    join("analytics", "catalog.ts"),
    join("analytics", "catalog", "app.ts"),
    join("analytics", "catalog", "arrangement.ts"),
    join("analytics", "catalog", "assistant.ts"),
    join("analytics", "catalog", "audio.ts"),
    join("analytics", "catalog", "clips.ts"),
    join("analytics", "catalog", "editing.ts"),
    join("analytics", "catalog", "export.ts"),
    join("analytics", "catalog", "library.ts"),
    join("analytics", "catalog", "navigation.ts"),
    join("analytics", "catalog", "params.ts"),
    join("analytics", "catalog", "project.ts"),
    join("analytics", "catalog", "tracks.ts"),
    join("analytics", "buckets.ts"),
    join("analytics", "errorCodes.ts"),
    join("analytics", "consent.ts"),
    join("monitoring", "scrub.ts"),
    join("monitoring", "browserInfo.ts"),
  ];

  const FORBIDDEN = ["firebase", "@sentry/", "solid-js", "@solidjs/", "tone"];

  it.each(VENDOR_FREE)("%s imports no vendor SDK", (relativePath) => {
    for (const specifier of importsOf(join(sourceRoot, relativePath))) {
      for (const forbidden of FORBIDDEN) {
        expect(
          specifier.startsWith(forbidden),
          `${relativePath} imports "${specifier}"`,
        ).toBe(false);
      }
    }
  });
});
