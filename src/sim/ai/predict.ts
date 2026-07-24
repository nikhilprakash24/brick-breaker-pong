/**
 * Prediction via forward simulation (SPEC-3.9 §9.3). Reuses the SAME
 * collision primitives as the live sim (sweepCircleVs*, reflect, min-|vx|
 * clamp, slope field) so the drift-prone geometry math is never
 * reimplemented — but with a prediction-specific resolver: brick /
 * paddle-plane / back-boundary contact TERMINATE and report; boundaries,
 * panels, levers, one-way tiles reflect normally (panels & levers as plain
 * reflection — the AI does not assume trigger outcomes; documented §9.3.2
 * inaccuracy). Operates on a COPIED ball; MatchState is never mutated.
 */

import type { BallState, MatchState, Side, Vec2 } from "../state";
import { DT_MS } from "../../config/types";
import { sweepCircleVsAABB, sweepCircleVsSegment } from "../physics/sweep";
import { clampMinVx, reflect } from "../physics/reflect";
import { slopeGradient } from "../geometry";
import { cellAabb, laneHeight, laneOfY } from "../wall";

const DT_S = DT_MS / 1000;

export interface BallPlan {
  ballId: number;
  interceptY: number | null; // y at own paddle plane; null = not approaching
  interceptTick: number; // absolute tick of predicted arrival
  crossesOwnWallLane: number | null; // lane it would hit if unpaddled
  path: Vec2[]; // sampled every 4 ticks (debug overlay)
}

function paddlePlaneX(state: MatchState, side: Side): number {
  const t = state.config.tuning.paddle;
  return side === "left" ? t.paddle_plane_x_left : t.paddle_plane_x_right;
}

/** Slope field increment (mirrors ball.ts::applySlopeField for one ball). */
function applyFieldTick(state: MatchState, vel: Vec2, posX: number): void {
  const slope = state.arena.slope;
  if (!slope || slope.mode !== "field") return;
  const t = state.config.tuning.physics;
  const g = slopeGradient(slope, posX);
  if (g !== 0) vel.x += -t.slope_accel * g * DT_S;
  const base = t.ball_base_speed;
  const speed = Math.hypot(vel.x, vel.y);
  if (speed > 0) {
    const clamped = Math.max(base * 0.5, Math.min(base * t.ball_max_speed_mult, speed));
    if (clamped !== speed) {
      const s = clamped / speed;
      vel.x *= s;
      vel.y *= s;
    }
  }
}

interface SimResult {
  endTick: number;
  crossedPlaneY: number | null;
  brickHit: { side: Side; lane: number } | null;
  crossedBack: boolean;
}

interface SimOpts {
  /** Terminate when the ball crosses this x moving toward `planeDir`. */
  planeX: number | null;
  planeDir: 1 | -1; // sign of vx that counts as "crossing toward"
  path: Vec2[] | null;
}

/**
 * Forward-simulate one ball copy. Shared core for both intercept and
 * return-verify predictions.
 */
function simulate(
  state: MatchState,
  ball: BallState,
  maxTicks: number,
  opts: SimOpts,
): SimResult {
  const tuning = state.config.tuning;
  const eps = tuning.physics.skin_eps;
  const maxBounces = tuning.physics.max_bounces_per_tick;
  const pos = { x: ball.pos.x, y: ball.pos.y };
  const vel = { x: ball.vel.x, y: ball.vel.y };
  const clampBall = { ...ball, pos, vel } as BallState;

  for (let tick = 1; tick <= maxTicks; tick++) {
    applyFieldTick(state, vel, pos.x);
    let remaining = 1.0;

    for (let bounce = 0; bounce < maxBounces; bounce++) {
      const d: Vec2 = { x: vel.x * DT_S * remaining, y: vel.y * DT_S * remaining };
      if (d.x === 0 && d.y === 0) break;

      // Plane-crossing terminator.
      let planeT = Infinity;
      if (opts.planeX !== null && Math.sign(d.x) === opts.planeDir && d.x !== 0) {
        const t = (opts.planeX - pos.x) / d.x;
        if (t > 0 && t <= 1) planeT = t;
      }

      // Earliest collider.
      let bestT = Infinity;
      let bestNormal: Vec2 | null = null;
      let bestBrick: { side: Side; lane: number } | null = null;
      let bestBack = false;

      for (const seg of state.arena.segments) {
        if (seg.kind === "oneWay") {
          const obj = state.wallObjects[seg.objectIndex];
          const bn = obj?.blockNormal;
          if (bn && d.x * bn.x + d.y * bn.y >= 0) continue; // transparent
        }
        const hit = sweepCircleVsSegment(pos, d, ball.radius, seg.a, seg.b, seg.normal);
        if (hit && hit.t < bestT) {
          bestT = hit.t;
          bestNormal = hit.normal;
          bestBrick = null;
          bestBack = seg.kind === "back";
        }
      }
      for (const side of ["left", "right"] as const) {
        const wall = state.sides[side].wall;
        if (wall.layers.length === 0) continue;
        const depth = tuning.wall.brick_depth;
        const lh = laneHeight(wall);
        const hullMinY = Math.min(pos.y, pos.y + d.y) - ball.radius;
        const hullMaxY = Math.max(pos.y, pos.y + d.y) + ball.radius;
        const laneLo = Math.max(0, Math.floor(hullMinY / lh));
        const laneHi = Math.min(wall.laneCount - 1, Math.floor(hullMaxY / lh));
        wall.layerSlots.forEach((meta, layerIndex) => {
          const row = wall.layers[layerIndex]!;
          for (let lane = laneLo; lane <= laneHi; lane++) {
            if (row[lane] == null) continue;
            const box = cellAabb(side, meta.slot, lane, wall, depth);
            const hit = sweepCircleVsAABB(pos, d, ball.radius, box);
            if (hit && hit.t < bestT) {
              bestT = hit.t;
              bestNormal = hit.normal;
              bestBrick = { side, lane };
              bestBack = false;
            }
          }
        });
      }

      // Plane crossing wins if it actually happens this tick and is earliest
      // (guard the Infinity <= Infinity trap when nothing is hit).
      if (planeT !== Infinity && planeT <= bestT) {
        return {
          endTick: tick,
          crossedPlaneY: pos.y + d.y * planeT,
          brickHit: null,
          crossedBack: false,
        };
      }
      if (bestNormal === null) {
        pos.x += d.x;
        pos.y += d.y;
        break;
      }
      pos.x += d.x * bestT + bestNormal.x * eps;
      pos.y += d.y * bestT + bestNormal.y * eps;
      if (bestBrick) return { endTick: tick, crossedPlaneY: null, brickHit: bestBrick, crossedBack: false };
      if (bestBack) return { endTick: tick, crossedPlaneY: null, brickHit: null, crossedBack: true };
      // Boundary / panel / lever / one-way: plain reflection (§9.3.2).
      reflect(vel, bestNormal);
      clampMinVx(clampBall, tuning);
      remaining *= 1 - bestT;
    }

    if (opts.path && tick % 4 === 0) opts.path.push({ x: pos.x, y: pos.y });
  }
  return { endTick: maxTicks, crossedPlaneY: null, brickHit: null, crossedBack: false };
}

/**
 * Predict the real ball's arrival at `side`'s own paddle plane (§9.3.1).
 * interceptY null ⇒ the ball is not approaching this side.
 */
export function predictBall(
  state: Readonly<MatchState>,
  ballId: number,
  side: Side,
  maxTicks: number,
): BallPlan {
  const s = state as MatchState;
  const ball = s.balls.find((b) => b.id === ballId);
  const empty: BallPlan = {
    ballId,
    interceptY: null,
    interceptTick: s.tick,
    crossesOwnWallLane: null,
    path: [],
  };
  if (!ball) return empty;
  const planeX = paddlePlaneX(s, side);
  const planeDir: 1 | -1 = side === "left" ? -1 : 1; // ball must move toward the wall
  if (Math.sign(ball.vel.x) !== planeDir) return empty; // moving away

  const path: Vec2[] = [];
  const res = simulate(s, ball, maxTicks, { planeX, planeDir, path });
  if (res.crossedPlaneY === null) return { ...empty, path };
  const wall = s.sides[side].wall;
  return {
    ballId,
    interceptY: res.crossedPlaneY,
    interceptTick: s.tick + res.endTick,
    crossesOwnWallLane: laneOfY(wall, res.crossedPlaneY),
    path,
  };
}

/**
 * Verify a hypothetical return (§9.4.4): from `contactY` at `side`'s paddle
 * plane with velocity `vel`, which opponent-wall lane does the ball first
 * strike? null ⇒ no brick reached within maxTicks (e.g. through a breach).
 */
export function predictReturnLane(
  state: Readonly<MatchState>,
  side: Side,
  contactY: number,
  vel: Vec2,
  maxTicks: number,
): number | null {
  const s = state as MatchState;
  const planeX = paddlePlaneX(s, side);
  const ghost: BallState = {
    id: -1,
    pos: { x: planeX, y: contactY },
    vel: { x: vel.x, y: vel.y },
    radius: s.config.tuning.physics.ball_radius,
    speedMult: 1,
    damage: 1,
    heavyHitsLeft: 0,
    curveAccel: 0,
    stuckToPaddle: null,
    lastHitBy: side,
    lastHorizontalDir: Math.sign(vel.x) === 0 ? 1 : (Math.sign(vel.x) as 1 | -1),
    justTeleported: false,
  };
  const res = simulate(s, ghost, maxTicks, { planeX: null, planeDir: 1, path: null });
  const opponent: Side = side === "left" ? "right" : "left";
  if (res.brickHit && res.brickHit.side === opponent) return res.brickHit.lane;
  return null;
}

/** Cheap trajectory sampler for the debug overlay only. */
export function samplePath(state: Readonly<MatchState>, ballId: number, side: Side): Vec2[] {
  return predictBall(state, ballId, side, 240).path;
}
