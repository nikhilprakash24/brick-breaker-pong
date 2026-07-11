/**
 * Swept-collision primitives (SPEC-3.12 §12.1 coverage contract):
 * slab cases, corner-region circle correction, start-inside, graze-miss,
 * t exactness vs analytic fixtures; segment face + endcap.
 */

import { describe, expect, it } from "vitest";
import { rayVsAABB, sweepCircleVsAABB, sweepCircleVsSegment } from "../src/sim/physics/sweep";
import type { AABB } from "../src/sim/state";

const box: AABB = { min: { x: 10, y: 10 }, max: { x: 20, y: 20 } };

describe("rayVsAABB (slab method)", () => {
  it("hits a face head-on with exact t and outward normal", () => {
    const hit = rayVsAABB({ x: 0, y: 15 }, { x: 20, y: 0 }, box);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(0.5, 10); // reaches x=10 at t=0.5
    expect(hit!.normal).toEqual({ x: -1, y: 0 });
  });

  it("hits the hi face with +normal", () => {
    const hit = rayVsAABB({ x: 30, y: 15 }, { x: -20, y: 0 }, box);
    expect(hit!.t).toBeCloseTo(0.5, 10);
    expect(hit!.normal).toEqual({ x: 1, y: 0 });
  });

  it("axis-parallel ray outside the slab misses", () => {
    expect(rayVsAABB({ x: 0, y: 25 }, { x: 40, y: 0 }, box)).toBeNull();
  });

  it("diagonal hit picks the later slab entry (correct face)", () => {
    const hit = rayVsAABB({ x: 0, y: 14 }, { x: 20, y: 2 }, box);
    expect(hit!.normal).toEqual({ x: -1, y: 0 });
  });

  it("returns null when starting inside (de-penetration territory)", () => {
    expect(rayVsAABB({ x: 15, y: 15 }, { x: 20, y: 0 }, box)).toBeNull();
  });

  it("misses when the segment stops short (t > 1)", () => {
    expect(rayVsAABB({ x: 0, y: 15 }, { x: 5, y: 0 }, box)).toBeNull();
  });
});

describe("sweepCircleVsAABB (Minkowski + corner correction)", () => {
  const r = 5;

  it("face hit accounts for the radius", () => {
    const hit = sweepCircleVsAABB({ x: 0, y: 15 }, { x: 10, y: 0 }, r, box);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(0.5, 10); // center reaches x=5 (10 − r)
    expect(hit!.normal).toEqual({ x: -1, y: 0 });
  });

  it("corner region re-tests as circle: diagonal normal", () => {
    // Aim just outside the corner (10,10) on both axes.
    const hit = sweepCircleVsAABB({ x: 2, y: 2 }, { x: 12, y: 12 }, r, box);
    expect(hit).not.toBeNull();
    const n = hit!.normal;
    expect(Math.hypot(n.x, n.y)).toBeCloseTo(1, 10);
    expect(n.x).toBeLessThan(0);
    expect(n.y).toBeLessThan(0);
    expect(Math.abs(n.x)).toBeGreaterThan(0.05); // genuinely diagonal
    expect(Math.abs(n.y)).toBeGreaterThan(0.05);
  });

  it("grazes past a corner with no hit", () => {
    // Path parallel to x at y=4: circle bottom reaches y=9 < box.min.y=10 − r
    // distance from corner line is > r the whole way.
    const hit = sweepCircleVsAABB({ x: 0, y: 3 }, { x: 40, y: 0 }, r, box);
    expect(hit).toBeNull();
  });
});

describe("sweepCircleVsSegment (face + endcaps)", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 0 };
  const n = { x: 0, y: 1 }; // inward = +y (court below)

  it("face hit from the court side", () => {
    const hit = sweepCircleVsSegment({ x: 50, y: 20 }, { x: 0, y: -20 }, 5, a, b, n);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(0.75, 10); // center stops at y=5
    expect(hit!.normal.y).toBeCloseTo(1, 10);
  });

  it("no face hit when moving away", () => {
    const hit = sweepCircleVsSegment({ x: 50, y: 20 }, { x: 0, y: 20 }, 5, a, b, n);
    expect(hit).toBeNull();
  });

  it("endcap hit beyond the segment end", () => {
    const hit = sweepCircleVsSegment({ x: 108, y: -10 }, { x: -6, y: 14 }, 5, a, b, n);
    if (hit) {
      expect(Math.hypot(hit.normal.x, hit.normal.y)).toBeCloseTo(1, 10);
    }
    // A path clearly outside cap reach must miss:
    const miss = sweepCircleVsSegment({ x: 120, y: 20 }, { x: 0, y: -40 }, 5, a, b, n);
    expect(miss).toBeNull();
  });
});
