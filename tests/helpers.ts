/**
 * Shared test fixtures: validated config from the shipped JSON files and a
 * MatchConfig builder mirroring the Phase-1 dev level, with overridable
 * walls/rules for scenario tests.
 */

import { readFileSync } from "node:fs";
import { validateMaterialsJson, validateTuningJson } from "../src/config/load";
import type { MatchConfig, MaterialDef, TuningTable } from "../src/config/types";
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

export interface MatchConfigOverrides {
  wallsLeft?: string[][];
  wallsRight?: string[][];
  laneCount?: number;
  rules?: Partial<MatchConfig["rules"]>;
  tuning?: TuningTable;
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
