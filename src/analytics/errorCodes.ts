// Stable error codes and areas (PRD `OPS-02` / `OPS-03`).
//
// These are *analytics parameter values*, so they live with the catalog rather
// than with the reporting boundary that consumes them: `exception`,
// `save_failed`, `audio_start_failed`, `asset_load_failed`, and `export_failed`
// all carry an `error_code` drawn from one list, and `exception` carries an
// `area`. `src/monitoring` imports from here; nothing here imports monitoring.
//
// A code is a *stable, low-cardinality, human-meaningful* classification, not a
// message. It answers "which failure is this" well enough to alert on and to
// group in a report; the exact detail lives in Sentry, attached to a stack
// trace. Codes are append-only for the same reason event names are: changing
// one splits a metric across two values for the same failure.

/**
 * The surface an error came from (PRD `OPS-03`: "the area it came from").
 *
 * `shell` covers app-level chrome — routing, the root error boundary, the
 * dashboard — that belongs to no single feature area.
 */
export const ERROR_AREAS = [
  "shell",
  "editor",
  "assistant",
  "audio",
  "renderer",
  "export",
  "persistence",
  "library",
  "unknown",
] as const;

export type ErrorArea = (typeof ERROR_AREAS)[number];

export function isErrorArea(value: string): value is ErrorArea {
  return (ERROR_AREAS as readonly string[]).includes(value);
}

/**
 * Every stable error code the alpha can report.
 *
 * Grouped by origin below for readability only — the values share one flat
 * namespace so a report can filter `error_code` without knowing which
 * subsystem raised it.
 */
export const ERROR_CODES = [
  // --- Generic -----------------------------------------------------------
  /** Nothing more specific could be determined. Investigate in Sentry. */
  "unknown",
  /** A bug in our own code: a broken invariant, a failed assertion. */
  "internal",
  /** The operation was cancelled deliberately, by the user or by teardown. */
  "aborted",
  /** A command refused an edit the project it met could not take. */
  "command_rejected",
  "timeout",
  "network",
  "permission_denied",
  "quota_exceeded",

  // --- Persistence -------------------------------------------------------
  // These mirror `SaveFailureReason` in src/persistence/projectRepository.ts
  // one-for-one; `catalog.test.ts` fails if the two drift apart.
  "revision_conflict",
  "not_found",
  "already_exists",
  "unsupported_schema_version",
  "invalid_document",
  "document_too_large",
  "unavailable",

  // --- Audio -------------------------------------------------------------
  /** The browser refused to start audio because no user gesture allowed it. */
  "autoplay_blocked",
  /** An AudioContext could not be created at all (unsupported/exhausted). */
  "context_unavailable",
  /** The context went away underneath us mid-operation. */
  "context_closed",
  /** Audio data could not be decoded. */
  "decode_failed",
  /** A required Web Audio capability is missing in this browser. */
  "not_supported",

  // --- Assets ------------------------------------------------------------
  "asset_missing",
  "asset_too_large",
  /** A file offered for import is not audio of a type we accept (#282). */
  "unsupported_format",
  /** A personal pack already holds as many sounds as one pack can (#282). */
  "pack_full",

  // --- Export (GRV-55) ---------------------------------------------------
  /** The offline render itself failed: the graph threw, or rendered nothing. */
  "render_failed",
  /** The browser could not allocate the memory a render or a file needed. */
  "out_of_memory",
  /** One ZIP of a batched stems export could not be built. */
  "zip_batch_failed",
  /** A finished file could not be handed to the browser as a download. */
  "download_blocked",

  // --- Engine health (GRV-55) --------------------------------------------
  /** Audio resources were still registered after their project closed. */
  "resource_leak",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Narrows an untrusted string to a known code, falling back to `"unknown"`.
 *
 * Used at the reporting boundary so an unrecognized code from a caller degrades
 * into a reportable event rather than either throwing or smuggling free text
 * into `error_code`.
 */
export function toErrorCode(value: string | undefined): ErrorCode {
  return value !== undefined && isErrorCode(value) ? value : "unknown";
}
