/**
 * Arena baking, geometry validation, slope field, and serve-clearance
 * (SPEC-3.3 §3.8, SPEC-2.3). Covers all five profiles + the §3.8.1 vertex
 * rules and the slope serve-clearance check (no ramp-clipped serves at ±25°).
 */

import { describe, expect, it } from "vitest";
import {
  bakeArena,
  bottomY,
  expandArenaProfile,
  slopeGradient,
  topY,
  validateArenaGeometry,
} from "../src/sim/geometry";
import { createMatch, stepMatch } from "../src/sim";
import type { ArenaRuntime } from "../src/sim/state";
import { neutralInputs, panels, testMatchConfig, tuning } from "./helpers";

function runtime(profile: string): ArenaRuntime {
  const arena = expandArenaProfile({ profile: profile as never });
  return bakeArena(arena, [], panels).runtime;
}

describe("arena profiles expand & validate (§3.8.1)", () => {
  it.each(["flat", "slope", "angular", "narrowing", "zigzag"])(
    "%s passes all geometry constraints",
    (profile) => {
      const arena = expandArenaProfile({ profile: profile as never });
      expect(validateArenaGeometry(arena)).toEqual([]);
    },
  );

  it("flat is a pure rectangle with left+right back boundaries", () => {
    const rt = runtime("flat");
    expect(rt.segments.filter((s) => s.kind === "back")).toHaveLength(2);
    expect(topY(rt, 640)).toBe(0);
    expect(bottomY(rt, 640)).toBe(720);
  });

  it("slope squeezes the court to 480 across the plateau", () => {
    const rt = runtime("slope");
    expect(topY(rt, 640)).toBeCloseTo(120, 6); // plateau top
    expect(bottomY(rt, 640)).toBeCloseTo(600, 6);
    expect(bottomY(rt, 640) - topY(rt, 640)).toBeCloseTo(480, 6);
    // Flat ends unchanged from Wide.
    expect(topY(rt, 100)).toBe(0);
    expect(bottomY(rt, 100)).toBe(720);
  });

  it("inward normals point into the court on every boundary segment", () => {
    const rt = runtime("zigzag");
    const center = { x: 640, y: 360 };
    for (const seg of rt.segments) {
      if (seg.kind === "back") continue;
      const mid = { x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2 };
      const toCenter = { x: center.x - mid.x, y: center.y - mid.y };
      expect(seg.normal.x * toCenter.x + seg.normal.y * toCenter.y).toBeGreaterThan(0);
    }
  });

  it("rejects non-increasing x, broken flat zones, and sub-min court height", () => {
    expect(
      validateArenaGeometry({
        topVerts: [{ x: 0, y: 0 }, { x: 100, y: 50 }, { x: 1280, y: 0 }],
        bottomVerts: [{ x: 0, y: 720 }, { x: 1280, y: 720 }],
        slope: null,
      }).some((e) => e.includes("flat")),
    ).toBe(true);

    expect(
      validateArenaGeometry({
        topVerts: [{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 400, y: 0 }, { x: 1280, y: 0 }],
        bottomVerts: [{ x: 0, y: 720 }, { x: 1280, y: 720 }],
        slope: null,
      }).some((e) => e.includes("increasing")),
    ).toBe(true);

    expect(
      validateArenaGeometry({
        topVerts: [{ x: 0, y: 0 }, { x: 1280, y: 0 }],
        bottomVerts: [{ x: 0, y: 20 }, { x: 1280, y: 20 }],
        slope: null,
      }).some((e) => e.includes("court height")),
    ).toBe(true);
  });
});

describe("slope field (§3.8.4)", () => {
  it("gradient is +H/rampLen uphill, −H/rampLen downhill, 0 on plateau & ends", () => {
    const arena = expandArenaProfile({ profile: "slope", slope_influence: "field" });
    const s = arena.slope!;
    expect(slopeGradient(s, 100)).toBe(0); // flat end
    expect(slopeGradient(s, 400)).toBeCloseTo(120 / 240, 6); // up-ramp
    expect(slopeGradient(s, 640)).toBe(0); // plateau
    expect(slopeGradient(s, 880)).toBeCloseTo(-120 / 240, 6); // down-ramp
    expect(slopeGradient(s, 1200)).toBe(0); // flat end
  });

  it("a ball climbing the up-ramp loses x-speed; descending gains it", () => {
    const config = testMatchConfig({
      arena: expandArenaProfile({ profile: "slope", slope_influence: "field" }),
    });
    const state = createMatch(config, 1);
    state.phase = { kind: "rally" };
    // Ball moving right through the up-ramp region (x ∈ [280,520]).
    const base = tuning.physics.ball_base_speed;
    state.balls.push({
      id: state.nextEntityId++,
      pos: { x: 400, y: 360 },
      vel: { x: base, y: 0 },
      radius: 7,
      speedMult: 1,
      damage: 1,
      heavyHitsLeft: 0,
      curveAccel: 0,
      stuckToPaddle: null,
      lastHitBy: null,
      lastHorizontalDir: 1,
      justTeleported: false,
    });
    const before = state.balls[0]!.vel.x;
    stepMatch(state, neutralInputs());
    expect(state.balls[0]!.vel.x).toBeLessThan(before); // decelerated uphill
  });

  it("reflection_only mode leaves ball speed untouched by the ramps", () => {
    const config = testMatchConfig({
      arena: expandArenaProfile({ profile: "slope", slope_influence: "reflection_only" }),
    });
    const state = createMatch(config, 1);
    expect(state.arena.slope!.mode).toBe("reflection_only");
    state.phase = { kind: "rally" };
    const base = tuning.physics.ball_base_speed;
    state.balls.push({
      id: state.nextEntityId++,
      pos: { x: 400, y: 360 },
      vel: { x: base, y: 0 },
      radius: 7, speedMult: 1, damage: 1, heavyHitsLeft: 0, curveAccel: 0,
      stuckToPaddle: null, lastHitBy: null, lastHorizontalDir: 1, justTeleported: false,
    });
    stepMatch(state, neutralInputs());
    expect(Math.hypot(state.balls[0]!.vel.x, state.balls[0]!.vel.y)).toBeCloseTo(base, 3);
  });
});

describe("slope serve-clearance (§2.3.2 — no ramp-clipped serves at ±25°)", () => {
  it("a max-angle serve stays within the plateau band before any ramp", () => {
    // Plateau spans x ∈ [520,760]; serve origin (640,360). A ±25° serve
    // covers ±120 u horizontal before leaving the plateau ⇒ ±56 u vertical,
    // inside the 480-high plateau (top 120 … bottom 600).
    const config = testMatchConfig({
      arena: expandArenaProfile({ profile: "slope", slope_influence: "reflection_only" }),
    });
    for (let seed = 0; seed < 40; seed++) {
      const state = createMatch(config, seed);
      // Advance to just after launch.
      const total = tuning.rules.intro_duration + tuning.rules.serve_delay + 1;
      for (let i = 0; i < total; i++) stepMatch(state, neutralInputs());
      const ball = state.balls[0];
      if (!ball) continue;
      // Within the plateau x-band the ball must clear both ramp faces.
      expect(ball.pos.y).toBeGreaterThan(topY(state.arena, ball.pos.x) + ball.radius - 1);
      expect(ball.pos.y).toBeLessThan(bottomY(state.arena, ball.pos.x) - ball.radius + 1);
      // Serve angle within the fan (±25°); vertical component bounded.
      const speed = Math.hypot(ball.vel.x, ball.vel.y);
      const angle = Math.abs(Math.atan2(ball.vel.y, ball.vel.x));
      const fromHoriz = Math.min(angle, Math.PI - angle);
      expect(fromHoriz).toBeLessThanOrEqual((tuning.rules.serve_angle_max * Math.PI) / 180 + 1e-6);
      void speed;
    }
  });
});
