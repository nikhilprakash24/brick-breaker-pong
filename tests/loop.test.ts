/**
 * Fixed-timestep cadence (SPEC-3.2 §2.1, Phase 0 DoD: sim ticks at 120 Hz
 * decoupled from render). The accumulator is pure, so the tick math is
 * provable headlessly at any render rate.
 */

import { describe, expect, it } from "vitest";
import {
  advanceAccumulator,
  createAccumulator,
  DT_MS,
  MAX_FRAME_DELTA_MS,
  resetAccumulator,
  SIM_HZ,
} from "../src/app/loop";

function run(frameDeltas: number[]): { ticks: number; alphas: number[] } {
  const a = createAccumulator();
  let ticks = 0;
  const alphas: number[] = [];
  for (const d of frameDeltas) {
    alphas.push(advanceAccumulator(a, d, () => ticks++));
  }
  return { ticks, alphas };
}

describe("fixed-timestep accumulator", () => {
  it("produces exactly 120 ticks per simulated second at 60 fps render", () => {
    const { ticks } = run(Array(60).fill(1000 / 60));
    expect(ticks).toBe(120);
  });

  it("produces ~120 ticks/s at 144 fps and 30 fps render alike (decoupled)", () => {
    // A partial tick may be left buffered at the second's end, so allow ±1.
    const at144 = run(Array(144).fill(1000 / 144)).ticks;
    const at30 = run(Array(30).fill(1000 / 30)).ticks;
    expect(Math.abs(at144 - SIM_HZ)).toBeLessThanOrEqual(1);
    expect(Math.abs(at30 - SIM_HZ)).toBeLessThanOrEqual(1);
  });

  it("drains exactly floor(clampedBudget / DT) ticks under irregular frame deltas", () => {
    const deltas = [12, 3, 25, 8.4, 16.6, 16.6, 40, 5, 33.4, 16.6, 100, 8, 50, 16.6, 14, 16.8, 200, 16.6, 16.6, 383.4];
    const clampedBudget = deltas.reduce((s, d) => s + Math.min(d, MAX_FRAME_DELTA_MS), 0);
    const { ticks } = run(deltas);
    expect(ticks).toBe(Math.floor(clampedBudget / DT_MS));
  });

  it("clamps a huge frame delta to ~30 ticks (spiral-of-death guard)", () => {
    const { ticks } = run([5000]);
    expect(ticks).toBe(Math.floor(MAX_FRAME_DELTA_MS / DT_MS)); // 30
  });

  it("alpha is always in [0, 1) — the renderer never extrapolates", () => {
    const { alphas } = run([1, 7, 9, 16.6, 33.3, 250, 8.33, 8.34, 0.01]);
    for (const a of alphas) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
    }
  });

  it("resetAccumulator drops leftover time (menu → match re-entry)", () => {
    const a = createAccumulator();
    let ticks = 0;
    advanceAccumulator(a, 7, () => ticks++); // 7 ms buffered, no tick yet
    resetAccumulator(a);
    const alpha = advanceAccumulator(a, 4, () => ticks++);
    expect(ticks).toBe(0);
    expect(alpha).toBeCloseTo(4 / DT_MS, 10);
  });
});
