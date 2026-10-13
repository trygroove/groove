#!/usr/bin/env node
// PRD `OPS-03` / section 10 performance budgets, via `FND-001c`: "Monitoring
// does not compromise the section 10 performance budgets: the SDK initializes
// lazily after first paint with a minimal integration set and is not loaded on
// the marketing landing page."
//
//   node scripts/verify-bundle-budget.mjs [dir]
//
// The section 10 budget this defends is "dashboard shell interactive within 3
// seconds". The error-monitoring SDK's contribution to that budget must be
// *zero bytes*, because it is not on the interactive path at all: `initTelemetry()`
// reaches it through a dynamic `import()` scheduled after first paint. That is a
// structural claim about the build output, so it is checked rather than assumed:
//
//  1. **Nothing eagerly loaded contains the SDK.** The eager set is the entry
//     script from `index.html`, everything `index.html` asks the browser to
//     preload, and the transitive closure of their *static* imports. A refactor
//     that turns the dynamic import into a static one — the realistic way this
//     regresses — moves the SDK into that closure and fails here.
//  2. **The lazy chunk still has a declared ceiling.** Off the interactive path
//     is not the same as free: it competes for bandwidth and main-thread parse
//     time with the first edit. An SDK upgrade that doubles it should be a
//     decision, not a surprise, so the measured size is pinned to a budget.
//
//  3. **Nothing eagerly loaded contains the PostHog SDK either** (ADR 0011,
//     GRV-123). Unlike Sentry's, the PostHog analytics SDK *does* load on the
//     landing page, but only through `initTelemetry()`'s dynamic `import()`
//     once the browser is idle after first paint, and only the analytics
//     client: replay, web vitals and error monitoring still wait for an app
//     surface. Its size is product analytics, not this budget's monitoring
//     cost, so it is kept out of the eager set without a ceiling of its own.
//
// Deliberately *not* a general bundle-size check for the whole app. It answers
// exactly the `FND-001c` acceptance question about monitoring's bundle cost.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, posix } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

/**
 * Literal strings the Sentry browser SDK carries into its minified output.
 *
 * Wire-protocol names and exported integration identifiers, chosen because a
 * minifier rewrites local identifiers but not string literals or the public
 * export names other chunks import by name. A package specifier like
 * `"@sentry/browser"` does not survive bundling, so it is not used here.
 * `"captureException"` is not either: PostHog's SDK (GRV-106) carries it too,
 * and its chunk is product analytics, not this budget's monitoring cost.
 */
const SDK_MARKERS = ["sentry-trace", "sentry_key", "browserSessionIntegration"];

/**
 * Literal strings the PostHog SDK carries into its minified output: the global
 * its extensions register on, and its debug storage key. Neither appears in
 * this repository's own code, which names PostHog freely.
 */
const POSTHOG_MARKERS = ["__PosthogExtensions__", "ph_debug"];

/**
 * Brotli ceiling for the lazily-loaded monitoring chunks, combined.
 *
 * Still set from the measured size of `@sentry/solidstart` 10.68.0 with the
 * minimal
 * integration set in `src/monitoring/sentrySink.ts` (~125 KiB brotli), plus
 * room for patch upgrades. Raising it is a deliberate edit with a reason, which
 * is the point. Lowering the real number means dropping an integration.
 *
 * NOT re-measured since the Solid 2 migration swapped the SDK to
 * `@sentry/browser`, which is a strict subset of what `@sentry/solidstart`
 * pulled in. The gate is therefore still safe -- it is a ceiling, and the real
 * payload only shrank -- but the headroom is larger than intended. Re-measure
 * before treating a pass here as evidence the budget is tight.
 */
const LAZY_MONITORING_BROTLI_BUDGET = 150 * 1024;

const SCRIPT_EXTENSIONS = new Set([".js", ".mjs"]);

/** Brotli transfer size, computed rather than trusting a `.br` sibling exists. */
function brotliSize(file) {
  return brotliCompressSync(readFileSync(file), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).length;
}

function listScripts(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listScripts(full));
    } else if (SCRIPT_EXTENSIONS.has(extname(full))) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Static import specifiers in one module.
 *
 * Matches `from"./x.js"` and the side-effect form `import"./x.js"`, and
 * deliberately not `import("./x.js")` — the dynamic form is the whole point of
 * the check, so counting it as an edge would make the check always pass.
 */
export function staticImports(source) {
  const specifiers = [];
  for (const match of source.matchAll(/\bfrom\s*["']([^"']+)["']/g)) {
    specifiers.push(match[1]);
  }
  for (const match of source.matchAll(/\bimport\s*["']([^"']+)["']/g)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

/** Entry script plus every module `index.html` preloads. */
export function eagerEntryPoints(html, publicDir) {
  const hrefs = [];
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*"([^"]+)"/g)) {
    hrefs.push(match[1]);
  }
  return hrefs
    .filter((href) => SCRIPT_EXTENSIONS.has(extname(href)))
    .map((href) => join(publicDir, href.replace(/^\//, "")))
    .filter((file) => existsSync(file));
}

/** Transitive closure of `entries` over static imports only. */
export function eagerClosure(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const specifier of staticImports(source)) {
      if (!specifier.startsWith(".")) continue;
      queue.push(join(dirname(file), specifier));
    }
  }
  return seen;
}

function containsAny(file, markers) {
  const source = readFileSync(file, "utf8");
  return markers.some((marker) => source.includes(marker));
}

function containsSdk(file) {
  return containsAny(file, SDK_MARKERS);
}

function main() {
  const publicDir = process.argv[2] ?? "dist/client";
  const indexHtml = join(publicDir, "index.html");
  if (!existsSync(indexHtml)) {
    console.error(
      `verify-bundle-budget: "${indexHtml}" does not exist. Run \`bun run build\` first.`,
    );
    process.exit(1);
  }

  const eager = eagerClosure(
    eagerEntryPoints(readFileSync(indexHtml, "utf8"), publicDir),
  );
  const allScripts = listScripts(publicDir);
  const withSdk = allScripts.filter(containsSdk);

  const failures = [];

  if (withSdk.length === 0) {
    // Not a pass: it means the markers stopped matching (an SDK upgrade renamed
    // them, say), so the eager-chunk check above would trivially succeed
    // forever. A check that cannot fail is worse than no check.
    failures.push(
      "no chunk contains the error-monitoring SDK at all. Either it is no longer " +
        `bundled, or SDK_MARKERS (${SDK_MARKERS.join(", ")}) no longer match its ` +
        "minified output and this check has silently stopped working.",
    );
  }

  const eagerWithSdk = withSdk.filter((file) => eager.has(file));
  for (const file of eagerWithSdk) {
    failures.push(
      `the error-monitoring SDK is in "${posix.normalize(file)}", which is loaded ` +
        "eagerly from index.html. It must stay behind the dynamic import() in " +
        "src/telemetry.ts so it costs nothing before first paint (PRD OPS-03).",
    );
  }

  const withPostHog = allScripts.filter((file) => containsAny(file, POSTHOG_MARKERS));
  if (withPostHog.length === 0) {
    failures.push(
      "no chunk contains the PostHog SDK at all. Either it is no longer bundled, " +
        `or POSTHOG_MARKERS (${POSTHOG_MARKERS.join(", ")}) no longer match its ` +
        "minified output and this check has silently stopped working.",
    );
  }
  const eagerWithPostHog = withPostHog.filter((file) => eager.has(file));
  for (const file of eagerWithPostHog) {
    failures.push(
      `the PostHog SDK is in "${posix.normalize(file)}", which is loaded eagerly ` +
        "from index.html. It must stay behind the dynamic import() in " +
        "src/analytics/posthogTransport.ts, loaded after first paint (ADR 0011, GRV-123).",
    );
  }

  const lazyWithSdk = withSdk.filter((file) => !eager.has(file));
  const measured = lazyWithSdk.map((file) => ({
    name: basename(file),
    bytes: brotliSize(file),
  }));
  const total = measured.reduce((sum, chunk) => sum + chunk.bytes, 0);

  if (total > LAZY_MONITORING_BROTLI_BUDGET) {
    failures.push(
      `the lazily-loaded monitoring chunks are ${total} bytes brotli, over the ` +
        `${LAZY_MONITORING_BROTLI_BUDGET}-byte budget. Drop an integration, or ` +
        "raise the budget in this file with the reason.",
    );
  }

  console.log("verify-bundle-budget: error-monitoring SDK bundle cost");
  console.log(`  eager (before first paint): 0 bytes in ${eager.size} chunks`);
  for (const chunk of measured) {
    console.log(`  lazy: ${chunk.name} — ${chunk.bytes} bytes brotli`);
  }
  console.log(`  lazy total: ${total} / ${LAZY_MONITORING_BROTLI_BUDGET} bytes brotli`);
  console.log(
    `  PostHog SDK: in ${withPostHog.length} chunk(s), ${eagerWithPostHog.length} of them eager`,
  );

  if (failures.length > 0) {
    console.error("\nverify-bundle-budget: FAILED");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
