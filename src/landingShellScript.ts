/**
 * The one inline script the document executes (task `#297`), kept in a module
 * of its own so the Content-Security-Policy test (GRV-7) can hash exactly what
 * `src/Document.tsx` renders.
 *
 * It removes the prerendered landing markup when the shell is serving a deep
 * link. Inlined and parser-blocking on purpose: it must run before the browser
 * paints, or a visitor opening a project would see the marketing page flash
 * first. It reads nothing but the path.
 *
 * Changing a single character changes its hash, which `firebase.json`'s
 * `script-src` names: run `bun run build && bun run security-headers:write`
 * afterwards, or the policy refuses it and `bun run verify:security-headers`
 * fails.
 */
export const REMOVE_WHEN_NOT_LANDING = `if(location.pathname!=="/"){var e=document.getElementById("landing-static");if(e)e.remove()}`;
