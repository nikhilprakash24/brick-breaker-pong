/**
 * Swept circle vs AABB / segment (SPEC-3.3 §3.2–3.3, exact algorithms).
 * Never overlap-tested — at 3.3× cap the ball can cross a brick face in
 * under one tick without sweeping.
 */

import type { AABB, Hit, Vec2 } from "../state";

/** Slab-method ray cast of p(t) = p0 + t·d, t ∈ [0,1], vs box b (§3.2 step 2). */
export function rayVsAABB(p0: Vec2, d: Vec2, b: AABB): Hit | null {
  let tmin = 0;
  let tmax = 1;
  let nx = 0;
  let ny = 0;
  for (const axis of ["x", "y"] as const) {
    const p = p0[axis];
    const dd = d[axis];
    const lo = b.min[axis];
    const hi = b.max[axis];
    if (Math.abs(dd) < 1e-12) {
      if (p < lo || p > hi) return null; // parallel & outside slab
    } else {
      const inv = 1 / dd;
      let t1 = (lo - p) * inv;
      let t2 = (hi - p) * inv;
      let sign = -1; // hit lo face ⇒ normal −axis
      if (t1 > t2) {
        [t1, t2] = [t2, t1];
        sign = 1;
      }
      if (t1 > tmin) {
        tmin = t1;
        nx = axis === "x" ? sign : 0;
        ny = axis === "y" ? sign : 0;
      }
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  if (tmin <= 0) return null; // started inside expanded box → de-penetration (§3.4.4)
  return { t: tmin, normal: { x: nx, y: ny } };
}

/** Ray vs circle at center c, radius r (§3.2 step 3 / §3.3 endcaps). */
export function rayVsCircle(p0: Vec2, d: Vec2, c: Vec2, r: number): Hit | null {
  const mx = p0.x - c.x;
  const my = p0.y - c.y;
  const a = d.x * d.x + d.y * d.y;
  if (a < 1e-18) return null;
  const b = 2 * (mx * d.x + my * d.y);
  const cc = mx * mx + my * my - r * r;
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return null; // graze past
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t <= 0 || t > 1) return null;
  const hx = p0.x + t * d.x;
  const hy = p0.y + t * d.y;
  return { t, normal: { x: (hx - c.x) / r, y: (hy - c.y) / r } };
}

/**
 * Sweep a circle of radius r from p0 along d against box b (§3.2):
 * Minkowski-expanded slab cast + corner correction (rounded corners).
 */
export function sweepCircleVsAABB(p0: Vec2, d: Vec2, r: number, b: AABB): Hit | null {
  const expanded: AABB = {
    min: { x: b.min.x - r, y: b.min.y - r },
    max: { x: b.max.x + r, y: b.max.y + r },
  };
  const hit = rayVsAABB(p0, d, expanded);
  if (!hit) return null;
  const hx = p0.x + hit.t * d.x;
  const hy = p0.y + hit.t * d.y;
  const outsideX = hx < b.min.x || hx > b.max.x;
  const outsideY = hy < b.min.y || hy > b.max.y;
  if (outsideX && outsideY) {
    // Corner region: re-test as ray vs circle at the nearest original corner.
    const corner: Vec2 = {
      x: hx < b.min.x ? b.min.x : b.max.x,
      y: hy < b.min.y ? b.min.y : b.max.y,
    };
    return rayVsCircle(p0, d, corner, r);
  }
  return hit;
}

/**
 * Sweep a circle vs segment (a,b) with stored inward normal n (§3.3):
 * face test (line offset by r toward the approach side) + endcap tests.
 */
export function sweepCircleVsSegment(
  p0: Vec2,
  d: Vec2,
  r: number,
  a: Vec2,
  b: Vec2,
  n: Vec2,
): Hit | null {
  // Approach side: sign of the ball's offset from the segment line along n.
  const sideSign = Math.sign((p0.x - a.x) * n.x + (p0.y - a.y) * n.y) || 1;
  const ns: Vec2 = { x: n.x * sideSign, y: n.y * sideSign };
  const dDotN = d.x * ns.x + d.y * ns.y;

  let best: Hit | null = null;

  if (dDotN < 0) {
    // Moving toward the line from the ns side — face test.
    const ox = a.x + r * ns.x - p0.x;
    const oy = a.y + r * ns.y - p0.y;
    const t = (ox * ns.x + oy * ns.y) / dDotN;
    if (t > 0 && t <= 1) {
      const hx = p0.x + t * d.x;
      const hy = p0.y + t * d.y;
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const len2 = ex * ex + ey * ey;
      const proj = ((hx - a.x) * ex + (hy - a.y) * ey) / len2;
      if (proj >= 0 && proj <= 1) {
        best = { t, normal: ns };
      }
    }
  }

  // Endcap tests (face projection outside the segment, or shallow approach).
  for (const cap of [a, b]) {
    const capHit = rayVsCircle(p0, d, cap, r);
    if (capHit && (best === null || capHit.t < best.t)) best = capHit;
  }
  return best;
}
