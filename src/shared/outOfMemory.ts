/**
 * Whether `error` is the browser failing to allocate memory (GRV-55): an
 * export that renders minutes of audio holds large typed arrays, and on a
 * machine short of memory the allocation itself throws.
 *
 * There is no specified error for it, so this recognises what the engines
 * throw: V8's `RangeError: Array buffer allocation failed` (and the invalid
 * buffer or typed-array length it reports for a size it cannot allocate), and
 * SpiderMonkey's `InternalError`/`RangeError` "out of memory" and "allocation
 * size overflow". It reads only those engine messages, never one of ours, so
 * an encoder's own refusal (`RangeError: The render is too long for a WAV
 * file`) is not mistaken for one.
 */
export function isOutOfMemory(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "InternalError") return true;
  if (error.name !== "RangeError") return false;
  return /allocation|array buffer length|typed array length|out of memory/i.test(
    error.message,
  );
}
