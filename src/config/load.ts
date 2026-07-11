/**
 * Boot-time config loading (SPEC-3.7 §7.9 / SPEC-3.1 §1.3): fetch all config
 * JSON, structurally validate, deep-freeze, return the registry. Any failure
 * is fatal with a path-precise report — there is no partial boot.
 */

import type { ConfigRegistry, MaterialDef, PanelColorMap, TuningTable } from "./types";
import { validateLevelJson, type LevelDef } from "./levels";
import {
  bool,
  ConfigError,
  enumOf,
  int,
  ms,
  num,
  numArray,
  validateObject,
  type ObjectSchema,
  type ValidationError,
} from "./validate";

/** Ranges follow the Decisions & Variables Registry §3 (canonical). */
const TUNING_SCHEMA: ObjectSchema = {
  schema_version: int(1, 1),
  physics: {
    ball_radius: num(5, 10),
    ball_base_speed: num(300, 560),
    ball_min_vx_frac: num(0.15, 0.35),
    max_bounce_angle: num(45, 72),
    sweet_spot_bonus_angle: num(0, 8),
    steering_angle_cap: num(60, 80),
    english_factor: num(0, 0.35),
    ball_max_speed_mult: num(2.5, 4.0),
    ball_min_speed_mult: num(0.5, 1.0),
    max_balls: int(1, 8),
    max_bounces_per_tick: int(4, 16),
    skin_eps: num(0.001, 0.1),
    backface_mode: enumOf("reflect", "reflect+boost"),
    backface_speed_scale_base: num(1.0, 1.15),
    slope_accel: num(0, 1200),
  },
  rally: {
    rally_cap_hits: int(1, 20),
    speed_curve: numArray({ length: 11, min: 1.0, max: 3.3, monotone: true }),
    powerup_threshold_minor: int(2, 5),
    powerup_threshold_medium: int(4, 8),
    powerup_threshold_major: int(7, 10),
    overheat_period: int(0, 6),
    rally_counter_scope: enumOf("global", "per_ball"),
  },
  wall: {
    brick_depth: num(16, 30),
    default_lane_count: int(4, 24),
    lane_critical_hp: int(1, 2),
    placement_window: ms(1000, 5000),
    placement_timescale: num(0.1, 1.0),
    placement_cooldown: ms(0, 10_000),
    placement_cancel_cooldown: ms(4000, 15_000),
    pending_timeout: ms(1000, 6000),
  },
  rules: {
    intro_duration: ms(1000, 5000),
    serve_delay: ms(500, 2000),
    serve_angle_max: num(10, 40),
    life_lost_seq: ms(500, 2000),
    lives_start: int(1, 9),
    life_loss_per_exchange: enumOf<1 | "per_ball">(1, "per_ball"),
    overtime_enabled: bool(),
    overtime_start: ms(180_000, 600_000),
    overtime_tick_period: ms(5000, 30_000),
    stall_soft_timeout: ms(4000, 30_000),
    stall_nudge_accel: num(20, 200),
    stall_hard_timeout: ms(4000, 30_000),
  },
  paddle: {
    paddle_half_height: num(30, 90),
    paddle_speed: num(240, 560),
    paddle_width: num(10, 24),
    paddle_plane_x_left: num(140, 140),
    paddle_plane_x_right: num(1140, 1140),
    slot_count: int(1, 4),
    max_slots: int(4, 4),
  },
  powerups: {
    pu_shield_cap: int(1, 3),
    pu_sticky_hold_max: ms(500, 3000),
  },
  loadout: {
    wall_budget: int(8, 40),
    anchor_cost_coeff: int(1, 4),
    reinforce_cost_coeff: int(1, 5),
    formations: {
      formation_cost_even: int(0, 0),
      formation_cost_bulwark: int(0, 10),
      formation_cost_picket: int(0, 12),
      formation_cost_gate: int(-6, 0),
    },
  },
  ai: {
    ai_predict_max_ticks: int(240, 1200),
    ai_spray_range: num(0.5, 1.0),
    ai_focus_w_hp: num(0, 100),
    ai_focus_w_adj: num(0, 100),
    ai_focus_w_persist: num(0, 100),
    ai_focus_w_infeas: num(0, 100),
    ai_focus_switch_delta: int(1, 4),
    ai_denial_candidates: numArray({ length: 3, min: -1, max: 1 }),
    ai_place_plug_base: num(0, 1000),
    ai_place_plug_width_w: num(0, 1000),
    ai_place_inbound_bonus: num(0, 1000),
    ai_place_reinforce_base: num(0, 1000),
    ai_place_fortify_base: num(0, 1000),
    ai_place_extra_layer_base: num(0, 1000),
    ai_place_extra_layer_breach_w: num(0, 1000),
    ai_place_floor_defensive: num(0, 1000),
    ai_place_floor_fortify: num(0, 1000),
    ai_place_fallback_score: num(0, 1000),
    ai_spend_before_waste_frac: num(0.3, 1.0),
    ai_panic_react_floor_ms: num(0, 2000),
    ai_panic_arrival_s: num(0.5, 3.0),
    rubber_band_enabled: bool(),
    rubber_band_gain: num(0.05, 0.3),
    rubber_band_clamp: numArray({ length: 2, min: 0.5, max: 2 }),
  },
  audio: {
    music_layer_thresholds: numArray({ length: 4, min: 0, max: 20, monotone: true }),
    sfx_pitch_jitter: num(0, 0.2),
    sfx_voice_cap: int(8, 32),
    duck_hitstop_db: num(0, 6),
    duck_release_ms: int(100, 500),
  },
  juice: {
    hit_stop_brick_destroy: int(0, 6),
    hit_stop_breach: int(0, 12),
    hit_stop_life: int(0, 12),
    damage_state_thresholds: numArray({ length: 2, min: 0, max: 1 }),
  },
  render: {
    arena_logical_w: int(1280, 1280),
    arena_logical_h: int(720, 720),
    particle_cap: int(100, 1000),
    trail_len: int(4, 20),
  },
  perf: {
    sim_budget_ms_frame: num(0.5, 20),
    render_budget_ms_frame: num(0.5, 20),
  },
};

async function fetchJson(baseUrl: string, file: string, errors: ValidationError[]): Promise<unknown> {
  const url = baseUrl + "config/data/" + file;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    errors.push({ file, path: "(fetch)", message: `network error fetching ${url}: ${String(e)}` });
    return undefined;
  }
  if (!res.ok) {
    errors.push({ file, path: "(fetch)", message: `HTTP ${res.status} fetching ${url}` });
    return undefined;
  }
  try {
    return await res.json();
  } catch (e) {
    errors.push({ file, path: "(parse)", message: `invalid JSON: ${String(e)}` });
    return undefined;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Cross-field checks that single-field ranges can't express (§7.9, registry audit rules). */
function crossValidateTuning(t: TuningTable, errors: ValidationError[]): void {
  const file = "tuning.json";
  const capRad = (t.physics.steering_angle_cap * Math.PI) / 180;
  if (Math.cos(capRad) <= t.physics.ball_min_vx_frac) {
    errors.push({
      file,
      path: "physics.steering_angle_cap",
      message: `audit failed: cos(steering_angle_cap) = ${Math.cos(capRad).toFixed(3)} must exceed ball_min_vx_frac = ${t.physics.ball_min_vx_frac} (GR2-5)`,
    });
  }
  const { powerup_threshold_minor: minor, powerup_threshold_medium: medium, powerup_threshold_major: major } = t.rally;
  if (!(minor < medium && medium < major && major <= t.rally.rally_cap_hits)) {
    errors.push({
      file,
      path: "rally.powerup_threshold_minor",
      message: `powerup thresholds must be strictly increasing and <= rally_cap_hits, got [${minor}, ${medium}, ${major}] vs cap ${t.rally.rally_cap_hits}`,
    });
  }
  const curveCap = t.rally.speed_curve[t.rally.speed_curve.length - 1];
  if (curveCap !== undefined && t.physics.ball_max_speed_mult < curveCap) {
    errors.push({
      file,
      path: "physics.ball_max_speed_mult",
      message: `must stay >= speed_curve cap (${curveCap})`,
    });
  }
}

/** materials.json (§7.2): { schema_version, materials: { id → MaterialDef } }. */
export function validateMaterialsJson(raw: unknown): {
  materials?: Record<string, MaterialDef>;
  errors: ValidationError[];
} {
  const file = "materials.json";
  const errors: ValidationError[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push({ file, path: "(root)", message: `expected an object, got ${JSON.stringify(raw)}` });
    return { errors };
  }
  const obj = raw as Record<string, unknown>;
  int(1, 1)(obj.schema_version, { file, path: "schema_version", errors });
  const table = obj.materials;
  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    errors.push({ file, path: "materials", message: "expected an object of material defs" });
    return { errors };
  }
  const out: Record<string, MaterialDef> = {};
  const entries = table as Record<string, unknown>;
  if (Object.keys(entries).length === 0) {
    errors.push({ file, path: "materials", message: "expected at least one material" });
  }
  for (const id of Object.keys(entries)) {
    const cleaned = validateObject(
      file,
      `materials.${id}`,
      entries[id],
      {
        hp: int(1, 99),
        display_name: (v, ctx) =>
          typeof v === "string" && v.length > 0
            ? v
            : (ctx.errors.push({ file: ctx.file, path: ctx.path, message: `expected a non-empty string, got ${JSON.stringify(v)}` }),
              undefined),
        tier: int(0, 9),
      },
      errors,
    );
    if (cleaned) out[id] = cleaned as unknown as MaterialDef;
  }
  if (errors.length > 0) return { errors };
  return { materials: out, errors };
}

/** panels.json (SPEC-2.4 §5.2): global color→direction map. */
export function validatePanelsJson(raw: unknown): {
  panels?: PanelColorMap;
  errors: ValidationError[];
} {
  const file = "panels.json";
  const errors: ValidationError[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push({ file, path: "(root)", message: `expected an object, got ${JSON.stringify(raw)}` });
    return { errors };
  }
  const obj = raw as Record<string, unknown>;
  int(1, 1)(obj.schema_version, { file, path: "schema_version", errors });
  const table = obj.panels;
  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    errors.push({ file, path: "panels", message: "expected an object of panel color defs" });
    return { errors };
  }
  const out: PanelColorMap = {};
  const entries = table as Record<string, unknown>;
  for (const id of Object.keys(entries)) {
    const def = entries[id];
    if (typeof def !== "object" || def === null) {
      errors.push({ file, path: `panels.${id}`, message: "expected a panel def" });
      continue;
    }
    const d = def as Record<string, unknown>;
    const glyph = d.glyph;
    const dir = d.dir;
    if (typeof glyph !== "string" || glyph.length === 0) {
      errors.push({ file, path: `panels.${id}.glyph`, message: "expected a non-empty string" });
    }
    if (
      !Array.isArray(dir) ||
      dir.length !== 2 ||
      typeof dir[0] !== "number" ||
      typeof dir[1] !== "number"
    ) {
      errors.push({ file, path: `panels.${id}.dir`, message: "expected [x, y] numbers" });
      continue;
    }
    const mag = Math.hypot(dir[0], dir[1]);
    if (Math.abs(mag - 1) > 1e-2) {
      errors.push({ file, path: `panels.${id}.dir`, message: `direction must be ~unit length, |v| = ${mag.toFixed(3)}` });
    }
    if (typeof glyph === "string") out[id] = { glyph, dir: { x: dir[0], y: dir[1] } };
  }
  if (errors.length > 0) return { errors };
  return { panels: out, errors };
}

/** Pure validation entry point (unit-tested per §12.1). */
export function validateTuningJson(raw: unknown): {
  tuning?: TuningTable;
  errors: ValidationError[];
} {
  const errors: ValidationError[] = [];
  const cleaned = validateObject("tuning.json", "", raw, TUNING_SCHEMA, errors);
  if (errors.length > 0 || cleaned === undefined) return { errors };
  const tuning = cleaned as unknown as TuningTable;
  crossValidateTuning(tuning, errors);
  if (errors.length > 0) return { errors };
  return { tuning, errors };
}

/**
 * Fetch + validate + freeze (SPEC-3.1 §1.3). Rejects with ConfigError carrying
 * every path-precise finding; the caller renders the report (app FSM A2).
 */
/** Level files shipped this phase; replaced by the worlds.json manifest (P6). */
const LEVEL_FILES = [
  "dev-flat.json",
  "dev-asym.json",
  "dev-slope.json",
  "dev-angular.json",
  "dev-narrowing.json",
  "dev-zigzag.json",
];

export async function loadConfig(baseUrl: string): Promise<ConfigRegistry> {
  const errors: ValidationError[] = [];
  const [rawTuning, rawMaterials, rawPanels, ...rawLevels] = await Promise.all([
    fetchJson(baseUrl, "tuning.json", errors),
    fetchJson(baseUrl, "materials.json", errors),
    fetchJson(baseUrl, "panels.json", errors),
    ...LEVEL_FILES.map((f) => fetchJson(baseUrl, "levels/" + f, errors)),
  ]);
  if (errors.length > 0) throw new ConfigError(errors);
  const tuningResult = validateTuningJson(rawTuning);
  const materialsResult = validateMaterialsJson(rawMaterials);
  const panelsResult = validatePanelsJson(rawPanels);
  const all = [...tuningResult.errors, ...materialsResult.errors, ...panelsResult.errors];
  const levels: Record<string, LevelDef> = {};
  if (materialsResult.materials && panelsResult.panels) {
    rawLevels.forEach((raw, i) => {
      const file = "levels/" + LEVEL_FILES[i]!;
      const { level, errors: levelErrors } = validateLevelJson(
        file,
        raw,
        materialsResult.materials!,
        panelsResult.panels!,
      );
      all.push(...levelErrors);
      if (level) {
        if (levels[level.id]) {
          all.push({ file, path: "id", message: `duplicate level id "${level.id}"` });
        }
        levels[level.id] = level;
      }
    });
  }
  if (all.length > 0 || !tuningResult.tuning || !materialsResult.materials || !panelsResult.panels) {
    throw new ConfigError(all);
  }
  return deepFreeze({
    tuning: tuningResult.tuning,
    materials: materialsResult.materials,
    panels: panelsResult.panels,
    levels,
  });
}
