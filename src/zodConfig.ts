import { z } from "zod";

/**
 * Turns off Zod's compiled object parsers, before any schema is built (GRV-7).
 *
 * Zod 4 builds each object schema's fast path with `new Function`, after
 * probing whether it may. The Content-Security-Policy has no `'unsafe-eval'`,
 * so in production the probe is refused, Zod falls back to its interpreted
 * parser anyway, and the browser files a violation report for every page that
 * builds a schema. `jitless` skips the probe and the report with it.
 *
 * Zod decides when a schema is constructed, not when it parses, so this must
 * be evaluated before any module that builds one: `src/app.tsx` imports it
 * first, ahead of everything else.
 */
z.config({ jitless: true });
