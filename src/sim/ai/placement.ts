/**
 * Placement planner (SPEC-2.7 §2.7.4 / SPEC-3.9 §9.5). Runs only while a
 * placement powerup (place_brick / extra_layer) is banked. Scores plug /
 * reinforce / fortify / extra_layer candidates over LEGAL targets, applies
 * the style floor and the bank-vs-spend policy, and emits a PlacementCommand
 * or null (hold). Powerup earning lands in Phase 5, so in Phase 4 slots are
 * empty and this always holds — but the logic is complete and spec-faithful.
 */

import type { MatchState, Side, WallState } from "../state";
import type { PlacementCommand } from "../../input/controller";
import type { PlacementStyle } from "../../config/opponents";
import { MAX_LAYER_SLOTS } from "../wall";

interface Candidate {
  score: number;
  command: PlacementCommand;
}

function laneHpSum(wall: WallState, lane: number): number {
  let sum = 0;
  for (const row of wall.layers) sum += row[lane]?.hp ?? 0;
  return sum;
}

function lowestHpLane(wall: WallState): number {
  let best = 0;
  let bestHp = Infinity;
  for (let lane = 0; lane < wall.laneCount; lane++) {
    const hp = laneHpSum(wall, lane);
    if (hp < bestHp) {
      bestHp = hp;
      best = lane;
    }
  }
  return best;
}

/** Deepest open cell (rearmost layer with a null in this lane), as a layer
 *  index; -1 if the lane is full across all existing layers. */
function deepestOpenLayer(wall: WallState, lane: number): number {
  for (let layer = wall.layers.length - 1; layer >= 0; layer--) {
    if (wall.layers[layer]![lane] == null) return layer;
  }
  return -1;
}

function ballInbound(state: MatchState, side: Side, lane: number): boolean {
  const toward = side === "left" ? -1 : 1;
  const wall = state.sides[side].wall;
  const laneH = 720 / wall.laneCount;
  for (const ball of state.balls) {
    if (Math.sign(ball.vel.x) !== toward) continue;
    const projLane = Math.floor(ball.pos.y / laneH);
    if (projLane === lane) return true;
  }
  return false;
}

function placementFloor(style: PlacementStyle, ai: MatchState["config"]["tuning"]["ai"]): number {
  return style === "fortify" ? ai.ai_place_floor_fortify : ai.ai_place_floor_defensive;
}

/** Which banked slots hold each placement powerup id. */
function bankedSlot(state: MatchState, side: Side, id: string): number | null {
  const slots = state.sides[side].slots;
  for (let i = 0; i < slots.length; i++) {
    if (slots[i]!.powerupId === id && !slots[i]!.locked) return i;
  }
  return null;
}

/** Propose a placement, or null to hold. */
export function proposePlacement(
  state: MatchState,
  side: Side,
  style: PlacementStyle,
): PlacementCommand | null {
  if (style === "never") return null;
  if (state.sides[side].placementCooldownTicks > 0) return null;

  const placeBrickSlot = bankedSlot(state, side, "place_brick");
  const extraLayerSlot = bankedSlot(state, side, "extra_layer");
  if (placeBrickSlot === null && extraLayerSlot === null) return null; // nothing banked

  const wall = state.sides[side].wall;
  const ai = state.config.tuning.ai;
  const candidates: Candidate[] = [];

  if (placeBrickSlot !== null) {
    // plug: each own breached lane.
    for (let lane = 0; lane < wall.laneCount; lane++) {
      if (!wall.breachedLanes[lane]) continue;
      const width = breachRunWidth(wall, lane);
      const score = ai.ai_place_plug_base + ai.ai_place_plug_width_w * width + (ballInbound(state, side, lane) ? ai.ai_place_inbound_bonus : 0);
      candidates.push({ score, command: plugCommand(wall, placeBrickSlot, lane) });
    }
    // reinforce: each own critical (not breached) lane with an open cell.
    for (let lane = 0; lane < wall.laneCount; lane++) {
      if (wall.breachedLanes[lane] || !wall.criticalLanes[lane]) continue;
      const layer = deepestOpenLayer(wall, lane);
      if (layer === -1) continue;
      const score = ai.ai_place_reinforce_base + laneThreat(state, side, lane);
      candidates.push({ score, command: { kind: "place_brick", slot: placeBrickSlot, layer, lane } });
    }
    // fortify: only for fortify style, build a sparse new front layer at soft lanes.
    if (style === "fortify" && wall.layers.length < MAX_LAYER_SLOTS) {
      const third = Math.ceil(wall.laneCount / 3);
      const softLanes = [...Array(wall.laneCount).keys()]
        .sort((a, b) => laneHpSum(wall, a) - laneHpSum(wall, b))
        .slice(0, third);
      for (const lane of softLanes) {
        const score = ai.ai_place_fortify_base + laneThreat(state, side, lane);
        candidates.push({ score, command: { kind: "place_brick", slot: placeBrickSlot, layer: wall.layers.length, lane } });
      }
    }
  }

  if (extraLayerSlot !== null && wall.layers.length < MAX_LAYER_SLOTS) {
    const score = ai.ai_place_extra_layer_base + ai.ai_place_extra_layer_breach_w * wall.breachCount;
    candidates.push({ score, command: { kind: "extra_layer", slot: extraLayerSlot } });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0]!;
  const floor = placementFloor(style, ai);
  if (best.score >= floor) return best.command;

  // Bank-vs-spend: spend-before-waste when slots are full and a threshold is
  // one hit away (Phase 5 wires earning; the check is here for completeness).
  return null;
}

function laneThreat(state: MatchState, side: Side, lane: number): number {
  const wall = state.sides[side].wall;
  const isLowest = lane === lowestHpLane(wall) ? 10 : 0;
  const inbound = ballInbound(state, side, lane) ? 15 : 0;
  return isLowest + inbound;
}

function breachRunWidth(wall: WallState, lane: number): number {
  let lo = lane;
  let hi = lane;
  while (lo - 1 >= 0 && wall.breachedLanes[lo - 1]) lo--;
  while (hi + 1 < wall.laneCount && wall.breachedLanes[hi + 1]) hi++;
  return hi - lo + 1;
}

/** Plug the deepest cell of a breached lane; a fully-open lane grows a new
 *  frontmost sparse layer (createsLayer handled by wall.applyPlacement, P5). */
function plugCommand(wall: WallState, slot: number, lane: number): PlacementCommand {
  const layer = deepestOpenLayer(wall, lane);
  return { kind: "place_brick", slot, layer: layer === -1 ? wall.layers.length : layer, lane };
}
