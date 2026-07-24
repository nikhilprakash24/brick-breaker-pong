/**
 * AI behavioural DoD (Phase 4): focus opens breaches faster than spray,
 * split-paddle opponents defend both bands, and the tier ladder is
 * monotone (a higher tier beats a lower one more often than not). The full
 * 200-seed §2.9.2 monotonicity gate lives in the batch runner; these are the
 * fast, deterministic unit checks.
 */

import { describe, expect, it } from "vitest";
import { createMatch, stepMatch } from "../src/sim";
import { AiController } from "../src/sim/ai/aiController";
import type { MatchConfig } from "../src/config/types";
import type { MatchState } from "../src/sim/state";
import { neutralSideInput } from "../src/input/controller";
import { aiMatchConfig, opponent, testMatchConfig, tuning } from "./helpers";
import type { ResolvedOpponent } from "../src/config/opponents";

const SIM_HZ = 120;

/** A perfect-tracking, no-strategy left paddle (returns straight): the shared
 *  punching bag whose wall we measure time-to-first-breach against. */
function tracker(s: MatchState): ReturnType<typeof neutralSideInput> {
  const input = neutralSideInput();
  const p = s.sides.left.paddles[0]!;
  const b = s.balls.find((x) => x.vel.x < 0);
  input.paddles[0]!.move = b ? (Math.sign(b.pos.y - p.yCenter) as -1 | 0 | 1) : 0;
  return input;
}

/** Run a match: left = tracker, right = the AI archetype; return the tick of
 *  the AI's first breach on the LEFT wall, or null. */
function ttfbForBrain(archetype: string, tier: number, seed: number): number | null {
  const config = aiMatchConfig(opponent(archetype, tier), {
    rules: { first_receiver: "left" },
  });
  const state = createMatch(config, seed);
  const ai = new AiController(opponent(archetype, tier), "right", seed);
  while (state.phase.kind !== "matchOver" && state.tick < 90_000) {
    stepMatch(state, { left: tracker(state), right: ai.sample(state, "right") });
    if (state.stats.firstBreachTick.left !== null) return state.stats.firstBreachTick.left;
  }
  return state.stats.firstBreachTick.left;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? NaN;
}

describe("focus opens breaches faster than spray (Phase 4 DoD)", () => {
  it("focus (warden) median ttfb ≤ 0.75× spray (drone), same body-ish", () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const focus = seeds.map((s) => ttfbForBrain("warden", 3, s)).filter((x): x is number => x !== null);
    const spray = seeds.map((s) => ttfbForBrain("drone", 1, s)).filter((x): x is number => x !== null);
    expect(focus.length).toBeGreaterThan(seeds.length / 2);
    expect(spray.length).toBeGreaterThan(seeds.length / 2);
    const mFocus = median(focus);
    const mSpray = median(spray);
    // focus concentrates fire; spray never models the wall — a wide margin.
    expect(mFocus).toBeLessThanOrEqual(0.75 * mSpray);
    void SIM_HZ;
  });
});

describe("split-paddle opponent works (§7.4.3)", () => {
  it("twins builds two zones straddling an uncovered center gap", () => {
    const opp: ResolvedOpponent = opponent("twins", 4);
    const config: MatchConfig = aiMatchConfig(opp);
    const state = createMatch(config, 1);
    const p = state.sides.right.paddles;
    expect(p).toHaveLength(2);
    // Zones do not overlap and leave the center gap uncovered.
    expect(p[0]!.zone.yMax).toBeLessThan(p[1]!.zone.yMin);
    const gapMid = 360;
    expect(p[0]!.zone.yMax).toBeLessThan(gapMid);
    expect(p[1]!.zone.yMin).toBeGreaterThan(gapMid);
  });

  it("both twin paddles register hits over a match (each defends its band)", () => {
    const opp = opponent("twins", 4);
    const config = aiMatchConfig(opp, { rules: { first_receiver: "left" } });
    const state = createMatch(config, 5);
    const ai = new AiController(opp, "right", 5);
    const hitsByPaddle = [0, 0];
    while (state.phase.kind !== "matchOver" && state.tick < 90_000) {
      const events = stepMatch(state, { left: tracker(state), right: ai.sample(state, "right") });
      for (const e of events) {
        if (e.type === "BallPaddleHit" && e.side === "right") hitsByPaddle[e.paddleIndex]!++;
      }
    }
    expect(hitsByPaddle[0]! + hitsByPaddle[1]!).toBeGreaterThan(10);
    expect(hitsByPaddle[0]).toBeGreaterThan(0);
    expect(hitsByPaddle[1]).toBeGreaterThan(0);
  });
});

describe("tier-ladder monotonicity (reduced-seed unit check)", () => {
  /** Head-to-head: two wardens at different tiers, symmetric walls; return
   *  true iff the higher tier wins. */
  function higherTierWins(loTier: number, hiTier: number, seed: number): boolean | null {
    const config = testMatchConfig({ rules: { first_receiver: "left" } });
    // Symmetric 2-layer walls (default from testMatchConfig) — fair siege.
    config.paddles = {
      left: opponent("warden", loTier).paddle,
      right: opponent("warden", hiTier).paddle,
    };
    const state = createMatch(config, seed);
    const lo = new AiController(opponent("warden", loTier), "left", seed);
    const hi = new AiController(opponent("warden", hiTier), "right", seed);
    while (state.phase.kind !== "matchOver" && state.tick < 120_000) {
      stepMatch(state, { left: lo.sample(state, "left"), right: hi.sample(state, "right") });
    }
    if (state.phase.kind !== "matchOver") return null;
    return state.phase.winner === "right"; // right = higher tier
  }

  // Reduced-seed unit sanity; the full 200-seed §2.9.2 gate is `npm run ai:ladder`.
  it(
    "T5 beats T1 in a clear majority of head-to-heads",
    () => {
      const seeds = Array.from({ length: 12 }, (_, i) => (i + 1) * 1013);
      const results = seeds.map((s) => higherTierWins(1, 5, s)).filter((x): x is boolean => x !== null);
      const winRate = results.filter(Boolean).length / results.length;
      expect(results.length).toBeGreaterThan(seeds.length / 2);
      expect(winRate).toBeGreaterThan(0.6); // strong tier separation
    },
    300_000, // 12 full-length matches; slower CI runners can exceed the 120s default
  );

  it(
    "T4 beats T2 more often than not",
    () => {
      const seeds = Array.from({ length: 12 }, (_, i) => (i + 1) * 3307);
      const results = seeds.map((s) => higherTierWins(2, 4, s)).filter((x): x is boolean => x !== null);
      const winRate = results.filter(Boolean).length / results.length;
      expect(winRate).toBeGreaterThan(0.5);
      void tuning;
    },
    300_000,
  );
});
