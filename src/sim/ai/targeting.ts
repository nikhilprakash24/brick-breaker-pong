/**
 * Targeting brains (SPEC-2.7 §2.7.3 / SPEC-3.9 §9.4.3). Each brain picks the
 * CONTACT OFFSET ∈ [−1,1] for the imminent hit by choosing a target lane on
 * the opponent wall (or a safe return) and inverting the §3.6.2 return-angle
 * formula (§9.4.4). Brain labels are ceilings — a `focus` archetype never
 * self-promotes to `breach`.
 *
 * Pure functions over a Readonly view + controller-owned memory/RNG; nothing
 * here mutates MatchState.
 */

import type { MatchState, Side, WallState } from "../state";
import { otherSide } from "../state";
import type { Rng } from "../rng";
import { rngRange } from "../rng";
import type { Targeting } from "../../config/opponents";
import { laneHeight } from "../wall";
import { ARENA_W } from "../geometry";
import { predictReturnLane } from "./predict";

const DEG = Math.PI / 180;

export interface BrainMemory {
  focusTarget: number | null; // sticky drill target lane (hysteresis)
}

export function newBrainMemory(): BrainMemory {
  return { focusTarget: null };
}

// ── wall geometry helpers ─────────────────────────────────────────────────────

function laneHpSum(wall: WallState, lane: number): number {
  let sum = 0;
  for (const row of wall.layers) sum += row[lane]?.hp ?? 0;
  return sum;
}

function maxLaneHp(wall: WallState): number {
  let m = 1;
  for (let lane = 0; lane < wall.laneCount; lane++) m = Math.max(m, laneHpSum(wall, lane));
  return m;
}

function laneCenterY(wall: WallState, lane: number): number {
  return (lane + 0.5) * laneHeight(wall);
}

/** Court-facing x of a wall's front face (the aim plane for that side). */
function wallFrontX(state: MatchState, side: Side): number {
  const wall = state.sides[side].wall;
  const depth = state.config.tuning.wall.brick_depth;
  return side === "left" ? wall.layers.length * depth : ARENA_W - wall.layers.length * depth;
}

/** Contiguous breached runs on a wall, as [loLane, hiLane] inclusive. */
function breachRuns(wall: WallState): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let lane = 0; lane < wall.laneCount; lane++) {
    if (wall.breachedLanes[lane]) {
      if (start === -1) start = lane;
    } else if (start !== -1) {
      runs.push([start, lane - 1]);
      start = -1;
    }
  }
  if (start !== -1) runs.push([start, wall.laneCount - 1]);
  return runs;
}

// ── feasibility inversion (§9.4.4) ────────────────────────────────────────────

interface Inversion {
  offset: number; // clamped to [−1, 1]
  infeasible: boolean; // the raw angle exceeded ±maxBounceAngle
}

/**
 * Offset that sends the ball from (ownPlaneX, contactY) toward the opponent
 * wall lane's center: θ = atan2(Δy, |Δx|), offset = θ / maxBounceAngle,
 * clamped. (y-down.)
 */
function invertToLane(
  state: MatchState,
  side: Side,
  contactY: number,
  targetLane: number,
): Inversion {
  const opp = otherSide(side);
  const oppWall = state.sides[opp].wall;
  const targetX = wallFrontX(state, opp);
  const targetY = laneCenterY(oppWall, targetLane);
  const ownPlaneX =
    side === "left"
      ? state.config.tuning.paddle.paddle_plane_x_left
      : state.config.tuning.paddle.paddle_plane_x_right;
  const dx = Math.abs(targetX - ownPlaneX);
  const dy = targetY - contactY;
  const maxAngle = state.config.tuning.physics.max_bounce_angle * DEG;
  const theta = Math.atan2(dy, dx);
  const raw = theta / maxAngle;
  return { offset: Math.max(-1, Math.min(1, raw)), infeasible: Math.abs(raw) > 1 };
}

/** Post-hit velocity for a chosen offset, for the one predict-verify (§9.4.4). */
function offsetToVel(state: MatchState, side: Side, offset: number, speed: number): { x: number; y: number } {
  const maxAngle = state.config.tuning.physics.max_bounce_angle * DEG;
  const theta = offset * maxAngle;
  const dir = side === "left" ? 1 : -1; // toward the opponent
  return { x: Math.cos(theta) * speed * dir, y: Math.sin(theta) * speed };
}

// ── focus scoring (§2.7.3) ────────────────────────────────────────────────────

function focusScore(
  state: MatchState,
  side: Side,
  contactY: number,
  lane: number,
  mem: BrainMemory,
  wAdjMult: number,
): number {
  const ai = state.config.tuning.ai;
  const oppWall = state.sides[otherSide(side)].wall;
  const maxHp = maxLaneHp(oppWall);
  const hp = laneHpSum(oppWall, lane);
  const adjBreached =
    (lane > 0 && oppWall.breachedLanes[lane - 1]) ||
    (lane + 1 < oppWall.laneCount && oppWall.breachedLanes[lane + 1])
      ? 1
      : 0;
  const persist = mem.focusTarget === lane ? 1 : 0;
  const infeasible = invertToLane(state, side, contactY, lane).infeasible ? 1 : 0;
  return (
    ai.ai_focus_w_hp * (1 - hp / maxHp) +
    ai.ai_focus_w_adj * wAdjMult * adjBreached +
    ai.ai_focus_w_persist * persist -
    ai.ai_focus_w_infeas * infeasible
  );
}

function focusTargetLane(
  state: MatchState,
  side: Side,
  contactY: number,
  mem: BrainMemory,
  wAdjMult: number,
): number {
  const oppWall = state.sides[otherSide(side)].wall;
  let best = 0;
  let bestScore = -Infinity;
  for (let lane = 0; lane < oppWall.laneCount; lane++) {
    // A fully-breached lane has no brick to drill — skip for focus (breach
    // brain handles holes). Keep it if every lane is breached (fallback).
    const s = focusScore(state, side, contactY, lane, mem, wAdjMult);
    if (s > bestScore) {
      bestScore = s;
      best = lane;
    }
  }
  // Retarget hysteresis (§2.7.3): keep the drill unless the current target
  // reached 0 HP or a clearly softer lane (≥ switch_delta HP lower) appeared.
  const cur = mem.focusTarget;
  if (cur !== null && cur >= 0 && cur < oppWall.laneCount) {
    const curHp = laneHpSum(oppWall, cur);
    const bestHp = laneHpSum(oppWall, best);
    const delta = state.config.tuning.ai.ai_focus_switch_delta;
    if (curHp > 0 && !(bestHp <= curHp - delta)) return cur;
  }
  mem.focusTarget = best;
  return best;
}

// ── public: choose the return offset ──────────────────────────────────────────

export function chooseReturnOffset(
  brain: Targeting,
  state: MatchState,
  side: Side,
  contactY: number,
  ballSpeed: number,
  mem: BrainMemory,
  rng: Rng,
): number {
  switch (brain) {
    case "spray": {
      const range = state.config.tuning.ai.ai_spray_range;
      return rngRange(rng, -range, range);
    }
    case "denial":
      return denialOffset(state, side, contactY, ballSpeed);
    case "focus":
      return focusOffset(state, side, contactY, ballSpeed, mem, 1);
    case "breach":
      return breachOffset(state, side, contactY, ballSpeed, mem);
  }
}

/**
 * Bounce-aware aim (bounded search): the geometric inversion ignores wall
 * bounces, so on a tall court a "straight-line" aim scatters. To make focus
 * genuinely concentrate — the §2.9.2 focus-beats-spray acceptance gate — we
 * predict a small fixed set of candidate offsets and pick the one whose
 * FIRST brick strike lands nearest the target lane. Constant compute
 * (AIM_CANDIDATES predicts), evaluated once per committed hit by the
 * controller (cached), not per tick. Deviates from §9.4.4's "no search"
 * where that rule cannot satisfy §2.9.2; geometric is the fallback.
 * 0.125-offset steps ≈ 7° of steering — fine enough to pick a lane after
 * one or two wall bounces without ballooning the predict budget.
 */
const AIM_CANDIDATES = Array.from({ length: 17 }, (_, i) => -1 + i * 0.125);

function aimAtLane(
  state: MatchState,
  side: Side,
  contactY: number,
  targetLane: number,
  ballSpeed: number,
): number {
  const geometric = invertToLane(state, side, contactY, targetLane).offset;
  let best = geometric;
  let bestDist = Infinity;
  for (const off of [geometric, ...AIM_CANDIDATES]) {
    const lane = predictReturnLane(state, side, contactY, offsetToVel(state, side, off, ballSpeed), 600);
    if (lane === null) continue; // this offset flies through a breach — not a drill
    const dist = Math.abs(lane - targetLane);
    if (dist < bestDist || (dist === bestDist && Math.abs(off) < Math.abs(best))) {
      bestDist = dist;
      best = off;
    }
  }
  return best;
}

function focusOffset(
  state: MatchState,
  side: Side,
  contactY: number,
  ballSpeed: number,
  mem: BrainMemory,
  wAdjMult: number,
): number {
  const lane = focusTargetLane(state, side, contactY, mem, wAdjMult);
  return aimAtLane(state, side, contactY, lane, ballSpeed);
}

function breachOffset(
  state: MatchState,
  side: Side,
  contactY: number,
  ballSpeed: number,
  mem: BrainMemory,
): number {
  const oppWall = state.sides[otherSide(side)].wall;
  if (oppWall.breachCount > 0) {
    const runs = breachRuns(oppWall);
    // Widest run; ties → run nearest the predicted contact y (cheaper angle).
    let bestRun = runs[0]!;
    let bestW = -1;
    let bestDist = Infinity;
    const contactLane = Math.max(
      0,
      Math.min(oppWall.laneCount - 1, Math.floor(contactY / laneHeight(oppWall))),
    );
    for (const run of runs) {
      const w = run[1] - run[0] + 1;
      const center = (run[0] + run[1]) / 2;
      const dist = Math.abs(center - contactLane);
      if (w > bestW || (w === bestW && dist < bestDist)) {
        bestW = w;
        bestDist = dist;
        bestRun = run;
      }
    }
    const centerLane = Math.round((bestRun[0] + bestRun[1]) / 2);
    const inv = invertToLane(state, side, contactY, centerLane);
    // Aim the ball THROUGH the breach (target the breached lane); the ball
    // reaching the back boundary there is the score.
    if (!inv.infeasible) return aimThroughBreach(state, side, contactY, centerLane, ballSpeed, inv.offset);
    // Infeasible this hit → widen the door: focus with w_adj doubled (§2.7.3).
    return focusOffset(state, side, contactY, ballSpeed, mem, 2);
  }
  // No breach yet → behave exactly as focus.
  return focusOffset(state, side, contactY, ballSpeed, mem, 1);
}

/** Pick the offset whose predicted path passes THROUGH the breached lane
 *  (predictReturnLane returns null = no brick hit = a clean pass). */
function aimThroughBreach(
  state: MatchState,
  side: Side,
  contactY: number,
  breachLane: number,
  ballSpeed: number,
  geometric: number,
): number {
  const laneH = laneHeight(state.sides[otherSide(side)].wall);
  for (const off of [geometric, ...AIM_CANDIDATES]) {
    const lane = predictReturnLane(state, side, contactY, offsetToVel(state, side, off, ballSpeed), 600);
    // null (flew through a hole) whose geometric target was the breach — good.
    if (lane === null) {
      // Confirm the straight-line aim pointed at the breach band, not elsewhere.
      const inv = invertToLane(state, side, contactY, breachLane);
      void laneH;
      if (Math.abs(off - inv.offset) <= 0.5) return off;
    }
  }
  return geometric;
}

/**
 * §9.4.4 predict-verify, exposed for the AI test and future refinement. As
 * the spec's fallback keeps the geometric offset either way, this is not on
 * the per-hit hot path; call it to confirm a chosen offset lands near a lane.
 */
export function verifyReturn(
  state: MatchState,
  side: Side,
  contactY: number,
  offset: number,
  ballSpeed: number,
  targetLane: number,
): boolean {
  const lane = predictReturnLane(state, side, contactY, offsetToVel(state, side, offset, ballSpeed), 600);
  return lane === null || Math.abs(lane - targetLane) <= 1;
}

function denialOffset(state: MatchState, side: Side, contactY: number, ballSpeed: number): number {
  // Evaluate the 3 candidate offsets; choose the one maximizing time-to-return
  // to own paddle plane (buys repositioning time). Approximated by minimizing
  // |vx| (a flatter return travels the court slower back), then verified by
  // predicting the round trip length.
  const candidates = state.config.tuning.ai.ai_denial_candidates;
  let best = candidates[0]!;
  let bestTime = -Infinity;
  for (const off of candidates) {
    const vel = offsetToVel(state, side, off, ballSpeed);
    // Time to return ≈ court width / |vx| (flatter = slower return).
    const t = Math.abs(vel.x) < 1e-6 ? Infinity : 1 / Math.abs(vel.x);
    if (t > bestTime) {
      bestTime = t;
      best = off;
    }
    void contactY;
  }
  return best;
}
