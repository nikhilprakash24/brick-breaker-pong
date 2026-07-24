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

import type {
  MatchConfig,
  MaterialDef,
  PanelColorMap,
  ResolvedArena,
  ResolvedObject,
  TuningTable,
} from "./types";
import {
  bool,
  enumOf,
  int,
  ms,
  num,
  validateObject,
  type FieldSpec,
  type ObjectSchema,
  type ValidationError,
} from "./validate";
import {
  expandArenaProfile,
  validateArenaGeometry,
  type ArenaProfileInput,
} from "../sim/geometry";
import type { OpponentSelection, OpponentsTable } from "./opponents";

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
  arena: ResolvedArena; // expanded + validated
  objects: ResolvedObject[];
  opponent?: OpponentSelection; // present ⇒ story level (AI on the right)
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

const passThrough: FieldSpec = (v) => v;

/** Validate a level's optional opponent block (§7.3), cross-ref against the
 *  opponents table when available. */
function validateOpponentBlock(
  file: string,
  raw: unknown,
  opponents: OpponentsTable | undefined,
  errors: ValidationError[],
): void {
  if (typeof raw !== "object" || raw === null) {
    errors.push({ file, path: "opponent", message: "expected an opponent object" });
    return;
  }
  const o = raw as Record<string, unknown>;
  int(1, 5)(o.tier, { file, path: "opponent.tier", errors });
  if (typeof o.archetype !== "string") {
    errors.push({ file, path: "opponent.archetype", message: "expected an archetype id string" });
  } else if (opponents && !(o.archetype in opponents.archetypes)) {
    errors.push({ file, path: "opponent.archetype", message: `unknown archetype ${JSON.stringify(o.archetype)}` });
  }
}

const OBJECT_MIN_SEPARATION = 8; // u (§2.4.4)
const MAX_OBJECTS = 6;
const MAX_TRIGGERABLE = 4;

function polylineLength(verts: { x: number; y: number }[]): number {
  let total = 0;
  for (let i = 0; i + 1 < verts.length; i++) {
    total += Math.hypot(verts[i + 1]!.x - verts[i]!.x, verts[i + 1]!.y - verts[i]!.y);
  }
  return total;
}

/** Validate the arena def + placed objects (§3.8.1, §2.4.4, §7.9). */
function validateArenaAndObjects(
  fileName: string,
  rawArena: unknown,
  rawObjects: unknown,
  panels: PanelColorMap,
  errors: ValidationError[],
): { arena: ResolvedArena; objects: ResolvedObject[] } | undefined {
  if (typeof rawArena !== "object" || rawArena === null) {
    errors.push({ file: fileName, path: "arena", message: "expected an arena object" });
    return undefined;
  }
  const arena = expandArenaProfile(rawArena as ArenaProfileInput);
  for (const geoErr of validateArenaGeometry(arena)) {
    errors.push({ file: fileName, path: "arena", message: geoErr });
  }

  const objects: ResolvedObject[] = [];
  if (rawObjects !== undefined) {
    if (!Array.isArray(rawObjects)) {
      errors.push({ file: fileName, path: "objects", message: "expected an array of objects" });
    } else {
      if (rawObjects.length > MAX_OBJECTS) {
        errors.push({
          file: fileName,
          path: "objects",
          message: `${rawObjects.length} objects; max is ${MAX_OBJECTS} (SPEC-2.10)`,
        });
      }
      rawObjects.forEach((rawObj, i) => {
        const obj = validateOneObject(fileName, `objects[${i}]`, rawObj, panels, errors);
        if (obj) objects.push(obj);
      });
      const triggerable = objects.filter((o) => o.kind !== "oneWay").length;
      if (triggerable > MAX_TRIGGERABLE) {
        errors.push({
          file: fileName,
          path: "objects",
          message: `${triggerable} triggerable objects; max is ${MAX_TRIGGERABLE} (SPEC-2.10)`,
        });
      }
      // Minimum separation between objects on the same boundary (§2.4.4).
      for (const boundary of ["top", "bottom"] as const) {
        const verts = boundary === "top" ? arena.topVerts : arena.bottomVerts;
        const total = polylineLength(verts);
        const placed = objects
          .filter((o) => o.boundary === boundary)
          .map((o) => ({ start: o.t * total - o.length / 2, end: o.t * total + o.length / 2 }))
          .sort((a, b) => a.start - b.start);
        for (let i = 1; i < placed.length; i++) {
          if (placed[i]!.start - placed[i - 1]!.end < OBJECT_MIN_SEPARATION) {
            errors.push({
              file: fileName,
              path: "objects",
              message: `two ${boundary} objects are closer than the ${OBJECT_MIN_SEPARATION} u minimum separation`,
            });
          }
        }
      }
    }
  }
  return { arena, objects };
}

function validateOneObject(
  fileName: string,
  path: string,
  raw: unknown,
  panels: PanelColorMap,
  errors: ValidationError[],
): ResolvedObject | undefined {
  if (typeof raw !== "object" || raw === null) {
    errors.push({ file: fileName, path, message: "expected an object" });
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const before = errors.length;
  const type = enumOf("lever", "panel", "one_way")(o.type, { file: fileName, path: `${path}.type`, errors });
  const boundary = enumOf("top", "bottom")(o.boundary, { file: fileName, path: `${path}.boundary`, errors });
  const t = num(0, 1)(o.t, { file: fileName, path: `${path}.t`, errors });
  const length = num(20, 200)(o.length, { file: fileName, path: `${path}.length`, errors });
  if (errors.length > before) return undefined;

  const kind = type === "one_way" ? "oneWay" : (type as "lever" | "panel");
  const resolved: ResolvedObject = {
    kind,
    boundary: boundary as "top" | "bottom",
    t: t as number,
    length: length as number,
    cooldownTicks: 0,
  };
  if (kind === "panel") {
    const color = o.color;
    if (typeof color !== "string" || !(color in panels)) {
      errors.push({ file: fileName, path: `${path}.color`, message: `unknown panel color ${JSON.stringify(color)}` });
      return undefined;
    }
    resolved.color = color;
  }
  if (kind === "oneWay") {
    const pd = enumOf("left_to_right", "right_to_left")(o.pass_dir, {
      file: fileName,
      path: `${path}.pass_dir`,
      errors,
    });
    if (pd === undefined) return undefined;
    resolved.passDir = pd as "left_to_right" | "right_to_left";
  }
  if (kind === "lever" || kind === "panel") {
    const cd = ms(500, 6000)(o.cooldown_ms, { file: fileName, path: `${path}.cooldown_ms`, errors });
    if (cd === undefined) return undefined;
    resolved.cooldownTicks = cd as number;
  }
  return resolved;
}

/** Validate one level file (pure; §7.9). Panels needed for panel color refs;
 *  opponents (optional) for the story-level opponent cross-ref. */
export function validateLevelJson(
  fileName: string,
  raw: unknown,
  materials: Record<string, MaterialDef>,
  panels: PanelColorMap,
  opponents?: OpponentsTable,
): { level?: LevelDef; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const hasOpponent = typeof raw === "object" && raw !== null && "opponent" in raw;
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
        left: { layers: passThrough }, // expanded below with grammar-aware errors
        right: { layers: passThrough },
      },
      arena: passThrough, // validated + expanded below
      objects: passThrough,
      ...(hasOpponent ? { opponent: passThrough } : {}),
    },
    errors,
  );
  if (errors.length > 0 || cleaned === undefined) return { errors };

  const level = cleaned as unknown as LevelDef & {
    walls: { lane_count: number; left: { layers: unknown }; right: { layers: unknown } };
    arena: unknown;
    objects: unknown;
    opponent?: unknown;
  };

  if (hasOpponent) validateOpponentBlock(fileName, level.opponent, opponents, errors);
  const laneCount = level.walls.lane_count;

  const arenaResult = validateArenaAndObjects(fileName, level.arena, level.objects, panels, errors);

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

  if (errors.length > 0 || !arenaResult) return { errors };
  level.arena = arenaResult.arena;
  level.objects = arenaResult.objects;
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
  panels: PanelColorMap,
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
    arena: {
      topVerts: level.arena.topVerts.map((p) => ({ ...p })),
      bottomVerts: level.arena.bottomVerts.map((p) => ({ ...p })),
      slope: level.arena.slope ? { ...level.arena.slope } : null,
    },
    objects: level.objects.map((o) => ({ ...o })),
    panels,
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
