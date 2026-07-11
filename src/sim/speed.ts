/**
 * Speed ramp application (SPEC-3.3 §3.7 / SPEC-2.1 §2.1.3): one GLOBAL
 * rally counter; on every change all live balls rescale to the new curve
 * multiplier, direction preserved. Counter is unbounded (AR2-2) — the cap
 * applies at lookup.
 */

import type { GameEvent } from "./events";
import type { BallState, MatchState } from "./state";

export function setGlobalHitCount(
  state: MatchState,
  hitCount: number,
  _events: GameEvent[],
): void {
  const tuning = state.config.tuning;
  state.rally.hitCount = hitCount;
  const idx = Math.min(hitCount, tuning.rally.rally_cap_hits);
  const mult = tuning.rally.speed_curve[idx]!;
  const base = tuning.physics.ball_base_speed;
  for (const ball of state.balls) {
    ball.speedMult = mult;
    rescaleToSpeed(ball, base * mult);
  }
}

/** Rescale |vel| to `target` u/s, direction preserved. */
export function rescaleToSpeed(ball: BallState, target: number): void {
  const speed = Math.hypot(ball.vel.x, ball.vel.y);
  if (speed <= 0) return;
  const s = target / speed;
  ball.vel.x *= s;
  ball.vel.y *= s;
}

/** Post-clamp gameplay speed for this ball (u/s). Timed ball modifiers and
 *  timescales join in Phase 5 (§11.7). */
export function currentBallSpeed(state: MatchState, ball: BallState): number {
  return state.config.tuning.physics.ball_base_speed * ball.speedMult;
}
