/**
 * Wall objects (SPEC-3.3 §3.9, SPEC-2.4): lever recall, panel set-vector,
 * one-way pass filter, cooldowns, and the level-object validation rules
 * (§2.4.4 caps + separation, panel color resolution).
 */

import { describe, expect, it } from "vitest";
import { createMatch, stepMatch } from "../src/sim";
import { integrateBall } from "../src/sim/ball";
import { validateLevelJson } from "../src/config/levels";
import type { BallState, MatchState, PerSide } from "../src/sim/state";
import type { ResolvedObject } from "../src/config/types";
import type { GameEvent } from "../src/sim/events";
import { materials, neutralInputs, panels, testMatchConfig } from "./helpers";

const noVel: PerSide<number[]> = { left: [0], right: [0] };

function ball(state: MatchState, x: number, y: number, vx: number, vy: number, lastHit: "left" | "right" | null): BallState {
  const b: BallState = {
    id: state.nextEntityId++,
    pos: { x, y },
    vel: { x: vx, y: vy },
    radius: 7, speedMult: 1, damage: 1, heavyHitsLeft: 0, curveAccel: 0,
    stuckToPaddle: null, lastHitBy: lastHit, lastHorizontalDir: vx >= 0 ? 1 : -1, justTeleported: false,
  };
  state.balls.push(b);
  return b;
}

function withObjects(objects: ResolvedObject[]): MatchState {
  const state = createMatch(testMatchConfig({ wallsLeft: [], wallsRight: [], objects }), 1);
  state.phase = { kind: "rally" };
  return state;
}

function run(state: MatchState, b: BallState, ticks: number): GameEvent[] {
  const events: GameEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    if (!state.balls.includes(b)) break;
    integrateBall(state, b, noVel, events);
  }
  return events;
}

describe("levers (§3.9.2)", () => {
  it("recall sends the ball horizontally back toward the last hitter, preserving speed", () => {
    // Lever on the top boundary near center.
    const state = withObjects([
      { kind: "lever", boundary: "top", t: 0.5, length: 60, cooldownTicks: 240 },
    ]);
    // Ball rising into the top boundary, last hit by left ⇒ should return −x.
    const b = ball(state, 640, 16, 120, -420, "left");
    const speed = Math.hypot(b.vel.x, b.vel.y);
    const events = run(state, b, 6);
    expect(events.some((e) => e.type === "WallObjectTriggered" && e.kind === "lever")).toBe(true);
    expect(b.vel.x).toBeLessThan(0); // toward the left hitter
    expect(Math.hypot(b.vel.x, b.vel.y)).toBeCloseTo(speed, 4);
    expect(state.rally.hitCount).toBe(0); // objects never touch the rally counter (R-3.4)
  });

  it("an untouched serve reflects plainly off a lever", () => {
    const state = withObjects([
      { kind: "lever", boundary: "top", t: 0.5, length: 60, cooldownTicks: 240 },
    ]);
    const b = ball(state, 640, 16, 120, -420, null);
    const events = run(state, b, 6);
    expect(events.some((e) => e.type === "WallObjectTriggered")).toBe(false);
    expect(b.vel.y).toBeGreaterThan(0); // just bounced downward
  });

  it("a cooling lever behaves as a plain boundary", () => {
    const state = withObjects([
      { kind: "lever", boundary: "top", t: 0.5, length: 60, cooldownTicks: 240 },
    ]);
    state.wallObjects[0]!.cooldownTicks = 100; // cooling
    const b = ball(state, 640, 16, 120, -420, "left");
    const events = run(state, b, 6);
    expect(events.some((e) => e.type === "WallObjectTriggered")).toBe(false);
    expect(b.vel.y).toBeGreaterThan(0);
  });
});

describe("panels (§3.9.3)", () => {
  it("sets the ball direction to the panel vector, magnitude preserved", () => {
    const state = withObjects([
      { kind: "panel", boundary: "top", t: 0.5, length: 60, cooldownTicks: 180, color: "amber" },
    ]);
    const b = ball(state, 640, 16, 100, -420, "left");
    const speed = Math.hypot(b.vel.x, b.vel.y);
    const events = run(state, b, 6);
    const trig = events.find((e) => e.type === "WallObjectTriggered");
    expect(trig).toBeDefined();
    // amber = ↘ (0.766, +0.643): rightward and downward.
    expect(b.vel.x).toBeGreaterThan(0);
    expect(b.vel.y).toBeGreaterThan(0);
    expect(b.vel.x / speed).toBeCloseTo(0.766, 2);
    expect(Math.hypot(b.vel.x, b.vel.y)).toBeCloseTo(speed, 4);
  });

  it("starts its cooldown on trigger", () => {
    const state = withObjects([
      { kind: "panel", boundary: "top", t: 0.5, length: 60, cooldownTicks: 180, color: "coral" },
    ]);
    const b = ball(state, 640, 16, 100, -420, "left");
    run(state, b, 6);
    expect(state.wallObjects[0]!.cooldownTicks).toBeGreaterThan(0);
  });
});

describe("one-way tiles (§3.3)", () => {
  // The gate sits INSET below the top boundary (y ≈ 44). left_to_right ⇒
  // blockNormal (1,0): reflects leftward movers, passes rightward movers.
  const gate = (): MatchState =>
    withObjects([
      { kind: "oneWay", boundary: "top", t: 0.5, length: 160, cooldownTicks: 0, passDir: "left_to_right" },
    ]);

  it("reflects a ball approaching against the blocked direction", () => {
    const state = gate();
    // Just below the inset gate (y≈44), moving left-and-up into it.
    const blocked = ball(state, 660, 58, -260, -360, "right");
    run(state, blocked, 6);
    expect(blocked.vel.y).toBeGreaterThan(0); // bounced back downward off the gate
  });

  it("is transparent to a ball moving along the pass direction", () => {
    const state = gate();
    // Moving right-and-up along the pass direction: passes the gate line and
    // continues to the intact top boundary, which reflects it (stays in court).
    const passing = ball(state, 620, 90, 260, -320, "left");
    const before = passing.vel.y;
    // One tick: still rising, not yet reflected by the gate (it's transparent).
    integrateBall(state, passing, noVel, []);
    expect(passing.vel.y).toBe(before); // gate did not reflect it
    expect(passing.pos.y).toBeLessThan(90); // rose past the gate line
  });
});

describe("level object validation (§2.4.4)", () => {
  function level(objects: unknown): unknown {
    return {
      schema_version: 2,
      id: "t",
      display_name: "t",
      rules: {
        lives: { left: 3, right: 3 },
        rebuild_on_life_lost: "none",
        rebuild_material: "hay",
        life_loss_per_exchange: 1,
        overtime_enabled: true,
        overtime_start: null,
        fixed_seed: null,
      },
      walls: { lane_count: 12, left: { layers: ["hay*12"] }, right: { layers: ["hay*12"] } },
      arena: { profile: "flat" },
      objects,
    };
  }

  it("resolves a panel color and one-way pass direction", () => {
    const { level: lvl, errors } = validateLevelJson(
      "t.json",
      level([
        { type: "panel", boundary: "top", t: 0.4, length: 60, color: "teal", cooldown_ms: 1500 },
        { type: "one_way", boundary: "bottom", t: 0.6, length: 80, pass_dir: "right_to_left" },
      ]),
      materials,
      panels,
    );
    expect(errors).toEqual([]);
    expect(lvl!.objects[0]).toMatchObject({ kind: "panel", color: "teal" });
    expect(lvl!.objects[1]).toMatchObject({ kind: "oneWay", passDir: "right_to_left" });
  });

  it("rejects an unknown panel color", () => {
    const { errors } = validateLevelJson(
      "t.json",
      level([{ type: "panel", boundary: "top", t: 0.4, length: 60, color: "puce", cooldown_ms: 1500 }]),
      materials,
      panels,
    );
    expect(errors.some((e) => e.message.includes("puce"))).toBe(true);
  });

  it("rejects more than 4 triggerable objects", () => {
    const objs = Array.from({ length: 5 }, (_, i) => ({
      type: "lever",
      boundary: i % 2 === 0 ? "top" : "bottom",
      t: 0.1 + i * 0.15,
      length: 40,
      cooldown_ms: 2000,
    }));
    const { errors } = validateLevelJson("t.json", level(objs), materials, panels);
    expect(errors.some((e) => e.message.includes("triggerable"))).toBe(true);
  });

  it("rejects objects closer than the 8u minimum separation", () => {
    const { errors } = validateLevelJson(
      "t.json",
      level([
        { type: "lever", boundary: "top", t: 0.5, length: 40, cooldown_ms: 2000 },
        { type: "lever", boundary: "top", t: 0.505, length: 40, cooldown_ms: 2000 },
      ]),
      materials,
      panels,
    );
    expect(errors.some((e) => e.message.includes("separation"))).toBe(true);
  });
});

describe("cooldown ticking (stepMatch stage 7)", () => {
  it("decrements each tick until re-armed", () => {
    const state = createMatch(
      testMatchConfig({
        objects: [{ kind: "lever", boundary: "top", t: 0.5, length: 60, cooldownTicks: 240 }],
      }),
      1,
    );
    // During the intro/serving telegraph there are no balls yet — a clean
    // window to observe stage-7 cooldown ticking in isolation.
    state.wallObjects[0]!.cooldownTicks = 3;
    stepMatch(state, neutralInputs());
    expect(state.wallObjects[0]!.cooldownTicks).toBe(2);
    stepMatch(state, neutralInputs());
    stepMatch(state, neutralInputs());
    expect(state.wallObjects[0]!.cooldownTicks).toBe(0);
  });
});
