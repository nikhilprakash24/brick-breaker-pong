/**
 * Opponent archetypes (SPEC-3.7 §7.4) + the tier→archetype→override merge
 * (SPEC-2.7 §2.7.2/§2.7.5). Difficulty is behaviour, never cheating: every
 * value here feeds either the physical paddle layout (sim-side, MatchConfig)
 * or the AiController's behaviour (controller-side, ResolvedOpponent) — no
 * value grants the AI anything the sim wouldn't grant a human archetype.
 */

import type { PaddleLayout } from "./types";
import { int, num, type ValidationError } from "./validate";

export type Targeting = "spray" | "focus" | "breach" | "denial";
export type Station = "center" | "denial";
export type PlacementStyle = "never" | "defensive" | "fortify";
export type PowerupStyle = "reactive" | "eager";

/** Fully-resolved opponent: physical paddle layout + AI behaviour. */
export interface ResolvedOpponent {
  paddle: PaddleLayout;
  perception: { reactionMs: number; aimNoiseU: number; replanMs: number };
  targeting: Targeting;
  station: Station;
  placement: { style: PlacementStyle; reactMs: number | null };
  powerup: { style: PowerupStyle; minHoldMs: number };
  offsetFlip: boolean;
}

// ── raw JSON shapes ───────────────────────────────────────────────────────────

interface TierDef {
  perception: { reaction_ms: number; aim_noise_u: number; replan_ms: number };
  paddle: { speed: number };
  targeting: Targeting;
  station: Station;
  placement: { style: PlacementStyle; react_ms?: number };
  powerup_use: { style: PowerupStyle; min_hold_ms: number };
}

interface ArchetypePerception {
  reaction_ms?: number; // absolute override
  aim_noise_u?: number; // absolute override
  reaction_ms_delta?: number; // additive on the tier
  aim_noise_mult?: number; // multiplicative on the tier
  replan_ms?: number;
}

interface ArchetypeDef {
  paddle: {
    half_height: number;
    speed: number;
    count: 1 | 2;
    offset: number;
    split_gap?: number;
    offset_flip?: boolean;
  };
  perception?: ArchetypePerception;
  targeting?: Targeting;
  station?: Station;
  placement?: { style: PlacementStyle; react_ms?: number };
  powerup_use?: { style: PowerupStyle; min_hold_ms: number };
}

export interface OpponentsTable {
  tiers: Record<string, TierDef>;
  archetypes: Record<string, ArchetypeDef>;
}

/** A level's opponent selection (SPEC-3.7 §7.3). */
export interface OpponentSelection {
  tier: number; // 1–5 → key "T"+tier
  archetype: string;
  overrides?: Partial<{
    aim_noise_u: number;
    reaction_ms: number;
    speed: number;
    half_height: number;
  }>;
}

// ── validation ────────────────────────────────────────────────────────────────

const TARGETINGS: Targeting[] = ["spray", "focus", "breach", "denial"];
const STATIONS: Station[] = ["center", "denial"];
const STYLES: PlacementStyle[] = ["never", "defensive", "fortify"];
const PU_STYLES: PowerupStyle[] = ["reactive", "eager"];

export function validateOpponentsJson(raw: unknown): {
  opponents?: OpponentsTable;
  errors: ValidationError[];
} {
  const file = "opponents.json";
  const errors: ValidationError[] = [];
  const push = (path: string, message: string): void => {
    errors.push({ file, path, message });
  };

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    push("(root)", "expected an object");
    return { errors };
  }
  const obj = raw as Record<string, unknown>;
  int(1, 1)(obj.schema_version, { file, path: "schema_version", errors });

  const tiers = obj.tiers;
  if (typeof tiers !== "object" || tiers === null) {
    push("tiers", "expected an object of tier defs");
    return { errors };
  }
  for (const key of ["T1", "T2", "T3", "T4", "T5"]) {
    if (!(key in (tiers as object))) push(`tiers.${key}`, "missing required tier");
  }
  for (const [key, def] of Object.entries(tiers as Record<string, unknown>)) {
    validateTier(file, `tiers.${key}`, def, errors);
  }

  const archetypes = obj.archetypes;
  if (typeof archetypes !== "object" || archetypes === null) {
    push("archetypes", "expected an object of archetype defs");
    return { errors };
  }
  for (const [key, def] of Object.entries(archetypes as Record<string, unknown>)) {
    validateArchetype(file, `archetypes.${key}`, def, errors);
  }

  if (errors.length > 0) return { errors };
  return { opponents: raw as unknown as OpponentsTable, errors };
}

function enumField(
  file: string,
  path: string,
  v: unknown,
  allowed: readonly string[],
  errors: ValidationError[],
): void {
  if (typeof v !== "string" || !allowed.includes(v)) {
    errors.push({ file, path, message: `expected one of ${allowed.join(" | ")}, got ${JSON.stringify(v)}` });
  }
}

function validateTier(file: string, path: string, def: unknown, errors: ValidationError[]): void {
  if (typeof def !== "object" || def === null) {
    errors.push({ file, path, message: "expected a tier object" });
    return;
  }
  const d = def as Record<string, unknown>;
  const p = (d.perception ?? {}) as Record<string, unknown>;
  num(50, 600)(p.reaction_ms, { file, path: `${path}.perception.reaction_ms`, errors });
  num(0, 60)(p.aim_noise_u, { file, path: `${path}.perception.aim_noise_u`, errors });
  num(50, 800)(p.replan_ms, { file, path: `${path}.perception.replan_ms`, errors });
  const paddle = (d.paddle ?? {}) as Record<string, unknown>;
  // GR2-10 traversal floor: 720 / speed ≥ 1.5 s ⇒ speed ≤ 480.
  num(200, 480)(paddle.speed, { file, path: `${path}.paddle.speed`, errors });
  enumField(file, `${path}.targeting`, d.targeting, TARGETINGS, errors);
  enumField(file, `${path}.station`, d.station, STATIONS, errors);
  const pl = (d.placement ?? {}) as Record<string, unknown>;
  enumField(file, `${path}.placement.style`, pl.style, STYLES, errors);
  const pu = (d.powerup_use ?? {}) as Record<string, unknown>;
  enumField(file, `${path}.powerup_use.style`, pu.style, PU_STYLES, errors);
  num(100, 4000)(pu.min_hold_ms, { file, path: `${path}.powerup_use.min_hold_ms`, errors });
}

function validateArchetype(file: string, path: string, def: unknown, errors: ValidationError[]): void {
  if (typeof def !== "object" || def === null) {
    errors.push({ file, path, message: "expected an archetype object" });
    return;
  }
  const d = def as Record<string, unknown>;
  const paddle = (d.paddle ?? {}) as Record<string, unknown>;
  num(30, 90)(paddle.half_height, { file, path: `${path}.paddle.half_height`, errors });
  num(200, 480)(paddle.speed, { file, path: `${path}.paddle.speed`, errors });
  if (paddle.count !== 1 && paddle.count !== 2) {
    errors.push({ file, path: `${path}.paddle.count`, message: "expected 1 or 2" });
  }
  num(-160, 160)(paddle.offset, { file, path: `${path}.paddle.offset`, errors });
  if (paddle.count === 2) {
    num(40, 240)(paddle.split_gap, { file, path: `${path}.paddle.split_gap`, errors });
  }
  if (d.targeting !== undefined) enumField(file, `${path}.targeting`, d.targeting, TARGETINGS, errors);
  if (d.station !== undefined) enumField(file, `${path}.station`, d.station, STATIONS, errors);
}

// ── merge (tier → archetype → override) ───────────────────────────────────────

/**
 * A tier's pure baseline (no archetype deltas): the §2.7.2 ladder row on a
 * standard body. This is what the §2.9.2 monotonicity gate compares — an
 * archetype's targeting ceiling (e.g. warden = focus) would otherwise mask
 * exactly the tier separation being measured.
 */
export function resolveTierPure(
  tier: number,
  table: OpponentsTable,
  base: { paddleHalfHeight: number },
): ResolvedOpponent {
  const t = table.tiers[`T${tier}`];
  if (!t) throw new Error(`unknown tier T${tier}`);
  return {
    paddle: {
      count: 1,
      halfHeight: base.paddleHalfHeight,
      speed: t.paddle.speed,
      offset: 0,
      splitGap: 0,
    },
    perception: {
      reactionMs: t.perception.reaction_ms,
      aimNoiseU: t.perception.aim_noise_u,
      replanMs: t.perception.replan_ms,
    },
    targeting: t.targeting,
    station: t.station,
    placement: {
      style: t.placement.style,
      reactMs: t.placement.style === "never" ? null : (t.placement.react_ms ?? 1000),
    },
    powerup: { style: t.powerup_use.style, minHoldMs: t.powerup_use.min_hold_ms },
    offsetFlip: false,
  };
}

/**
 * Resolve a level's opponent selection into a ResolvedOpponent. Merge order
 * per SPEC-2.7 §2.7.5 / SPEC-3.7 §7.3: tier baseline, archetype deltas
 * (absolute paddle stats override; perception may override or delta), then
 * shallow per-level overrides.
 */
export function resolveOpponent(
  selection: OpponentSelection,
  table: OpponentsTable,
  base: { paddleHalfHeight: number },
): ResolvedOpponent {
  const tierKey = `T${selection.tier}`;
  const tier = table.tiers[tierKey];
  if (!tier) throw new Error(`unknown tier ${tierKey}`);
  const arch = table.archetypes[selection.archetype];
  if (!arch) throw new Error(`unknown archetype ${selection.archetype}`);
  const ov = selection.overrides ?? {};

  const ap = arch.perception ?? {};
  let reactionMs = ap.reaction_ms ?? tier.perception.reaction_ms + (ap.reaction_ms_delta ?? 0);
  let aimNoiseU = ap.aim_noise_u ?? tier.perception.aim_noise_u * (ap.aim_noise_mult ?? 1);
  const replanMs = ap.replan_ms ?? tier.perception.replan_ms;
  if (ov.reaction_ms !== undefined) reactionMs = ov.reaction_ms;
  if (ov.aim_noise_u !== undefined) aimNoiseU = ov.aim_noise_u;

  const paddle: PaddleLayout = {
    count: arch.paddle.count,
    halfHeight: ov.half_height ?? arch.paddle.half_height ?? base.paddleHalfHeight,
    speed: ov.speed ?? arch.paddle.speed ?? tier.paddle.speed,
    offset: arch.paddle.offset ?? 0,
    splitGap: arch.paddle.split_gap ?? 0,
  };

  const placementStyle = arch.placement?.style ?? tier.placement.style;
  const placementReactMs =
    placementStyle === "never"
      ? null
      : (arch.placement?.react_ms ?? tier.placement.react_ms ?? 1000);

  const powerup = arch.powerup_use ?? tier.powerup_use;

  return {
    paddle,
    perception: { reactionMs, aimNoiseU, replanMs },
    targeting: arch.targeting ?? tier.targeting,
    station: arch.station ?? tier.station,
    placement: { style: placementStyle, reactMs: placementReactMs },
    powerup: { style: powerup.style, minHoldMs: powerup.min_hold_ms },
    offsetFlip: arch.paddle.offset_flip ?? false,
  };
}
