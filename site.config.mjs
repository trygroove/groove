/**
 * Where the site lives, and what it calls itself.
 *
 * One file, because these values are needed from three places that cannot
 * share a module system otherwise: the prerendered document shell
 * (`src/Document.tsx`, TypeScript, built by Vite), the build scripts under
 * `scripts/` (plain Node ESM), and the client. Plain data with no `process.env`
 * read, so it is safe in all three — an environment-specific override belongs
 * in `vite.config.ts`'s `define`, not here.
 *
 * Moving the site to another domain is an edit to `SITE_ORIGIN` alone.
 */

/** Public origin, no trailing slash. Canonical and `og:url` are built from it. */
export const SITE_ORIGIN = "https://trygroove.app";

/** The product's name, as it appears in a tab title and a link preview. */
export const SITE_NAME = "Groove";

/**
 * The assistant's name (GRV-25): what Groove's AI producer is called wherever
 * it speaks or is spoken of. One constant, so a rename is one edit; "the
 * assistant" never appears in copy.
 */
export const ASSISTANT_NAME = "Cue";

/**
 * The landing page's `<title>`.
 *
 * Also set as the route's title once the client mounts (see `LandingPage`), so
 * a crawler that executes JavaScript and one that does not read the same thing.
 */
export const SITE_TITLE = "Groove — Finish the tracks you start";

/**
 * The `<meta name="description">` and the link-preview description.
 *
 * Kept under 160 characters, which is roughly where search results and
 * unfurls truncate. It says what the page's headline and lede say (#1135):
 * what Groove is, the AI producer beside you, and the payoff of finishing
 * tracks. The page itself labels the AI producer as arriving in October.
 */
export const SITE_DESCRIPTION =
  "A music studio in your browser with an AI producer beside you. It suggests real changes and explains why they work, so you finish the tracks you start.";

/**
 * The link-preview image (#1135): a 1200×630 still of the real app, recorded
 * with the home page's video by `bun run landing:capture`, served from
 * `public/`. A path, so `SITE_ORIGIN` stays the one place the domain lives.
 */
export const SITE_IMAGE = {
  path: "/landing/og.jpg",
  width: 1200,
  height: 630,
  type: "image/jpeg",
  alt: "The Groove editor: a song of four tracks laid out in named sections on the arrangement.",
};

/**
 * The tab title inside the app.
 *
 * `src/app.tsx` sets it once the client mounts, and `scripts/emit-app-shell.mjs`
 * puts the same string in the deep-link shell, so a project page's tab reads
 * the same before and after the app has loaded. The landing page overrides it
 * with `SITE_TITLE`, which is the one a crawler and a link preview see.
 */
export const APP_TITLE = "Groove";

/**
 * The tab title for one page of the app: `Projects – Groove`, or a project's
 * own name in the editor. Every in-app page names itself this way.
 *
 * @param {string} page
 */
export function pageTitle(page) {
  return `${page} – ${APP_TITLE}`;
}

/**
 * Where someone who is not on the alpha list asks to be let in (#854): the
 * request-access form. The landing page's Request an invite links and the "not
 * on the alpha list" page both link here, and nowhere else writes it down.
 */
export const requestAccessUrl = "https://tally.so/r/Zjqyea";
