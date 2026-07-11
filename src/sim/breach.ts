/**
 * Per-lane breach detection (SPEC-3.4 §4.3–4.4). breachedLanes, breachCount,
 * criticalLanes are derived caches OWNED here — never computed ad hoc
 * elsewhere. Collision geometry stays authoritative for pass-through
 * (R-4.4); these caches serve rules/AI/render.
 */

import type { GameEvent } from "./events";
import type { MatchState, Side, WallState } from "./state";

/** breached(side, lane) ⇔ every layer's cell in that lane is null.
 *  layers.length === 0 ⇒ every lane is breached (0-layer side). */
export function laneBreached(wall: WallState, lane: number): boolean {
  for (const row of wall.layers) {
    if (row[lane] !== null && row[lane] !== undefined) return false;
  }
  return true;
}

function laneHpSum(wall: WallState, lane: number): number {
  let sum = 0;
  for (const row of wall.layers) {
    const cell = row[lane];
    if (cell) sum += cell.hp;
  }
  return sum;
}

/** Width of the contiguous breached run containing `lane` (cache-based). */
function runWidth(wall: WallState, lane: number): number {
  let lo = lane;
  let hi = lane;
  while (lo - 1 >= 0 && wall.breachedLanes[lo - 1]) lo--;
  while (hi + 1 < wall.laneCount && wall.breachedLanes[hi + 1]) hi++;
  return hi - lo + 1;
}

export type BreachCause = "damage" | "placement" | "rebuild";

/** Incremental update for one lane after any cell mutation there (§4.4.1–2). */
export function onLaneChanged(
  state: MatchState,
  side: Side,
  lane: number,
  cause: BreachCause,
  events: GameEvent[],
): void {
  const wall = state.sides[side].wall;
  const wasBreached = wall.breachedLanes[lane]!;
  const isBreached = laneBreached(wall, lane);
  const criticalHp = state.config.tuning.wall.lane_critical_hp;
  const wasCritical = wall.criticalLanes[lane]!;
  const isCritical = !isBreached && laneHpSum(wall, lane) === criticalHp;

  if (!wasBreached && isBreached) {
    wall.breachedLanes[lane] = true;
    wall.breachCount += 1;
    const neighborBreached =
      (lane > 0 && wall.breachedLanes[lane - 1]!) ||
      (lane + 1 < wall.laneCount && wall.breachedLanes[lane + 1]!);
    const width = runWidth(wall, lane);
    if (neighborBreached) events.push({ type: "BreachWidened", side, lane, width });
    else events.push({ type: "BreachOpened", side, lane, width });
    if (state.stats.firstBreachTick[side] === null) {
      state.stats.firstBreachTick[side] = state.tick;
    }
  } else if (wasBreached && !isBreached) {
    wall.breachedLanes[lane] = false;
    wall.breachCount -= 1;
    events.push({
      type: "BreachClosed",
      side,
      lane,
      cause: cause === "placement" ? "placement" : "rebuild",
    });
  }

  wall.criticalLanes[lane] = isCritical;
  if (!wasCritical && isCritical) {
    events.push({ type: "LaneCritical", side, lane });
  } else if (wasCritical && !isCritical && !isBreached) {
    // Raised HP (repair/placement) — a lane that instead BREACHED got worse,
    // so no "cleared" event for it.
    events.push({ type: "LaneCriticalCleared", side, lane });
  }
}

/** Full recompute (§4.4.3): createMatch and after rebuild-on-life-lost. */
export function recomputeAll(
  state: MatchState,
  side: Side,
  cause: BreachCause,
  events: GameEvent[],
): void {
  const wall = state.sides[side].wall;
  for (let lane = 0; lane < wall.laneCount; lane++) {
    onLaneChanged(state, side, lane, cause, events);
  }
  if (import.meta.env.DEV) assertCacheConsistent(state, side);
}

/** Dev-build assertion: incremental caches equal a from-scratch recompute. */
export function assertCacheConsistent(state: MatchState, side: Side): void {
  const wall = state.sides[side].wall;
  let count = 0;
  for (let lane = 0; lane < wall.laneCount; lane++) {
    const b = laneBreached(wall, lane);
    if (b) count++;
    if (wall.breachedLanes[lane] !== b) {
      throw new Error(`breach cache mismatch: ${side} lane ${lane}`);
    }
  }
  if (wall.breachCount !== count) {
    throw new Error(`breachCount cache mismatch: ${side} ${wall.breachCount} != ${count}`);
  }
}
