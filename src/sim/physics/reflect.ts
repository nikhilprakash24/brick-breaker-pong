/**
 * Reflection & paddle steering math (SPEC-3.3 §3.5–3.6).
 * Every velocity change funnels through the min-|vx| clamp (R-5.1).
 */

import type { BallState, PaddleState, Side, Vec2 } from "../state";
import type { TuningTable } from "../../config/types";

/** v' = v − 2(v·n)n for any non-steering collider (§3.5). */
export function reflect(vel: Vec2, n: Vec2): void {
  const dot = vel.x * n.x + vel.y * n.y;
  vel.x -= 2 * dot * n.x;
  vel.y -= 2 * dot * n.y;
}

/**
 * Min-|vx| clamp (§3.6.3), applied after EVERY velocity change. Preserves
 * |v|; uses ball.lastHorizontalDir when vx is exactly 0.
 */
export function clampMinVx(ball: BallState, tuning: TuningTable): void {
  const speed = Math.hypot(ball.vel.x, ball.vel.y);
  if (speed <= 0) return;
  const minVx = speed * tuning.physics.ball_min_vx_frac;
  if (Math.abs(ball.vel.x) < minVx) {
    const dirX = ball.vel.x !== 0 ? Math.sign(ball.vel.x) : ball.lastHorizontalDir;
    const signY = ball.vel.y !== 0 ? Math.sign(ball.vel.y) : 1;
    ball.vel.x = dirX * minVx;
    ball.vel.y = signY * Math.sqrt(Math.max(speed * speed - minVx * minVx, 0));
  }
  if (Math.abs(ball.vel.x) >= minVx) {
    ball.lastHorizontalDir = Math.sign(ball.vel.x) as 1 | -1;
  }
}

const DEG = Math.PI / 180;

/**
 * Front-face return steering (§3.6). The pre-hit velocity is discarded
 * entirely — steering, not reflection. `speed` is the post-ramp speed in
 * u/s; `paddleVelY` feeds moving-paddle english.
 * Phase 1: control_bonus and sweet-spot are progression/material driven
 * (SPEC-2.6) and inactive — both 0 until Phase 6.
 */
export function steerReturn(
  ball: BallState,
  paddle: PaddleState,
  side: Side,
  speed: number,
  paddleVelY: number,
  tuning: TuningTable,
  offsetOverride: number | null = null,
): number {
  const off =
    offsetOverride !== null
      ? offsetOverride
      : Math.max(
          -1,
          Math.min(1, (ball.pos.y - paddle.yCenter) / (paddle.halfHeight + ball.radius)),
        );
  let theta = off * tuning.physics.max_bounce_angle * DEG;
  const cap = tuning.physics.steering_angle_cap * DEG;
  theta = Math.max(-cap, Math.min(cap, theta));
  const dir = side === "left" ? 1 : -1; // always toward the opponent
  const vx = Math.cos(theta) * speed * dir;
  let vy = Math.sin(theta) * speed;
  vy += tuning.physics.english_factor * paddleVelY;
  const s = speed / Math.hypot(vx, vy); // renormalize |v| back to speed (AR2-12)
  ball.vel.x = vx * s;
  ball.vel.y = vy * s;
  clampMinVx(ball, tuning);
  return off;
}

/** Back-face hit (§3.4.3): vx reversed × backface_speed_scale, vy untouched. */
export function backFaceReflect(ball: BallState, tuning: TuningTable): void {
  ball.vel.x = -ball.vel.x * tuning.physics.backface_speed_scale_base;
  clampMinVx(ball, tuning);
}
