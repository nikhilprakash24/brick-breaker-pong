/**
 * Shared test fixtures: validated config from the shipped JSON files and a
 * MatchConfig builder mirroring the Phase-1 dev level, with overridable
 * walls/rules for scenario tests.
 */

import { readFileSync } from "node:fs";
import {
  validateMaterialsJson,
  validatePanelsJson,
  validateTuningJson,
} from "../src/config/load";
import type {
  MatchConfig,
  MaterialDef,
  PanelColorMap,
  TuningTable,
} from "../src/config/types";
import {
  resolveOpponent,
  validateOpponentsJson,
  type OpponentsTable,
  type ResolvedOpponent,
} from "../src/config/opponents";
import { neutralSideInput, type SideInput, type TickInputs } from "../src/input/controller";

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf-8"));
}

export const tuning: TuningTable = (() => {
  const { tuning, errors } = validateTuningJson(readJson("../src/config/data/tuning.json"));
  if (!tuning) throw new Error("tuning fixture invalid: " + JSON.stringify(errors));
  return tuning;
})();

export const materials: Record<string, MaterialDef> = (() => {
  const { materials, errors } = validateMaterialsJson(
    readJson("../src/config/data/materials.json"),
  );
  if (!materials) throw new Error("materials fixture invalid: " + JSON.stringify(errors));
  return materials;
})();

export const panels: PanelColorMap = (() => {
  const { panels, errors } = validatePanelsJson(readJson("../src/config/data/panels.json"));
  if (!panels) throw new Error("panels fixture invalid: " + JSON.stringify(errors));
  return panels;
})();

export const opponents: OpponentsTable = (() => {
  const { opponents, errors } = validateOpponentsJson(readJson("../src/config/data/opponents.json"));
  if (!opponents) throw new Error("opponents fixture invalid: " + JSON.stringify(errors));
  return opponents;
})();

/** Resolve an archetype@tier into a ResolvedOpponent (base half-height from tuning). */
export function opponent(archetype: string, tier: number): ResolvedOpponent {
  return resolveOpponent({ tier, archetype }, opponents, {
    paddleHalfHeight: tuning.paddle.paddle_half_height,
  });
}

/** A MatchConfig with the given opponent's physical paddle on the RIGHT. */
export function aiMatchConfig(
  opp: ResolvedOpponent,
  overrides: MatchConfigOverrides = {},
): MatchConfig {
  const cfg = testMatchConfig(overrides);
  cfg.paddles = { right: opp.paddle };
  return cfg;
}

export interface MatchConfigOverrides {
  wallsLeft?: string[][];
  wallsRight?: string[][];
  laneCount?: number;
  rules?: Partial<MatchConfig["rules"]>;
  tuning?: TuningTable;
  arena?: MatchConfig["arena"];
  objects?: MatchConfig["objects"];
}

export function testMatchConfig(overrides: MatchConfigOverrides = {}): MatchConfig {
  const t = overrides.tuning ?? tuning;
  const laneCount = overrides.laneCount ?? t.wall.default_lane_count;
  const filled = (m: string): string[] => Array.from({ length: laneCount }, () => m);
  return {
    tuning: t,
    materials,
    laneCount,
    walls: {
      left: { layers: overrides.wallsLeft ?? [filled("brick"), filled("hay")] },
      right: { layers: overrides.wallsRight ?? [filled("brick"), filled("hay")] },
    },
    arena: overrides.arena ?? {
      topVerts: [{ x: 0, y: 0 }, { x: 1280, y: 0 }],
      bottomVerts: [{ x: 0, y: 720 }, { x: 1280, y: 720 }],
      slope: null,
    },
    objects: overrides.objects ?? [],
    panels,
    rules: {
      lives: { left: 3, right: 3 },
      rebuild_on_life_lost: "none",
      rebuild_material: "hay",
      life_loss_per_exchange: 1,
      overtime_enabled: true,
      overtime_start: null,
      first_receiver: "left",
      ...overrides.rules,
    },
  };
}

export function neutralInputs(): TickInputs {
  return { left: neutralSideInput(), right: neutralSideInput() };
}

export function moveInputs(left: -1 | 0 | 1, right: -1 | 0 | 1): TickInputs {
  const mk = (m: -1 | 0 | 1): SideInput => {
    const s = neutralSideInput();
    s.paddles[0]!.move = m;
    return s;
  };
  return { left: mk(left), right: mk(right) };
}
