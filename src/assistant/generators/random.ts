/**
 * The seeded randomness behind a pattern generator's `variation` (GRV-141).
 *
 * A generator call above `variation: 0` moves velocities, drops or adds the
 * occasional note and alters an arpeggio's order a little, and it must do so
 * the same way every time the same call comes in the same turn. So nothing
 * here reads `Math.random()`: the gateway hands each call a seed string (the
 * turn's ID stem and the call's position, `compactNotes.ts`), hashed here into
 * a small, fast generator whose sequence is fixed by that string alone.
 *
 * Pure, with no Tone, Firebase or Solid.
 */

/** A source of numbers in [0, 1), fixed by its seed. */
export interface SeededRandom {
  /** The next number in [0, 1). */
  next(): number;
  /** Whether an event of probability `p` happens this time. */
  chance(p: number): boolean;
  /** A number in [-1, 1). */
  signed(): number;
}

/** FNV-1a over the string's UTF-16 code units: a 32-bit seed from any string. */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Mulberry32, seeded by `seed` hashed: the same seed, the same sequence. */
export function seededRandom(seed: string): SeededRandom {
  let state = hashSeed(seed);
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    chance: (p) => p > 0 && next() < p,
    signed: () => next() * 2 - 1,
  };
}
