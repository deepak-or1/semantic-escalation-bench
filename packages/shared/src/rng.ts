/**
 * Deterministic PRNG utilities. Everything downstream (lab data, chaos
 * behaviour, benchmark scenarios) must be reproducible from a seed, so no
 * Math.random anywhere in the workspace.
 */

export type Rng = () => number;

/** xmur3-style string hash producing a 32-bit unsigned seed. */
export function hashSeed(input: string | number): number {
  const str = String(input);
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** mulberry32 — small, fast, good-enough distribution for simulation. */
export function createRng(seed: number | string): Rng {
  let a =
    typeof seed === "number" && Number.isInteger(seed) && seed >= 0
      ? seed >>> 0
      : hashSeed(seed);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [min, max] inclusive. */
export function rngInt(rng: Rng, min: number, max: number): number {
  if (max < min) throw new Error(`rngInt: max ${max} < min ${min}`);
  return min + Math.floor(rng() * (max - min + 1));
}

/** Float in [min, max). */
export function rngFloat(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

export function rngChance(rng: Rng, probability: number): boolean {
  return rng() < probability;
}

export function rngPick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error("rngPick: empty array");
  return items[rngInt(rng, 0, items.length - 1)] as T;
}

/** Fisher–Yates shuffle on a copy; input is not mutated. */
export function rngShuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = rngInt(rng, 0, i);
    const tmp = copy[i] as T;
    copy[i] = copy[j] as T;
    copy[j] = tmp;
  }
  return copy;
}

/** Pick `count` distinct indices from [0, size). */
export function rngDistinctIndices(rng: Rng, size: number, count: number): number[] {
  if (count > size) throw new Error(`rngDistinctIndices: count ${count} > size ${size}`);
  return rngShuffle(rng, Array.from({ length: size }, (_, i) => i)).slice(0, count);
}

/** Knuth's algorithm — fine for the small lambdas used in match simulation. */
export function poissonSample(rng: Rng, lambda: number): number {
  if (lambda <= 0) return 0;
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rng();
  } while (p > limit);
  return k - 1;
}
