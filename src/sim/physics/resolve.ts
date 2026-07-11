/**
 * Collider candidates & per-type resolution effects (SPEC-3.3 §3.4.3).
 * The earliest-TOI loop lives in ball.ts; this module knows what happens
 * when a specific collider is struck.
 */

import type { GameEvent } from "../events";
import type {
  ArenaSegment,
  BallState,
  Hit,
  MatchState,
  PaddleState,
  PerSide,
  Side,
} from "../state";
import { clampMinVx, backFaceReflect, reflect, steerReturn } from "./reflect";
import { frontDir } from "../paddle";
import { damageCell, laneOfY } from "../wall";
import { currentBallSpeed, setGlobalHitCount } from "../speed";

export type Collider =
  | { id: number; kind: "segment"; seg: ArenaSegment }
  | { id: number; kind: "paddle"; side: Side; paddle: PaddleState }
  | {
      id: number;
      kind: "brick";
      side: Side;
      layerIndex: number;
      lane: number;
      aabb: { min: { x: number; y: number }; max: { x: number; y: number } };
    };

/** Deterministic collider ids (§3.4.1 tie-break by smaller stable id). */
export function paddleColliderId(side: Side, index: number): number {
  return 100 + (side === "left" ? 0 : 1) * 10 + index;
}

export function brickColliderId(side: Side, slot: number, lane: number): number {
  return 10000 + (side === "left" ? 0 : 1) * 4096 + slot * 256 + lane;
}

export type ResolveOutcome = "continue" | "consumed";

export function resolveHit(
  state: MatchState,
  ball: BallState,
  collider: Collider,
  hit: Hit,
  paddleVelY: PerSide<number[]>,
  events: GameEvent[],
): ResolveOutcome {
  const tuning = state.config.tuning;

  switch (collider.kind) {
    case "segment": {
      if (collider.seg.kind === "back") {
        return resolveBackBoundary(state, ball, collider.seg.backSide!, events);
      }
      reflect(ball.vel, hit.normal);
      clampMinVx(ball, tuning);
      return "continue";
    }

    case "paddle": {
      const side = collider.side;
      const paddle = collider.paddle;
      const fd = frontDir(side);
      const velY = paddleVelY[side][paddle.index] ?? 0;
      // Edge (top/bottom cap, R-3.3): a y-face normal, or corner-region
      // contact beyond the paddle's y-extent (AR2-11).
      const edge =
        Math.abs(hit.normal.y) > Math.abs(hit.normal.x) ||
        Math.abs(ball.pos.y - paddle.yCenter) > paddle.halfHeight;
      // "Front-approaching": incoming vx opposes the front face's outward
      // direction (ball arriving from the court side). Corner-region sweeps
      // resolve by the same half-space test (AR2-11).
      const frontApproach = ball.vel.x * fd < 0;

      if (edge) {
        if (frontApproach) {
          // Edge hit = max-offset steering, NO hitCount increment (R-3.3).
          const off = Math.sign(ball.pos.y - paddle.yCenter) || 1;
          const speed = currentBallSpeed(state, ball);
          steerReturn(ball, paddle, side, speed, velY, tuning, off);
          ball.lastHitBy = side;
          state.rally.lastTouchSide = side;
          state.rally.lastTouchTick = state.tick;
          return "continue";
        }
        backFaceReflect(ball, tuning);
        ball.lastHitBy = side;
        events.push({ type: "BallBackFaceHit", side, ballId: ball.id, boosted: false });
        return "continue";
      }

      if (hit.normal.x * fd > 0) {
        // FRONT face: steering + speed ramp + rally increment (§3.4.3).
        setGlobalHitCount(state, state.rally.hitCount + 1, events);
        const speed = currentBallSpeed(state, ball);
        const off = steerReturn(ball, paddle, side, speed, velY, tuning, null);
        ball.lastHitBy = side;
        state.rally.lastTouchSide = side;
        state.rally.lastTouchTick = state.tick;
        state.stats.longestRally = Math.max(state.stats.longestRally, state.rally.hitCount);
        events.push({
          type: "BallPaddleHit",
          side,
          paddleIndex: paddle.index,
          ballId: ball.id,
          hitCount: state.rally.hitCount,
          speedMult: ball.speedMult,
          offset: off,
        });
        return "continue";
      }

      // BACK face: send back toward the bricks (R-3.2, GDD §13.9).
      backFaceReflect(ball, tuning);
      ball.lastHitBy = side;
      events.push({ type: "BallBackFaceHit", side, ballId: ball.id, boosted: false });
      return "continue";
    }

    case "brick": {
      damageCell(
        state,
        collider.side,
        collider.layerIndex,
        collider.lane,
        ball.damage,
        ball.id,
        events,
      );
      if (ball.damage === 2) {
        ball.heavyHitsLeft -= 1;
        if (ball.heavyHitsLeft <= 0) ball.damage = 1;
      }
      reflect(ball.vel, hit.normal);
      // Speed reset (R-3.5): global counter → 0, all balls rescale;
      // claimedThresholds keep (banked powerups never forfeited).
      setGlobalHitCount(state, 0, events);
      events.push({ type: "SpeedReset", ballId: ball.id, cause: "brick" });
      clampMinVx(ball, tuning);
      state.rally.lastTouchTick = state.tick;
      return "continue";
    }
  }
}

/** Back boundary (§3.4.3 last row): shield, else queue the crossing. */
function resolveBackBoundary(
  state: MatchState,
  ball: BallState,
  defender: Side,
  events: GameEvent[],
): ResolveOutcome {
  const wall = state.sides[defender].wall;
  if (wall.shieldCharges > 0) {
    wall.shieldCharges -= 1;
    reflect(ball.vel, { x: frontDir(defender), y: 0 });
    clampMinVx(ball, state.config.tuning);
    events.push({
      type: "ShieldConsumed",
      side: defender,
      chargesLeft: wall.shieldCharges,
      ballId: ball.id,
    });
    return "continue";
  }
  const perBall = state.config.rules.life_loss_per_exchange === "per_ball";
  if (perBall || !state.rally.exchangeLifeLost[defender]) {
    state.rally.exchangeLifeLost[defender] = true;
    state.pendingCrossings.push({
      side: defender,
      lane: laneOfY(wall, ball.pos.y),
      ballId: ball.id,
    });
    removeBall(state, ball.id, "lifeLost", events);
  } else {
    removeBall(state, ball.id, "exchangeEnd", events);
  }
  // No phase change here — stage 8 resolves queued crossings (M3′).
  return "consumed";
}

export function removeBall(
  state: MatchState,
  ballId: number,
  cause: "lifeLost" | "shield" | "exchangeEnd" | "absorbed" | "stall",
  events: GameEvent[],
): void {
  const idx = state.balls.findIndex((b) => b.id === ballId);
  if (idx === -1) return;
  state.balls.splice(idx, 1);
  events.push({ type: "BallRemoved", ballId, cause });
}
