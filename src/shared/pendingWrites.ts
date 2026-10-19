// Edits waiting to be written, wherever they are held (GRV-55).
//
// An open project's autosave queues edits until it writes them. Two places
// need to reach those queues without holding the session that owns them:
//
// - The crash screen. The app's error boundary replaces the editor with a
//   recovery screen, which tears the editor (and its session) down. Its
//   Reload button writes anything still queued first, so a crash never costs
//   the producer an edit they can still see.
// - A session that has closed with a write still failing (offline, say). Its
//   queue is kept here, not dropped, and written once the browser is back
//   online, until it lands or the page goes.
//
// Framework-free, and it knows nothing about autosave: a holder is anything
// that can say how much it has unwritten and try to write it.

import type { CrashSaveOutcome } from "../analytics/catalog";

export interface PendingWriter {
  /** How many entries are still unwritten. */
  pending(): number;
  /** Tries to write them. Resolves when that attempt settles, landed or not. */
  flush(): Promise<unknown>;
}

const writers = new Set<PendingWriter>();

/** Holds `writer`'s queue until the returned function releases it. */
export function holdPendingWrites(writer: PendingWriter): () => void {
  writers.add(writer);
  return () => {
    writers.delete(writer);
  };
}

/** How many entries every holder has unwritten. */
export function unsavedWriteCount(): number {
  let total = 0;
  for (const writer of writers) total += safePending(writer);
  return total;
}

/** How long Reload waits for the writes before it reports them unsaved. */
export const FLUSH_TIMEOUT_MS = 10_000;

/**
 * Writes everything every holder has queued, and says how that went:
 * `nothing_queued` when there was nothing to write, `saved` when it all
 * landed, `unsaved` when some is still unwritten (the write failed, or did
 * not settle within `timeoutMs`). Never rejects.
 */
export async function flushPendingWrites(
  timeoutMs: number = FLUSH_TIMEOUT_MS,
): Promise<CrashSaveOutcome> {
  if (unsavedWriteCount() === 0) return "nothing_queued";
  const attempts = [...writers].map((writer) =>
    Promise.resolve()
      .then(() => writer.flush())
      .catch(() => undefined),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([Promise.all(attempts), timeout]);
  clearTimeout(timer);
  return unsavedWriteCount() === 0 ? "saved" : "unsaved";
}

function safePending(writer: PendingWriter): number {
  try {
    return writer.pending();
  } catch {
    return 0;
  }
}

/** Test-only: forget every holder. */
export function __resetPendingWritesForTests(): void {
  writers.clear();
}
