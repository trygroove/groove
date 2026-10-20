/**
 * Whether `error` is the browser failing to allocate memory (GRV-55): an
 * export that renders minutes of audio holds large typed arrays, and on a
 * machine short of memory the allocation itself throws.
 *
 * There is no specified error for it, so this recognises what the engines
 * throw: V8's `RangeError: Array buffer allocation failed` (and the invalid
 * typed-array length it reports for a positive size past what it can
 * allocate), and SpiderMonkey's `InternalError`/`RangeError` "out of memory"
 * and "allocation size overflow". A negative or non-numeric length
 * (`Invalid typed array length: -1`, `Invalid array buffer length`) is a bug
 * in the size we asked for, not a lack of memory, so it is not one. It reads
 * only those engine messages, never one of ours, so an encoder's own refusal
 * (`RangeError: The render is too long for a WAV file`) is not mistaken for
 * one.
 */
const OUT_OF_MEMORY =
  /allocation failed|allocation size overflow|out of memory|invalid typed array length: \d/i;

export function isOutOfMemory(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name !== "RangeError" && error.name !== "InternalError") return false;
  return OUT_OF_MEMORY.test(error.message);
}
