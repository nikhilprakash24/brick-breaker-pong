/**
 * Powerup firing policy (SPEC-3.9 §9.6). `reactive`: fire defensive powerups
 * when own breachCount > 0 or a ball is inbound to a breached lane; fire
 * offensive when the opponent has a critical/breached lane and self is
 * stable. `eager`: fire ASAP after minHoldMs. Placement powerups are NEVER
 * fired here — they go through the PlacementPlanner (§9.5). Dormant until
 * powerup earning lands in Phase 5.
 */

import type { MatchState, Side } from "../state";
import { otherSide } from "../state";
import type { PowerupStyle } from "../../config/opponents";

const PLACEMENT_IDS = new Set(["place_brick", "extra_layer"]);
const DEFENSIVE_IDS = new Set(["shield", "slow_ball", "repair"]);
const OFFENSIVE_IDS = new Set(["fast_ball", "heavy_ball", "multi_ball", "extra_ball"]);

export function chooseActivation(
  state: MatchState,
  side: Side,
  style: PowerupStyle,
): number | null {
  const slots = state.sides[side].slots;
  const own = state.sides[side].wall;
  const opp = state.sides[otherSide(side)].wall;
  const selfStable = own.breachCount === 0;

  // Highest slot index first ≈ most recently earned; "highest-tier applicable"
  // is refined once powerup tiers are wired (Phase 5).
  for (let i = slots.length - 1; i >= 0; i--) {
    const id = slots[i]!.powerupId;
    if (id === null || slots[i]!.locked || PLACEMENT_IDS.has(id)) continue;

    if (style === "eager") return i;

    // reactive
    if (DEFENSIVE_IDS.has(id) && own.breachCount > 0) return i;
    if (OFFENSIVE_IDS.has(id) && selfStable && (opp.breachCount > 0 || opp.criticalLanes.some(Boolean))) {
      return i;
    }
  }
  return null;
}
