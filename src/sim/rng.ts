/**
 * Seeded PRNG — mulberry32 + stream derivation (SPEC-3.2 §2.4).
 * All sim randomness flows through these; `Rng` is plain data so it clones
 * and serializes with MatchState.
 */

export interface Rng {
  s: number;
}

/** mulberry32 — returns a float in [0, 1). Mutates r.s. */
export function mulberry32Next(r: Rng): number {
  r.s = (r.s + 0x6d2b79f5) | 0;
  let t = r.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function rngRange(r: Rng, min: number, max: number): number {
  return min + mulberry32Next(r) * (max - min);
}

export function rngInt(r: Rng, minIncl: number, maxExcl: number): number {
  return minIncl + Math.floor(mulberry32Next(r) * (maxExcl - minIncl));
}

export function rngSign(r: Rng): -1 | 1 {
  return mulberry32Next(r) < 0.5 ? -1 : 1;
}

/**
 * Box–Muller, consumes exactly 2 draws every call (no cached second value —
 * draw count must stay deterministic and serializable).
 */
export function rngGaussian(r: Rng): number {
  const u1 = mulberry32Next(r);
  const u2 = mulberry32Next(r);
  const nonZero = u1 <= Number.EPSILON ? Number.EPSILON : u1;
  return Math.sqrt(-2 * Math.log(nonZero)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Derive an independent stream from the match seed (splitmix32 one round over
 * seed ^ (streamId * 0x9E3779B9)). Stream ids: 1 serve, 2 powerup,
 * 3/4 AI left/right (controller-owned, NOT in MatchState — AR2-1), 5 misc.
 */
export function deriveStream(matchSeed: number, streamId: number): Rng {
  let z = (matchSeed ^ Math.imul(streamId, 0x9e3779b9)) | 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return { s: (z ^ (z >>> 15)) | 0 };
}

export const STREAM_SERVE = 1;
export const STREAM_POWERUP = 2;
export const STREAM_AI_LEFT = 3;
export const STREAM_AI_RIGHT = 4;
export const STREAM_MISC = 5;
