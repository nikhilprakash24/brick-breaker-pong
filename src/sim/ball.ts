/**
 * Ball integration: earliest-TOI multi-bounce loop + broad phase
 * (SPEC-3.3 §3.4) and the speed ramp application points (§3.7).
 */

import type { GameEvent } from "./events";
import type { AABB, BallState, MatchState, PerSide, Vec2 } from "./state";
import { DT_MS } from "../config/types";
import { sweepCircleVsAABB, sweepCircleVsSegment } from "./physics/sweep";
import {
  brickColliderId,
  paddleColliderId,
  resolveHit,
  type Collider,
} from "./physics/resolve";
import { paddleAabb } from "./paddle";
import { cellAabb, laneHeight, MAX_LAYER_SLOTS } from "./wall";
import { ARENA_W, bottomY, slopeGradient, topY } from "./geometry";
import { IS_DEV } from "./env";
import { clampMinVx, reflect } from "./physics/reflect";

const DT_S = DT_MS / 1000;

/** Per-stepMatch physics diagnostics (transient — NOT MatchState, NOT hashed).
 *  Read by soak tests and the debug overlay. */
export const simDiagnostics = {
  maxBouncesExhausted: 0,
  depenetrations: 0,
  reset(): void {
    this.maxBouncesExhausted = 0;
    this.depenetrations = 0;
  },
};

/**
 * Slope "field" mode (§3.8.4): each tick, BEFORE the sweep loop, every ball
 * receives vel.x += (−slope_accel × g(x)) × DT — decelerating uphill,
 * accelerating downhill — then |vel| is clamped to [0.5×, max×] base speed
 * and the min-|vx| clamp applies. The field only ever alters vel.x and is
 * position-sampled at tick start (keeping the TOI algorithm untouched).
 */
export function applySlopeField(state: MatchState): void {
  const slope = state.arena.slope;
  if (!slope || slope.mode !== "field") return;
  const tuning = state.config.tuning;
  const accel = tuning.physics.slope_accel;
  const base = tuning.physics.ball_base_speed;
  const floor = base * 0.5; // slope_speed_floor_mult (GR2-15)
  const ceil = base * tuning.physics.ball_max_speed_mult;
  for (const ball of state.balls) {
    const g = slopeGradient(slope, ball.pos.x);
    if (g !== 0) ball.vel.x += -accel * g * DT_S;
    const speed = Math.hypot(ball.vel.x, ball.vel.y);
    if (speed > 0) {
      const clamped = Math.max(floor, Math.min(ceil, speed));
      if (clamped !== speed) {
        const s = clamped / speed;
        ball.vel.x *= s;
        ball.vel.y *= s;
      }
    }
    clampMinVx(ball, tuning);
  }
}

function sweepHull(pos: Vec2, d: Vec2, r: number): AABB {
  return {
    min: { x: Math.min(pos.x, pos.x + d.x) - r, y: Math.min(pos.y, pos.y + d.y) - r },
    max: { x: Math.max(pos.x, pos.x + d.x) + r, y: Math.max(pos.y, pos.y + d.y) + r },
  };
}

function aabbOverlap(a: AABB, b: AABB): boolean {
  return a.min.x <= b.max.x && a.max.x >= b.min.x && a.min.y <= b.max.y && a.max.y >= b.min.y;
}

/** Broad phase (§3.4.2): arena segments by AABB, paddles both sides, brick
 *  cells by wall-grid index rectangle — never iterate the whole grid. */
function gatherCandidates(state: MatchState, ball: BallState, d: Vec2): Collider[] {
  const hull = sweepHull(ball.pos, d, ball.radius);
  const out: Collider[] = [];

  for (const seg of state.arena.segments) {
    if (!aabbOverlap(hull, seg.aabb)) continue;
    // One-way pass filter (§3.3): transparent when approached along the
    // allowed direction (d·blockNormal ≥ 0), else a plain reflector.
    if (seg.kind === "oneWay") {
      const obj = state.wallObjects[seg.objectIndex];
      const bn = obj?.blockNormal;
      if (bn && d.x * bn.x + d.y * bn.y >= 0) continue;
    }
    out.push({ id: seg.id, kind: "segment", seg });
  }

  for (const side of ["left", "right"] as const) {
    for (const paddle of state.sides[side].paddles) {
      const box = paddleAabb(paddle, side, state.config.tuning);
      if (aabbOverlap(hull, box)) {
        out.push({ id: paddleColliderId(side, paddle.index), kind: "paddle", side, paddle });
      }
    }
    const wall = state.sides[side].wall;
    if (wall.layers.length === 0) continue;
    const depth = state.config.tuning.wall.brick_depth;
    const zone = MAX_LAYER_SLOTS * depth;
    const zoneMinX = side === "left" ? 0 : ARENA_W - zone;
    const zoneMaxX = side === "left" ? zone : ARENA_W;
    if (hull.max.x < zoneMinX || hull.min.x > zoneMaxX) continue;
    const lh = laneHeight(wall);
    const laneLo = Math.max(0, Math.floor(hull.min.y / lh));
    const laneHi = Math.min(wall.laneCount - 1, Math.floor(hull.max.y / lh));
    wall.layerSlots.forEach((meta, layerIndex) => {
      const row = wall.layers[layerIndex]!;
      for (let lane = laneLo; lane <= laneHi; lane++) {
        if (row[lane] == null) continue;
        const box = cellAabb(side, meta.slot, lane, wall, depth);
        if (aabbOverlap(hull, box)) {
          out.push({
            id: brickColliderId(side, meta.slot, lane),
            kind: "brick",
            side,
            layerIndex,
            lane,
            aabb: box,
          });
        }
      }
    });
  }
  return out;
}

/** Earliest-TOI multi-bounce loop (§3.4), one ball, one tick. */
export function integrateBall(
  state: MatchState,
  ball: BallState,
  paddleVelY: PerSide<number[]>,
  events: GameEvent[],
): void {
  const tuning = state.config.tuning;
  const eps = tuning.physics.skin_eps;
  const maxBounces = tuning.physics.max_bounces_per_tick;
  let remaining = 1.0;
  const finish = (): void => containToHull(state, ball);

  for (let bounce = 0; bounce < maxBounces; bounce++) {
    const d: Vec2 = { x: ball.vel.x * DT_S * remaining, y: ball.vel.y * DT_S * remaining };
    if (d.x === 0 && d.y === 0) return;
    const candidates = gatherCandidates(state, ball, d);
    let best: { hit: { t: number; normal: Vec2 }; c: Collider } | null = null;
    for (const c of candidates) {
      const hit =
        c.kind === "segment"
          ? sweepCircleVsSegment(ball.pos, d, ball.radius, c.seg.a, c.seg.b, c.seg.normal)
          : c.kind === "paddle"
            ? sweepCircleVsAABB(ball.pos, d, ball.radius, paddleAabb(c.paddle, c.side, tuning))
            : sweepCircleVsAABB(ball.pos, d, ball.radius, c.aabb);
      if (!hit) continue;
      if (
        best === null ||
        hit.t < best.hit.t - 1e-9 ||
        (Math.abs(hit.t - best.hit.t) <= 1e-9 && c.id < best.c.id) // §3.4.1 tie-break
      ) {
        best = { hit, c };
      }
    }
    if (best === null) {
      ball.pos.x += d.x;
      ball.pos.y += d.y;
      finish();
      return;
    }
    ball.pos.x += d.x * best.hit.t;
    ball.pos.y += d.y * best.hit.t;
    ball.pos.x += best.hit.normal.x * eps; // skin, prevents re-hit
    ball.pos.y += best.hit.normal.y * eps;
    const outcome = resolveHit(state, ball, best.c, best.hit, paddleVelY, events);
    remaining *= 1 - best.hit.t;
    if (outcome === "consumed") return; // ball removed — nothing to contain
  }
  // Safety: loop exhausted MAX_BOUNCES — zero remaining silently (log in dev).
  simDiagnostics.maxBouncesExhausted += 1;
  finish();
  if (IS_DEV) {
    console.warn(`[sim] MAX_BOUNCES exhausted for ball ${ball.id} at tick ${state.tick}`);
  }
}

/**
 * De-penetration fallback (§3.4.4): a ball that a fast diagonal slip carried
 * outside the court hull (rare, at convex arena corners under extreme speed)
 * is pushed back to the nearest boundary and reflected off its local normal.
 * Contained balls stay physical; the counter is asserted low in soak.
 */
function containToHull(state: MatchState, ball: BallState): void {
  const r = ball.radius;
  const x = ball.pos.x;
  const ty = topY(state.arena, x);
  const by = bottomY(state.arena, x);
  const localNormal = (sampler: (a: typeof state.arena, x: number) => number, inwardY: 1 | -1): Vec2 => {
    const slope = (sampler(state.arena, x + 1) - sampler(state.arena, x - 1)) / 2;
    const len = Math.hypot(1, slope) || 1;
    // Inward normal: perpendicular to the tangent (1, slope), pointing into court.
    return { x: (-slope * inwardY) / len, y: inwardY / len };
  };
  if (ball.pos.y < ty + r) {
    ball.pos.y = ty + r;
    const n = localNormal(topY, 1); // court is below the top boundary
    if (ball.vel.x * n.x + ball.vel.y * n.y < 0) reflect(ball.vel, n);
    simDiagnostics.depenetrations += 1;
  } else if (ball.pos.y > by - r) {
    ball.pos.y = by - r;
    const n = localNormal(bottomY, -1); // court is above the bottom boundary
    if (ball.vel.x * n.x + ball.vel.y * n.y < 0) reflect(ball.vel, n);
    simDiagnostics.depenetrations += 1;
  }
  // x is bounded by walls + back boundaries; a ball past x=0/1280 has already
  // been resolved as a crossing, so no x-containment is needed here.
}
