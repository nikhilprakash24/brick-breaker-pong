/**
 * Arena polyline construction (SPEC-3.3 §3.8). Phase 1 bakes the flat
 * profile only; slope/angular/narrowing/zigzag generators land in Phase 3.
 * Consecutive vertices become segments with inward normals; back boundaries
 * at x=0 / x=1280 are segments of kind "back" (collider inventory §3.1 —
 * only reachable through a breach).
 */

import type { ArenaRuntime, ArenaSegment, Vec2 } from "./state";

export const ARENA_W = 1280;
export const ARENA_H = 720;

function segAabb(a: Vec2, b: Vec2): { min: Vec2; max: Vec2 } {
  return {
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
  };
}

/** Unit normal of (a→b), flipped to point toward the court center. */
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

export function bakeFlatArena(): ArenaRuntime {
  const center = { x: ARENA_W / 2, y: ARENA_H / 2 };
  const topVerts: Vec2[] = [
    { x: 0, y: 0 },
    { x: ARENA_W, y: 0 },
  ];
  const bottomVerts: Vec2[] = [
    { x: 0, y: ARENA_H },
    { x: ARENA_W, y: ARENA_H },
  ];

  const segments: ArenaSegment[] = [];
  let id = 0;
  const push = (
    a: Vec2,
    b: Vec2,
    kind: ArenaSegment["kind"],
    backSide: ArenaSegment["backSide"],
  ): void => {
    segments.push({
      id: id++,
      a,
      b,
      normal: inwardNormal(a, b, center),
      aabb: segAabb(a, b),
      kind,
      backSide,
      objectIndex: -1,
    });
  };

  // Boundary polylines (top, bottom), then back boundaries (left, right).
  for (const verts of [topVerts, bottomVerts]) {
    for (let i = 0; i + 1 < verts.length; i++) {
      push(verts[i]!, verts[i + 1]!, "boundary", null);
    }
  }
  push({ x: 0, y: 0 }, { x: 0, y: ARENA_H }, "back", "left");
  push({ x: ARENA_W, y: 0 }, { x: ARENA_W, y: ARENA_H }, "back", "right");

  return { segments, topVerts, bottomVerts, slope: null };
}

/** Piecewise-linear boundary samplers (flat arena: constants). */
export function topY(arena: ArenaRuntime, x: number): number {
  return sampleBoundary(arena.topVerts, x);
}

export function bottomY(arena: ArenaRuntime, x: number): number {
  return sampleBoundary(arena.bottomVerts, x);
}

function sampleBoundary(verts: Vec2[], x: number): number {
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
