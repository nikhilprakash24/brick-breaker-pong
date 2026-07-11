/**
 * Phase 1 dev match assembly — stands in for the level→MatchConfig
 * resolution chain (SPEC-3.7 §7.7) until level JSON lands in Phase 2.
 * A symmetric 2-layer siege wall: brick front row over a hay backing.
 */

import type { ConfigRegistry, MatchConfig } from "../config/types";

export function devMatchConfig(registry: ConfigRegistry): MatchConfig {
  const laneCount = registry.tuning.wall.default_lane_count;
  const layers = [
    Array.from({ length: laneCount }, () => "brick"), // frontmost
    Array.from({ length: laneCount }, () => "hay"),
  ];
  return {
    tuning: registry.tuning,
    materials: registry.materials,
    laneCount,
    walls: {
      left: { layers: layers.map((l) => [...l]) },
      right: { layers: layers.map((l) => [...l]) },
    },
    rules: {
      lives: { left: 3, right: 3 },
      rebuild_on_life_lost: "none",
      rebuild_material: "hay",
      life_loss_per_exchange: 1,
      overtime_enabled: true,
      overtime_start: null,
      first_receiver: "random",
    },
  };
}
