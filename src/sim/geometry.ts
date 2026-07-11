/**
 * Arena polyline construction & baking (SPEC-3.3 §3.8).
 *
 * A level's arena is EITHER a named profile (flat/slope/angular/narrowing/
 * zigzag) OR raw vertex lists; both produce the same runtime structure.
 * expandArenaProfile turns a profile into vertex lists; bakeArena turns
 * validated vertex lists + placed objects into collider segments. The slope
 * arena is nothing special to collision — ramps are diagonal segments and
 * reflection is the standard v' = v − 2(v·n)n. That is all of
 * "reflection_only" mode; "field" mode adds slopeGradient (§3.8.4).
 */

import type {
  PanelColorMap,
  ResolvedArena,
  ResolvedObject,
} from "../config/types";
import type {
  AABB,
  ArenaRuntime,
  ArenaSegment,
  SlopeProfile,
  Vec2,
  WallObjectState,
} from "./state";

export const ARENA_W = 1280;
export const ARENA_H = 720;
export const COURT_MIN_HEIGHT = 40;

/** Flat-boundary requirement (§3.8.3): outer wall+paddle zones are rectangular. */
export const FLAT_LEFT_MAX = 180;
export const FLAT_RIGHT_MIN = 1100;

// ── profile expansion ─────────────────────────────────────────────────────────

export interface ArenaProfileInput {
  profile?: "flat" | "slope" | "angular" | "narrowing" | "zigzag";
  params?: Record<string, number>;
  top_verts?: [number, number][];
  bottom_verts?: [number, number][];
  slope_influence?: "reflection_only" | "field";
}

const v = (x: number, y: number): Vec2 => ({ x, y });

/** The control arena (SPEC-2.3.1): a pure 1280×720 rectangle. */
export function flatArena(): ResolvedArena {
  return {
    topVerts: [v(0, 0), v(ARENA_W, 0)],
    bottomVerts: [v(0, ARENA_H), v(ARENA_W, ARENA_H)],
    slope: null,
  };
}

/** Expand a profile/vertex-list arena def into resolved vertex lists (§3.8.1). */
export function expandArenaProfile(def: ArenaProfileInput): ResolvedArena {
  // Explicit geometry overrides the profile if present.
  if (def.top_verts && def.bottom_verts) {
    return {
      topVerts: def.top_verts.map(([x, y]) => v(x, y)),
      bottomVerts: def.bottom_verts.map(([x, y]) => v(x, y)),
      slope: null,
    };
  }

  const p = def.params ?? {};
  switch (def.profile) {
    case "slope": {
      const rampStartX = p.ramp_start_x ?? 280;
      const plateauStartX = p.plateau_start_x ?? 520;
      const plateauEndX = p.plateau_end_x ?? 760;
      const rampEndX = p.ramp_end_x ?? 1000;
      const H = p.slope_height ?? 120;
      const top = [
        v(0, 0), v(rampStartX, 0), v(plateauStartX, H),
        v(plateauEndX, H), v(rampEndX, 0), v(ARENA_W, 0),
      ];
      const bottom = top.map((pt) => v(pt.x, ARENA_H - pt.y));
      const slope: SlopeProfile = {
        mode: def.slope_influence ?? "reflection_only",
        rampStartX,
        plateauStartX,
        plateauEndX,
        rampEndX,
        slopeHeight: H,
      };
      return { topVerts: top, bottomVerts: bottom, slope };
    }
    case "angular": {
      const top = [v(0, 90), v(180, 90), v(430, 0), v(850, 0), v(1100, 90), v(1280, 90)];
      return { topVerts: top, bottomVerts: top.map((pt) => v(pt.x, ARENA_H - pt.y)), slope: null };
    }
    case "narrowing": {
      const top = [v(0, 0), v(180, 0), v(1100, 140), v(1280, 140)];
      return { topVerts: top, bottomVerts: top.map((pt) => v(pt.x, ARENA_H - pt.y)), slope: null };
    }
    case "zigzag": {
      const top = [
        v(0, 0), v(180, 0), v(333, 70), v(487, 0), v(640, 70),
        v(793, 0), v(947, 70), v(1100, 0), v(1280, 0),
      ];
      // Bottom teeth phase-shifted so segments are non-parallel and the
      // corridor never pinches (§2.3.5): teeth intrude where the top is flat.
      const bottom = [
        v(0, 720), v(256, 720), v(410, 650), v(563, 720), v(717, 650),
        v(870, 720), v(1023, 650), v(1100, 720), v(1280, 720),
      ];
      return { topVerts: top, bottomVerts: bottom, slope: null };
    }
    case "flat":
    default: {
      return {
        topVerts: [v(0, 0), v(ARENA_W, 0)],
        bottomVerts: [v(0, ARENA_H), v(ARENA_W, ARENA_H)],
        slope: null,
      };
    }
  }
}

// ── validation (§3.8.1) ───────────────────────────────────────────────────────

export function validateArenaGeometry(arena: ResolvedArena): string[] {
  const errors: string[] = [];
  const checkBoundary = (verts: Vec2[], name: string): void => {
    if (verts.length < 2) {
      errors.push(`${name}: needs at least 2 vertices`);
      return;
    }
    if (verts[0]!.x !== 0) errors.push(`${name}: first vertex must sit at x=0`);
    if (verts[verts.length - 1]!.x !== ARENA_W) {
      errors.push(`${name}: last vertex must sit at x=${ARENA_W}`);
    }
    for (let i = 1; i < verts.length; i++) {
      if (verts[i]!.x <= verts[i - 1]!.x) {
        errors.push(`${name}: vertices must have strictly increasing x (at index ${i})`);
      }
    }
    // Flat-zone requirement: y constant across [0,180] and [1100,1280].
    for (const [lo, hi, label] of [
      [0, FLAT_LEFT_MAX, "left"],
      [FLAT_RIGHT_MIN, ARENA_W, "right"],
    ] as const) {
      const yLo = sampleBoundaryVerts(verts, lo);
      const yHi = sampleBoundaryVerts(verts, hi);
      if (Math.abs(yLo - yHi) > 1e-6) {
        errors.push(`${name}: must be flat (y constant) across the ${label} zone [${lo}, ${hi}]`);
      }
      for (const vert of verts) {
        if (vert.x > lo && vert.x < hi && Math.abs(vert.y - yLo) > 1e-6) {
          errors.push(`${name}: vertex at x=${vert.x} breaks the flat ${label} zone`);
        }
      }
    }
  };
  checkBoundary(arena.topVerts, "top_verts");
  checkBoundary(arena.bottomVerts, "bottom_verts");

  // Court height ≥ COURT_MIN_HEIGHT everywhere (sample at every vertex x).
  const xs = new Set<number>([
    ...arena.topVerts.map((p) => p.x),
    ...arena.bottomVerts.map((p) => p.x),
  ]);
  for (const x of xs) {
    const h = sampleBoundaryVerts(arena.bottomVerts, x) - sampleBoundaryVerts(arena.topVerts, x);
    if (h < COURT_MIN_HEIGHT - 1e-6) {
      errors.push(`court height ${h.toFixed(1)} < ${COURT_MIN_HEIGHT} at x=${x}`);
    }
  }
  return errors;
}

// ── baking (§3.8.2) ───────────────────────────────────────────────────────────

function segAabb(a: Vec2, b: Vec2): AABB {
  return {
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
  };
}

function inwardNormal(a: Vec2, b: Vec2, courtCenter: Vec2): Vec2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  let nx = -dy / len;
  let ny = dx / len;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (nx * (courtCenter.x - mid.x) + ny * (courtCenter.y - mid.y) < 0) {
    nx = -nx;
    ny = -ny;
  }
  return { x: nx, y: ny };
}

/** A boundary span carrying an optional object tag; spans are split at object
 *  placements before becoming ArenaSegments. */
interface Span {
  a: Vec2;
  b: Vec2;
  kind: "boundary" | "lever" | "panel" | "oneWay";
  objectIndex: number;
}

function polylineSpans(verts: Vec2[]): Span[] {
  const spans: Span[] = [];
  for (let i = 0; i + 1 < verts.length; i++) {
    spans.push({ a: verts[i]!, b: verts[i + 1]!, kind: "boundary", objectIndex: -1 });
  }
  return spans;
}

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function polylineLen(verts: Vec2[]): number {
  let total = 0;
  for (let i = 0; i + 1 < verts.length; i++) {
    total += Math.hypot(verts[i + 1]!.x - verts[i]!.x, verts[i + 1]!.y - verts[i]!.y);
  }
  return total;
}

/**
 * Split one boundary's spans to carve out an object at arc-length fraction
 * `t` with world length `length` (§7.3: "loader converts to a concrete
 * segment split"). Objects are validated to lie within a single boundary
 * segment (design rule: not straddling a vertex), so we split exactly one
 * span into [pre, object, post].
 */
function placeObjectOnSpans(
  spans: Span[],
  t: number,
  length: number,
  kind: Span["kind"],
  objectIndex: number,
): void {
  const lengths = spans.map((s) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y));
  const total = lengths.reduce((s, l) => s + l, 0);
  const mid = t * total;
  const half = length / 2;
  let acc = 0;
  for (let i = 0; i < spans.length; i++) {
    const segLen = lengths[i]!;
    if (mid <= acc + segLen || i === spans.length - 1) {
      const span = spans[i]!;
      const localMid = mid - acc;
      const t0 = Math.max(0, (localMid - half) / segLen);
      const t1 = Math.min(1, (localMid + half) / segLen);
      const pA = lerp(span.a, span.b, t0);
      const pB = lerp(span.a, span.b, t1);
      const replacement: Span[] = [];
      if (t0 > 1e-6) replacement.push({ a: span.a, b: pA, kind: "boundary", objectIndex: -1 });
      replacement.push({ a: pA, b: pB, kind, objectIndex });
      if (t1 < 1 - 1e-6) replacement.push({ a: pB, b: span.b, kind: "boundary", objectIndex: -1 });
      spans.splice(i, 1, ...replacement);
      return;
    }
    acc += segLen;
  }
}

/**
 * Bake validated vertex lists + placed objects into collider segments and
 * the initial wall-object states. Deterministic and pure.
 */
/** One-way tiles sit as interior gates offset inward from their boundary, so
 *  a transparent pass keeps the ball in the court (the outer boundary behind
 *  the tile stays intact) — the §2.4.3 "midcourt tile" reading. */
export const ONEWAY_INSET = 44;

/** Point + inward normal at arc-length fraction t along a boundary polyline. */
function pointAtArc(verts: Vec2[], t: number): { p: Vec2; n: Vec2 } {
  const center = { x: ARENA_W / 2, y: ARENA_H / 2 };
  const spans = polylineSpans(verts);
  const lengths = spans.map((s) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y));
  const total = lengths.reduce((s, l) => s + l, 0);
  const target = t * total;
  let acc = 0;
  for (let i = 0; i < spans.length; i++) {
    if (target <= acc + lengths[i]! || i === spans.length - 1) {
      const span = spans[i]!;
      const local = (target - acc) / (lengths[i]! || 1);
      return { p: lerp(span.a, span.b, local), n: inwardNormal(span.a, span.b, center) };
    }
    acc += lengths[i]!;
  }
  return { p: verts[0]!, n: { x: 0, y: 1 } };
}

export function bakeArena(
  arena: ResolvedArena,
  objects: ResolvedObject[],
  panels: PanelColorMap,
): { runtime: ArenaRuntime; wallObjects: WallObjectState[] } {
  const center = { x: ARENA_W / 2, y: ARENA_H / 2 };
  const topSpans = polylineSpans(arena.topVerts);
  const bottomSpans = polylineSpans(arena.bottomVerts);
  const wallObjects: WallObjectState[] = [];
  const interiorSegments: { a: Vec2; b: Vec2; objectIndex: number }[] = [];

  objects.forEach((obj, index) => {
    const wo: WallObjectState = {
      index,
      kind: obj.kind,
      segmentId: -1, // filled after segment ids are assigned
      cooldownTicks: 0,
      cooldownTotal: obj.cooldownTicks,
    };
    if (obj.kind === "panel" && obj.color) {
      const def = panels[obj.color];
      if (def) {
        // Normalize — the spec's authored vectors round to 3 decimals, so
        // |v| ≈ 1.0002; a true unit dir keeps panel redirects magnitude-exact.
        const len = Math.hypot(def.dir.x, def.dir.y) || 1;
        wo.panelDir = { x: def.dir.x / len, y: def.dir.y / len };
      }
      wo.flipped = false;
    }
    if (obj.kind === "oneWay") {
      wo.blockNormal = obj.passDir === "right_to_left" ? { x: -1, y: 0 } : { x: 1, y: 0 };
      // Interior gate: endpoints along the boundary, offset inward.
      const verts = obj.boundary === "top" ? arena.topVerts : arena.bottomVerts;
      const total = polylineLen(verts);
      const half = obj.length / 2 / total;
      const a = pointAtArc(verts, Math.max(0, obj.t - half));
      const b = pointAtArc(verts, Math.min(1, obj.t + half));
      interiorSegments.push({
        a: { x: a.p.x + a.n.x * ONEWAY_INSET, y: a.p.y + a.n.y * ONEWAY_INSET },
        b: { x: b.p.x + b.n.x * ONEWAY_INSET, y: b.p.y + b.n.y * ONEWAY_INSET },
        objectIndex: index,
      });
    } else {
      // Lever / panel: split the boundary polyline in place.
      const spans = obj.boundary === "top" ? topSpans : bottomSpans;
      placeObjectOnSpans(spans, obj.t, obj.length, obj.kind, index);
    }
    wallObjects.push(wo);
  });

  const segments: ArenaSegment[] = [];
  let id = 0;
  const emit = (span: Span): void => {
    const seg: ArenaSegment = {
      id: id++,
      a: span.a,
      b: span.b,
      normal: inwardNormal(span.a, span.b, center),
      aabb: segAabb(span.a, span.b),
      kind: span.kind,
      backSide: null,
      objectIndex: span.objectIndex,
    };
    segments.push(seg);
    if (span.objectIndex >= 0) wallObjects[span.objectIndex]!.segmentId = seg.id;
  };
  topSpans.forEach(emit);
  bottomSpans.forEach(emit);
  for (const s of interiorSegments) {
    emit({ a: s.a, b: s.b, kind: "oneWay", objectIndex: s.objectIndex });
  }

  // Back boundaries (only reachable through a breach).
  const back = (a: Vec2, b: Vec2, side: "left" | "right"): void => {
    segments.push({
      id: id++,
      a,
      b,
      normal: inwardNormal(a, b, center),
      aabb: segAabb(a, b),
      kind: "back",
      backSide: side,
      objectIndex: -1,
    });
  };
  back(v(0, 0), v(0, ARENA_H), "left");
  back(v(ARENA_W, 0), v(ARENA_W, ARENA_H), "right");

  return {
    runtime: {
      segments,
      topVerts: arena.topVerts,
      bottomVerts: arena.bottomVerts,
      slope: arena.slope,
    },
    wallObjects,
  };
}

// ── samplers & slope field (§3.8.4) ───────────────────────────────────────────

export function topY(arena: ArenaRuntime, x: number): number {
  return sampleBoundaryVerts(arena.topVerts, x);
}

export function bottomY(arena: ArenaRuntime, x: number): number {
  return sampleBoundaryVerts(arena.bottomVerts, x);
}

function sampleBoundaryVerts(verts: Vec2[], x: number): number {
  if (verts.length === 0) return 0;
  const first = verts[0]!;
  if (x <= first.x) return first.y;
  for (let i = 0; i + 1 < verts.length; i++) {
    const a = verts[i]!;
    const b = verts[i + 1]!;
    if (x <= b.x) {
      const t = (x - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return verts[verts.length - 1]!.y;
}

/** dh/dx of the elevation profile (§3.8.4). >0 on the up-ramp, <0 on the
 *  down-ramp, 0 over the plateau and flat ends. */
export function slopeGradient(slope: SlopeProfile, x: number): number {
  const { rampStartX, plateauStartX, plateauEndX, rampEndX, slopeHeight: H } = slope;
  if (x >= rampStartX && x < plateauStartX) return H / (plateauStartX - rampStartX);
  if (x > plateauEndX && x <= rampEndX) return -H / (rampEndX - plateauEndX);
  return 0;
}
