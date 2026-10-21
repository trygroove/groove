// Device-local "has this project been opened before" bookkeeping.
//
// PRD `OPS-02`: `project_opened`'s `is_first_open` parameter is what makes the
// section 11 1- and 7-day reopen measure computable. Whether *this* open is the
// project's first is not knowable from the project document alone — a project
// created and immediately opened must still report `is_first_open: true` for
// that first open, and `false` for every one after, including across a page
// reload. That is a client-only signal with no server round trip, so it is
// recorded in this browser's storage rather than in the domain model.
//
// This also anchors the `LOOP-001`/`DEC-001` requirement that "each device
// records ... which anonymous projects were created or edited there": recording
// an open here is the same act. The fuller pairing flow that *offers* to
// attach those device-local projects to a newly authenticated account is not
// implemented yet — see the `LOOP-001` PR discussion for why it is deferred —
// but the storage this module owns is exactly what that flow would read.

/** One entry per project this device has opened at least once. */
const OPENED_STORAGE_PREFIX = "sg_device_opened:";

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Records that `projectId` was opened on this device and reports whether this
 * is the first time this device has recorded an open for it.
 *
 * Fails open: if storage is unavailable (private browsing, a full quota, a
 * non-browser test environment with no injected storage), every open reports
 * as a first open rather than throwing — the same fail-open posture PRD
 * `OPS-02` requires of analytics generally.
 */
export function markProjectOpened(projectId: string, storage?: Storage | null): boolean {
  const store = storage === undefined ? safeStorage() : storage;
  if (!store) return true;
  const key = OPENED_STORAGE_PREFIX + projectId;
  try {
    if (store.getItem(key) !== null) return false;
    store.setItem(key, "1");
    return true;
  } catch {
    return true;
  }
}

/** Removes the device-local marker. Used when a project is deleted. */
export function clearProjectOpened(projectId: string, storage?: Storage | null): void {
  const store = storage === undefined ? safeStorage() : storage;
  if (!store) return;
  try {
    store.removeItem(OPENED_STORAGE_PREFIX + projectId);
  } catch {
    // Best-effort cleanup; a leaked marker just costs one stale "not first
    // open" read if the project id is ever reused, which prefixed IDs make
    // practically impossible.
  }
}
