import * as z from "zod/v4";

/**
 * Zod as the client imports it: configured for the Content-Security-Policy
 * (GRV-7).
 *
 * Zod 4 builds each object schema's fast path with `new Function`, after
 * probing whether it may. The Content-Security-Policy has no `'unsafe-eval'`,
 * so in production the probe is refused, Zod falls back to its interpreted
 * parser anyway, and the browser files a violation report for every page that
 * builds a schema. `jitless` skips the probe and the report with it.
 *
 * Zod probes when an object schema is constructed, not when it parses, so the
 * config must run before any module builds one. A side-effect import at the
 * top of `src/app.tsx` is not enough for that: the bundler hoists a schema
 * module shared with lazy routes into its own chunk, and the entry chunk's
 * static imports evaluate before the entry's own code. So `vite.config.ts`
 * aliases bare `zod` to this module instead, which makes the config part of
 * Zod itself for every client module that imports it. `zod/v4` is the same
 * build `zod` exports (`z`, every named export, and `z` as the default), so
 * nothing changes for the importers. Unit tests and the Functions bundle do
 * not go through Vite's alias; neither runs under the policy.
 */
z.config({ jitless: true });

export * from "zod/v4";
export { z };
export default z;
