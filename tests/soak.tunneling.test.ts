/**
 * Phase 1 tunneling soak (DoD): scripted chaotic paddles, ball speed forced
 * to the 3.3× absolute cap, multiball at the max_balls cap, 10k ticks —
 * zero tunneling. Dev invariant assertions (§12.2) are ON under vitest:
 * any out-of-hull ball or unsorted array throws. The full 100k × 20-seed
 * nightly matrix lands with CI-nightly (§12.3).
 */

import { describe, expect, it } from "vitest";
import { createMatch, stepMatch } from "../src/sim";
import { simDiagnostics } from "../src/sim/ball";
import { rescaleToSpeed } from "../src/sim/speed";
import type { BallState, MatchState } from "../src/sim/state";
import { deriveStream, mulberry32Next, rngRange, type Rng } from "../src/sim/rng";
import { moveInputs, testMatchConfig, tuning } from "./helpers";

const CAP = tuning.physics.ball_max_speed_mult; // 3.3
const BASE = tuning.physics.ball_base_speed;

function injectBall(state: MatchState, rng: Rng): BallState {
  const angle = rngRange(rng, -1.2, 1.2);
  const dir = mulberry32Next(rng) < 0.5 ? -1 : 1;
  const ball: BallState = {
    id: state.nextEntityId++,
    pos: { x: rngRange(rng, 400, 880), y: rngRange(rng, 120, 600) },
    vel: { x: Math.cos(angle) * BASE * CAP * dir, y: Math.sin(angle) * BASE * CAP },
    radius: tuning.physics.ball_radius,
    speedMult: CAP,
    damage: 1,
    heavyHitsLeft: 0,
    curveAccel: 0,
    stuckToPaddle: null,
    lastHitBy: null,
    lastHorizontalDir: dir as 1 | -1,
    justTeleported: false,
  };
  state.balls.push(ball);
  return ball;
}

describe("tunneling soak — 10k ticks at 3.3× cap, 5 balls, 3 seeds", () => {
  it.each([1337, 2026, 90210])("seed %i: zero tunneling, zero MAX_BOUNCES exhaustion", (seed) => {
    const config = testMatchConfig({
      wallsLeft: [
        Array.from({ length: 12 }, () => "obsidian"),
        Array.from({ length: 12 }, () => "obsidian"),
        Array.from({ length: 12 }, () => "obsidian"),
      ],
      wallsRight: [
        Array.from({ length: 12 }, () => "obsidian"),
        Array.from({ length: 12 }, () => "obsidian"),
        Array.from({ length: 12 }, () => "obsidian"),
      ],
      rules: {
        lives: { left: 9, right: 9 },
        overtime_enabled: false,
        first_receiver: "left",
      },
    });
    const state = createMatch(config, seed);
    state.phase = { kind: "rally" };
    const script = deriveStream(seed, 42);
    let exhausted = 0;
    let moveL: -1 | 0 | 1 = 1;
    let moveR: -1 | 0 | 1 = -1;

    for (let i = 0; i < 10_000; i++) {
      // Chaotic paddles: re-roll movement every ~15 ticks.
      if (i % 15 === 0) {
        moveL = ([-1, 0, 1] as const)[Math.floor(mulberry32Next(script) * 3)]!;
        moveR = ([-1, 0, 1] as const)[Math.floor(mulberry32Next(script) * 3)]!;
      }
      // Keep pressure maxed: refill to the ball cap and force cap speed.
      if (state.phase.kind === "rally") {
        while (state.balls.length < tuning.physics.max_balls) injectBall(state, script);
      }
      for (const ball of state.balls) {
        ball.speedMult = CAP;
        rescaleToSpeed(ball, BASE * CAP);
      }
      // Keep lives topped up so the match never ends mid-soak.
      state.sides.left.lives = Math.max(state.sides.left.lives, 5);
      state.sides.right.lives = Math.max(state.sides.right.lives, 5);
      state.rally.lastTouchTick = state.tick; // stall watchdog off — speed is forced

      stepMatch(state, moveInputs(moveL, moveR)); // throws on any §12.2 violation
      exhausted += simDiagnostics.maxBouncesExhausted;
    }

    expect(exhausted).toBe(0);
    expect(state.tick).toBe(10_000);
  });
});
