/**
 * Wall grid (SPEC-3.4 §4.1–4.2). Single damage mutation path: damageCell —
 * called only from resolveHit (brick collision) and the overtime decay rule
 * (R-6.3). Placement/rebuild also route through mutators here.
 *
 * Geometry follows the slot rule (§4.1): starting layers occupy depth slots
 * 3, 2, … rear-first; runtime layers take the next free slot in FRONT.
 * cellAabb uses the slot, never the array index, so no existing brick ever
 * changes coordinates when a layer is added.
 */

import type { GameEvent } from "./events";
import type {
  AABB,
  BrickCell,
  MatchState,
  MaterialId,
  Side,
  WallState,
} from "./state";
import { ARENA_H, ARENA_W } from "./geometry";
import { assertCacheConsistent, onLaneChanged } from "./breach";
import { IS_DEV } from "./env";

export const MAX_LAYER_SLOTS = 4;

export function laneHeight(wall: WallState): number {
  return ARENA_H / wall.laneCount;
}

export function laneOfY(wall: WallState, y: number): number {
  const lane = Math.floor(y / laneHeight(wall));
  return Math.max(0, Math.min(wall.laneCount - 1, lane));
}

/** The wall zone's court-facing x extent for broad-phase (0–88 / 1192–1280). */
export function wallZoneDepth(brickDepth: number): number {
  return MAX_LAYER_SLOTS * brickDepth;
}

export function cellAabb(
  side: Side,
  slot: number,
  lane: number,
  wall: WallState,
  brickDepth: number,
): AABB {
  const lh = laneHeight(wall);
  const minY = lane * lh;
  if (side === "left") {
    const minX = (MAX_LAYER_SLOTS - 1 - slot) * brickDepth;
    return { min: { x: minX, y: minY }, max: { x: minX + brickDepth, y: minY + lh } };
  }
  const maxX = ARENA_W - (MAX_LAYER_SLOTS - 1 - slot) * brickDepth;
  return { min: { x: maxX - brickDepth, y: minY }, max: { x: maxX, y: minY + lh } };
}

/** Build a wall from resolved layer layouts (level config, R-1.4).
 *  layouts[0] = frontmost. */
export function buildWall(
  side: Side,
  laneCount: number,
  layouts: MaterialId[][],
  materialHp: (m: MaterialId) => number,
): WallState {
  const layers: (BrickCell | null)[][] = [];
  const layerSlots: WallState["layerSlots"] = [];
  const n = layouts.length; // 0..3, validated at load
  for (let i = 0; i < n; i++) {
    const layout = layouts[i]!;
    layers.push(
      layout.map((m) => {
        const hp = materialHp(m);
        return { material: m, hp, maxHp: hp };
      }),
    );
    // Starting layers occupy slots 3, 2, … rear-first; layouts[0] is the
    // frontmost, so its slot is the LOWEST of the occupied range.
    layerSlots.push({ slot: (MAX_LAYER_SLOTS - n + i) as 0 | 1 | 2 | 3 });
  }
  return {
    side,
    laneCount,
    layers,
    layerSlots,
    breachedLanes: Array(laneCount).fill(false) as boolean[],
    breachCount: 0,
    criticalLanes: Array(laneCount).fill(false) as boolean[],
    startingLayerCount: n,
    shieldCharges: 0,
    pending: [],
  };
}

/** Single damage entry point (§4.2). Returns whether the cell was destroyed. */
export function damageCell(
  state: MatchState,
  side: Side,
  layer: number,
  lane: number,
  amount: number,
  byBallId: number | null,
  events: GameEvent[],
): { destroyed: boolean } {
  const wall = state.sides[side].wall;
  const row = wall.layers[layer];
  const cell = row?.[lane];
  if (!row || !cell) return { destroyed: false };

  cell.hp -= amount;
  const hpLeft = Math.max(0, cell.hp);
  events.push({
    type: "BrickDamaged",
    side,
    layer,
    lane,
    material: cell.material,
    hpLeft,
    hpFrac: hpLeft / cell.maxHp,
    byBallId,
  });

  let destroyed = false;
  if (cell.hp <= 0) {
    row[lane] = null;
    destroyed = true;
    events.push({ type: "BrickDestroyed", side, layer, lane, material: cell.material, byBallId });
    state.stats.bricksDestroyed[side] += 1;
  }
  onLaneChanged(state, side, lane, "damage", events);
  // §12.2: incremental caches equal a from-scratch recompute after every mutation.
  if (IS_DEV) assertCacheConsistent(state, side);
  return { destroyed };
}

/** Rebuild-on-life-lost (§4.7, R-4.5) — applied to the LOSER's wall only,
 *  inside lifeLostSeq with no balls in flight. */
export function rebuildWall(
  state: MatchState,
  side: Side,
  events: GameEvent[],
): void {
  const mode = state.config.rules.rebuild_on_life_lost;
  if (mode === "none") return;
  const wall = state.sides[side].wall;

  if (mode === "full") {
    // Restore to level-start state; placed layer-4 content is discarded
    // (truncate to startingLayerCount — the single sanctioned W2 exception).
    const layouts = state.config.walls[side].layers;
    const rebuilt = buildWall(
      side,
      wall.laneCount,
      layouts,
      (m) => state.config.materials[m]!.hp,
    );
    wall.layers = rebuilt.layers;
    wall.layerSlots = rebuilt.layerSlots;
    wall.startingLayerCount = rebuilt.startingLayerCount;
    wall.pending = [];
    events.push({ type: "WallRebuilt", side, mode: "full" });
  } else {
    // breach_fill: every breached lane refills with rebuild_material across
    // all existing layers (SPEC-2.2 §2.2.8).
    const material = state.config.rules.rebuild_material;
    const hp = state.config.materials[material]!.hp;
    for (let lane = 0; lane < wall.laneCount; lane++) {
      if (!wall.breachedLanes[lane]) continue;
      for (const row of wall.layers) {
        if (row[lane] === null) row[lane] = { material, hp, maxHp: hp };
      }
    }
    events.push({ type: "WallRebuilt", side, mode: "breach_fill" });
  }
}
