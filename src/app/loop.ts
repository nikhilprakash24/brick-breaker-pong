/**
 * Fixed-timestep accumulator (SPEC-3.2 §2.1), extracted pure so the tick
 * cadence is unit-testable headlessly. main.ts owns the RAF wiring; this
 * module owns the math: clamp frameDelta BEFORE accumulation, drain whole
 * ticks, and report alpha ∈ [0, 1) for interpolation (never extrapolate).
 */

export const SIM_HZ = 120;
export const DT_MS = 1000 / SIM_HZ; // 8.333… ms
export const MAX_FRAME_DELTA_MS = 250; // spiral-of-death clamp (≈30 ticks max)

export interface Accumulator {
  acc: number;
}

export function createAccumulator(): Accumulator {
  return { acc: 0 };
}

/** Reset on re-entry to a sim state so menus never cause a catch-up burst. */
export function resetAccumulator(a: Accumulator): void {
  a.acc = 0;
}

/**
 * Feed one frame's delta; runs `tick` once per whole DT drained.
 * Returns alpha ∈ [0, 1).
 */
export function advanceAccumulator(
  a: Accumulator,
  frameDeltaMs: number,
  tick: () => void,
): number {
  let delta = frameDeltaMs;
  if (delta > MAX_FRAME_DELTA_MS) delta = MAX_FRAME_DELTA_MS; // clamp, don't skip
  if (delta < 0) delta = 0;
  a.acc += delta;
  while (a.acc >= DT_MS) {
    tick();
    a.acc -= DT_MS;
  }
  return a.acc / DT_MS;
}
