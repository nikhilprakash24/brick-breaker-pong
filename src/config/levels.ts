/**
 * Level definitions (SPEC-3.7 §7.3, Phase 2 subset) + the wall authoring
 * grammar (SPEC-2.2 §2.2.5): each layer is an explicit array OR a run-length
 * string ("hay*2 brick*8 hay*2"), with optional "| mirror" (author half,
 * loader mirrors) or "| mirror-check" (full row, loader asserts symmetry).
 * Both forms must expand to exactly lane_count entries — fatal on mismatch.
 *
 * Deferred to later phases: arena profiles beyond flat (P3), objects (P3),
 * opponent blocks (P4), powerup pools (P5), worlds.json manifest (P6).
 */

import type { MatchConfig, MaterialDef, TuningTable } from "./types";
import {
  bool,
  enumOf,
  int,
  ms,
  validateObject,
  type FieldSpec,
  type ObjectSchema,
  type ValidationError,
} from "./validate";

export interface LevelDef {
  schema_version: number;
  id: string;
  display_name: string;
  rules: {
    lives: { left: number; right: number };
    rebuild_on_life_lost: "none" | "full" | "breach_fill";
    rebuild_material: string;
    life_loss_per_exchange: 1 | "per_ball";
    overtime_enabled: boolean;
    overtime_start: number | null; // ticks after load
    fixed_seed: number | null;
  };
  walls: {
    lane_count: number;
    left: { layers: string[][] }; // expanded: layers[0] = frontmost
    right: { layers: string[][] };
  };
}

const nonEmptyString: FieldSpec = (v, ctx) => {
  if (typeof v !== "string" || v.length === 0) {
    ctx.errors.push({
      file: ctx.file,
      path: ctx.path,
      message: `expected a non-empty string, got ${JSON.stringify(v)}`,
    });
    return undefined;
  }
  return v;
};

const nullableInt: FieldSpec = (v, ctx) => {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    ctx.errors.push({
      file: ctx.file,
      path: ctx.path,
      message: `expected an integer or null, got ${JSON.stringify(v)}`,
    });
    return undefined;
  }
  return v;
};

/** overtime_start: ms | null (per-level override, GR2-8). */
const nullableMs: FieldSpec = (v, ctx) => (v === null ? null : ms(60_000, 900_000)(v, ctx));

/**
 * Expand one authored layer (array or run-length string) to exactly
 * `laneCount` material ids (SPEC-2.2 §2.2.5). Records path-precise errors.
 */
export function expandLayerSpec(
  spec: unknown,
  laneCount: number,
  materials: Record<string, MaterialDef>,
  ctx: { file: string; path: string; errors: ValidationError[] },
): string[] | undefined {
  const fail = (message: string): undefined => {
    ctx.errors.push({ file: ctx.file, path: ctx.path, message });
    return undefined;
  };
  const checkMaterials = (row: string[]): string[] | undefined => {
    for (const m of row) {
      if (!(m in materials)) return fail(`unknown material ${JSON.stringify(m)}`);
    }
    return row;
  };

  if (Array.isArray(spec)) {
    if (spec.some((m) => typeof m !== "string")) {
      return fail("expected an array of material id strings");
    }
    const row = spec as string[];
    if (row.length !== laneCount) {
      return fail(`layer array has ${row.length} entries, expected lane_count = ${laneCount}`);
    }
    return checkMaterials(row);
  }

  if (typeof spec !== "string") {
    return fail(`expected a layer array or run-length string, got ${JSON.stringify(spec)}`);
  }

  // Optional "| mirror" / "| mirror-check" suffix.
  let body = spec;
  let mode: "plain" | "mirror" | "mirror-check" = "plain";
  const bar = spec.indexOf("|");
  if (bar !== -1) {
    body = spec.slice(0, bar).trim();
    const suffix = spec.slice(bar + 1).trim();
    if (suffix === "mirror") mode = "mirror";
    else if (suffix === "mirror-check") mode = "mirror-check";
    else return fail(`unknown layer suffix "| ${suffix}" (expected "mirror" or "mirror-check")`);
  }

  const row: string[] = [];
  for (const token of body.split(/\s+/).filter((t) => t.length > 0)) {
    const star = token.indexOf("*");
    const material = star === -1 ? token : token.slice(0, star);
    let count = 1;
    if (star !== -1) {
      const countStr = token.slice(star + 1);
      count = Number(countStr);
      if (!Number.isInteger(count) || count < 1 || String(count) !== countStr) {
        return fail(`bad run-length token ${JSON.stringify(token)} (count must be a positive integer)`);
      }
    }
    for (let i = 0; i < count; i++) row.push(material);
  }
  if (row.length === 0) return fail("empty layer string");

  if (mode === "mirror") {
    const half = Math.ceil(laneCount / 2);
    if (row.length !== half) {
      return fail(
        `"| mirror" layer authors the first ceil(lane_count/2) = ${half} lanes, got ${row.length}`,
      );
    }
    const tail = row.slice(0, laneCount - half).reverse();
    row.push(...tail);
  }

  if (row.length !== laneCount) {
    return fail(`layer expands to ${row.length} lanes, expected lane_count = ${laneCount}`);
  }
  if (mode === "mirror-check") {
    for (let i = 0; i < Math.floor(laneCount / 2); i++) {
      if (row[i] !== row[laneCount - 1 - i]) {
        return fail(
          `"| mirror-check" failed: lane ${i} (${row[i]}) != lane ${laneCount - 1 - i} (${row[laneCount - 1 - i]})`,
        );
      }
    }
  }
  return checkMaterials(row);
}

const LEVEL_RULES_SCHEMA: ObjectSchema = {
  lives: { left: int(1, 9), right: int(1, 9) },
  rebuild_on_life_lost: enumOf("none", "full", "breach_fill"),
  rebuild_material: nonEmptyString,
  life_loss_per_exchange: enumOf<1 | "per_ball">(1, "per_ball"),
  overtime_enabled: bool(),
  overtime_start: nullableMs,
  fixed_seed: nullableInt,
};

/** Validate one level file (pure; §7.9 subset for Phase 2). */
export function validateLevelJson(
  fileName: string,
  raw: unknown,
  materials: Record<string, MaterialDef>,
): { level?: LevelDef; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const cleaned = validateObject(
    fileName,
    "",
    raw,
    {
      schema_version: int(2, 2),
      id: nonEmptyString,
      display_name: nonEmptyString,
      rules: LEVEL_RULES_SCHEMA,
      walls: {
        lane_count: int(4, 24),
        left: { layers: (v) => v }, // expanded below with grammar-aware errors
        right: { layers: (v) => v },
      },
    },
    errors,
  );
  if (errors.length > 0 || cleaned === undefined) return { errors };

  const level = cleaned as unknown as LevelDef & {
    walls: { lane_count: number; left: { layers: unknown }; right: { layers: unknown } };
  };
  const laneCount = level.walls.lane_count;

  for (const side of ["left", "right"] as const) {
    const layersRaw = level.walls[side].layers;
    const path = `walls.${side}.layers`;
    if (!Array.isArray(layersRaw)) {
      errors.push({ file: fileName, path, message: "expected an array of layers" });
      continue;
    }
    if (layersRaw.length > 3) {
      // R-1.3: no level may author layer 4.
      errors.push({
        file: fileName,
        path,
        message: `${layersRaw.length} starting layers authored; max is 3 (layer 4 exists only via in-match placement, R-1.3)`,
      });
      continue;
    }
    const expanded: string[][] = [];
    layersRaw.forEach((spec, i) => {
      const row = expandLayerSpec(spec, laneCount, materials, {
        file: fileName,
        path: `${path}[${i}]`,
        errors,
      });
      if (row) expanded.push(row);
    });
    level.walls[side].layers = expanded;
  }

  // Cross-refs: rebuild material must resolve.
  if (!(level.rules.rebuild_material in materials)) {
    errors.push({
      file: fileName,
      path: "rules.rebuild_material",
      message: `unknown material ${JSON.stringify(level.rules.rebuild_material)}`,
    });
  }

  if (errors.length > 0) return { errors };
  return { level: level as LevelDef, errors };
}

/**
 * Resolve a level into the in-memory MatchConfig (§7.7). `mode` sets the
 * R-2.1 first-serve target: story = the human (left) receives; versus =
 * seeded coin flip.
 */
export function resolveMatchConfig(
  level: LevelDef,
  tuning: TuningTable,
  materials: Record<string, MaterialDef>,
  mode: "story" | "versus",
): MatchConfig {
  return {
    tuning,
    materials,
    laneCount: level.walls.lane_count,
    walls: {
      left: { layers: level.walls.left.layers.map((l) => [...l]) },
      right: { layers: level.walls.right.layers.map((l) => [...l]) },
    },
    rules: {
      lives: { ...level.rules.lives },
      rebuild_on_life_lost: level.rules.rebuild_on_life_lost,
      rebuild_material: level.rules.rebuild_material,
      life_loss_per_exchange: level.rules.life_loss_per_exchange,
      overtime_enabled: level.rules.overtime_enabled,
      overtime_start: level.rules.overtime_start,
      first_receiver: mode === "story" ? "left" : "random",
    },
  };
}
