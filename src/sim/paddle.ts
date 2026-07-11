/**
 * Paddle kinematics & collision boxes (SPEC-3.2 §2.2 stage 4, SPEC-3.3 §3.1).
 * Paddles are AABBs: front face at the fixed paddle plane, back face
 * paddle_width behind it, top/bottom edge caps.
 */

import type { AABB, MatchState, PaddleState, PerSide, Side } from "./state";
import type { TickInputs } from "../input/controller";
import type { TuningTable } from "../config/types";
import { DT_MS } from "../config/types";

const DT_S = DT_MS / 1000;

export function paddleAabb(paddle: PaddleState, side: Side, tuning: TuningTable): AABB {
  const w = tuning.paddle.paddle_width;
  const minX = side === "left" ? paddle.x - w : paddle.x;
  return {
    min: { x: minX, y: paddle.yCenter - paddle.halfHeight },
    max: { x: minX + w, y: paddle.yCenter + paddle.halfHeight },
  };
}

/** Outward x-direction of the paddle's FRONT face (toward the court). */
export function frontDir(side: Side): 1 | -1 {
  return side === "left" ? 1 : -1;
}

/**
 * Stage 4: y += move × speed × DT, clamped to the travel zone.
 * Returns this tick's paddle y-velocities (u/s) for moving-paddle english.
 */
export function stepPaddles(state: MatchState, inputs: TickInputs): PerSide<number[]> {
  const velY: PerSide<number[]> = { left: [], right: [] };
  for (const side of ["left", "right"] as const) {
    const sideInput = inputs[side];
    state.sides[side].paddles.forEach((paddle, i) => {
      const move = sideInput.paddles[i]?.move ?? 0;
      const before = paddle.yCenter;
      paddle.yCenter = Math.max(
        paddle.zone.yMin,
        Math.min(paddle.zone.yMax, paddle.yCenter + move * paddle.speed * DT_S),
      );
      velY[side].push((paddle.yCenter - before) / DT_S);
    });
  }
  return velY;
}
