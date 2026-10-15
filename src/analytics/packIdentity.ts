// Pack identity as an analytics value (PRD `OPS-02`, LIB-05, LIB-08).
//
// "Which packs are most popular?" needs an event that names *which* pack was
// added, not only what sort of pack it was — and it needs that answer for
// third-party packs above all, since the point of measuring adoption is to feed
// it back to the people who publish packs (LIB-06's marketplace: internal
// reporting, plus validation for a third-party creator that their pack landed).
//
// The privacy line is drawn by **publication**, not by authorship:
//
//   - a **factory** pack is content we publish;
//   - a **third-party** pack is content someone else publishes *through* us —
//     it appears in the public pack index, under a slug we serve, and is by
//     definition shareable;
//   - a **user** pack is not published at all. It is one producer's own
//     content, and a user pack that becomes shareable becomes a third-party
//     pack first, at which point it has a published slug like any other. So a
//     user pack's slug never travels: it reports the `"user"` sentinel.
//
// That rule is structural rather than a habit each call site has to remember —
// {@link packAnalyticsIdentity} takes the pack's *published index entry* and is
// the only way to build the parameters, so a caller cannot pass a slug without
// also passing the kind that authorizes it.
//
// The identifier is the pack's stable **slug** (`scripts/starter-library/
// packs.mjs` for ours; the pack index's `slug` for a third party's), never its
// display name and never its `pak_` ID: a PostHog breakdown reads as
// `foundation-bass` rather than an opaque token, a rename cannot rewrite
// analytics history, and library copy never lands in a report.

/**
 * What sort of pack was added, as the analytics value set (snake_case, unlike
 * the library's own `third-party`).
 *
 * `unknown` is the honest answer when a pack reached the shelf without a
 * published index entry to describe it — nothing else in project state says
 * whether an unrecognized pack is the user's own or a third party's, and
 * guessing would corrupt the very comparison the event exists to answer.
 */
export const PACK_KINDS = ["factory", "third_party", "user", "unknown"] as const;
export type PackKind = (typeof PACK_KINDS)[number];

/**
 * Pack identifiers that are not a slug.
 *
 * `"user"` is a published-nothing pack (its slug is withheld, but the *add*
 * still counts); `"unknown"` is a pack we could not describe at all.
 */
export const RESERVED_PACK_IDS = ["user", "unknown"] as const;
export type ReservedPackId = (typeof RESERVED_PACK_IDS)[number];

/**
 * The shape a published pack slug must have to be logged: the same kebab-case
 * the delivery layout and `manifest.ts` enforce, capped so a malformed or
 * hostile value cannot become a long free-text parameter.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_PACK_ID_LENGTH = 60;

/** Is this a well-formed published pack slug (and not a reserved sentinel)? */
export function isPublishedPackSlug(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_PACK_ID_LENGTH &&
    SLUG_PATTERN.test(value) &&
    !(RESERVED_PACK_IDS as readonly string[]).includes(value)
  );
}

/**
 * A `pack_id` that has been through the publication check below.
 *
 * Branded so the catalog's `pack_id` parameter cannot be satisfied by an
 * arbitrary string: `analytics.log("library_pack_added", { pack_id: pack.slug })`
 * is a *type* error, and {@link packAnalyticsIdentity} is the only way to
 * produce a value — which is what makes "a user pack's slug never travels" a
 * property of the code rather than a rule a call site has to remember.
 */
declare const publishedPackIdBrand: unique symbol;
export type PublishedPackId = string & {
  readonly [publishedPackIdBrand]: true;
};

/** The library's own kind vocabulary, as the pack index declares it. */
export type PublishedPackKind = "factory" | "third-party" | "user";

/** The facts {@link packAnalyticsIdentity} needs — a `LibraryPackSummary` has them. */
export interface IdentifiablePack {
  readonly slug: string;
  readonly kind: PublishedPackKind;
}

export interface PackAnalyticsIdentity {
  readonly pack_id: PublishedPackId;
  readonly pack_kind: PackKind;
}

function published(value: string): PublishedPackId {
  return value as PublishedPackId;
}

/**
 * The `pack_id`/`pack_kind` parameters for one pack, from its published index
 * entry.
 *
 * A factory or third-party pack is named by its slug — that is the whole point
 * of the event. A user pack is counted as an add but reports `"user"`, so
 * adoption of one's own content is still visible in aggregate without any
 * user-authored identifier leaving the device. A pack with no index entry (or a
 * malformed slug) degrades to `"unknown"`; the value is never echoed back.
 */
export function packAnalyticsIdentity(
  pack: IdentifiablePack | undefined,
): PackAnalyticsIdentity {
  if (!pack) return { pack_id: published("unknown"), pack_kind: "unknown" };
  if (pack.kind === "user") return { pack_id: published("user"), pack_kind: "user" };
  const pack_kind: PackKind = pack.kind === "third-party" ? "third_party" : "factory";
  return isPublishedPackSlug(pack.slug)
    ? { pack_id: published(pack.slug), pack_kind }
    : { pack_id: published("unknown"), pack_kind };
}
