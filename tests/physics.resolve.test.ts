/**
 * Earliest-TOI resolution & steering effects (SPEC-3.12 §12.1):
 * reflection preserves |v|, EPS skin prevents re-hit, min-|vx| clamp
 * post-conditions, edge-hit = max-offset steering with no rally increment,
 * back-face flag, brick impact resets global speed.
 *
 * integrateBall advances ONE 1/120 s tick; scenarios run it in a loop.
 */

import { describe, expect, it } from "vitest";
import { createMatch } from "../src/sim";
import { integrateBall } from "../src/sim/ball";
import { clampMinVx } from "../src/sim/physics/reflect";
import type { BallState, MatchState, PerSide } from "../src/sim/state";
import type { GameEvent } from "../src/sim/events";
import { testMatchConfig } from "./helpers";

const noVel: PerSide<number[]> = { left: [0], right: [0] };

function makeBall(state: MatchState, x: number, y: number, vx: number, vy: number): BallState {
  const ball: BallState = {
    id: state.nextEntityId++,
    pos: { x, y },
    vel: { x: vx, y: vy },
    radius: state.config.tuning.physics.ball_radius,
    speedMult: 1,
    damage: 1,
    heavyHitsLeft: 0,
    curveAccel: 0,
    stuckToPaddle: null,
    lastHitBy: null,
    lastHorizontalDir: vx >= 0 ? 1 : -1,
    justTeleported: false,
  };
  state.balls.push(ball);
  return ball;
}

function runTicks(state: MatchState, ball: BallState, n: number): GameEvent[] {
  const events: GameEvent[] = [];
  for (let i = 0; i < n; i++) {
    if (!state.balls.includes(ball)) break; // consumed
    integrateBall(state, ball, noVel, events);
  }
  return events;
}

function rallyState(): MatchState {
  const state = createMatch(testMatchConfig(), 1);
  state.phase = { kind: "rally" };
  return state;
}

describe("TOI resolution", () => {
  it("boundary reflection preserves |v| and the EPS skin prevents re-hits (§3.5)", () => {
    const state = rallyState();
    const ball = makeBall(state, 640, 20, 100, -400);
    const speedBefore = Math.hypot(ball.vel.x, ball.vel.y);
    runTicks(state, ball, 6);
    expect(ball.vel.y).toBeGreaterThan(0); // reflected downward off the top wall
    expect(Math.hypot(ball.vel.x, ball.vel.y)).toBeCloseTo(speedBefore, 6);
    const yAfter = ball.pos.y;
    runTicks(state, ball, 3);
    expect(ball.pos.y).toBeGreaterThan(yAfter); // moving away cleanly
  });

  it("front-face paddle hit increments the rally counter, ramps speed, steers (R-3.1)", () => {
    const state = rallyState();
    const paddle = state.sides.left.paddles[0]!;
    const ball = makeBall(state, 160, paddle.yCenter + 20, -420, 0);
    const events = runTicks(state, ball, 8);
    expect(state.rally.hitCount).toBe(1);
    expect(ball.vel.x).toBeGreaterThan(0); // toward the opponent
    expect(ball.vel.y).toBeGreaterThan(0); // below-center contact steers down
    expect(events.some((e) => e.type === "BallPaddleHit")).toBe(true);
    expect(Math.hypot(ball.vel.x, ball.vel.y)).toBeCloseTo(420 * 1.1, 4); // curve[1]
  });

  it("edge/cap hit steers at max offset WITHOUT incrementing the counter (R-3.3)", () => {
    const state = rallyState();
    const paddle = state.sides.left.paddles[0]!;
    // Straight horizontal path 4 u above the top corner — corner-region contact.
    const ball = makeBall(state, 155, paddle.yCenter - paddle.halfHeight - 4, -300, 0);
    const events = runTicks(state, ball, 6);
    expect(state.rally.hitCount).toBe(0);
    expect(events.some((e) => e.type === "BallPaddleHit")).toBe(false);
    expect(ball.vel.x).toBeGreaterThan(0); // steered back toward the opponent
    expect(ball.vel.y).toBeLessThan(0); // max offset above center → upward
  });

  it("back-face hit reverses vx toward the bricks and emits BallBackFaceHit (R-3.2)", () => {
    const state = rallyState();
    const paddle = state.sides.left.paddles[0]!;
    const ball = makeBall(state, 100, paddle.yCenter, 380, 0); // wall side, moving at the back face
    const events = runTicks(state, ball, 10);
    expect(ball.vel.x).toBeLessThan(0); // sent back toward own bricks
    expect(state.rally.hitCount).toBe(0);
    expect(events.some((e) => e.type === "BallBackFaceHit")).toBe(true);
  });

  it("brick impact damages, reflects, and resets the global speed (R-3.5/R-4.1)", () => {
    const state = rallyState();
    state.rally.hitCount = 7;
    const ball = makeBall(state, 80, 90, -420 * 2.05, 0); // into the left wall front face (x=44)
    ball.speedMult = 2.05;
    const events = runTicks(state, ball, 8);
    expect(events.some((e) => e.type === "BrickDamaged")).toBe(true);
    expect(events.some((e) => e.type === "SpeedReset")).toBe(true);
    expect(state.rally.hitCount).toBe(0);
    expect(ball.vel.x).toBeGreaterThan(0); // reflected back into the court
    expect(Math.hypot(ball.vel.x, ball.vel.y)).toBeCloseTo(420, 4); // base speed
  });

  it("breached-lane crossing queues the defender and removes the ball (R-4.3)", () => {
    const state = createMatch(testMatchConfig({ wallsLeft: [] }), 1); // 0-layer left side
    state.phase = { kind: "rally" };
    const ball = makeBall(state, 60, 300, -420, 0);
    const events = runTicks(state, ball, 25);
    expect(state.pendingCrossings).toHaveLength(1);
    expect(state.pendingCrossings[0]!.side).toBe("left");
    expect(state.pendingCrossings[0]!.lane).toBe(5); // y=300 / 60 u lanes
    expect(state.balls).toHaveLength(0);
    expect(events.some((e) => e.type === "BallRemoved" && e.cause === "lifeLost")).toBe(true);
  });

  it("shield charge absorbs the crossing instead (R-4.3 / §3.4.3)", () => {
    const state = createMatch(testMatchConfig({ wallsLeft: [] }), 1);
    state.phase = { kind: "rally" };
    state.sides.left.wall.shieldCharges = 1;
    const ball = makeBall(state, 60, 300, -420, 0);
    const events = runTicks(state, ball, 25);
    expect(events.some((e) => e.type === "ShieldConsumed")).toBe(true);
    expect(state.pendingCrossings).toHaveLength(0);
    expect(state.balls).toHaveLength(1);
    expect(ball.vel.x).toBeGreaterThan(0); // reflected off the back boundary
  });
});

describe("min-|vx| clamp (§3.6.3)", () => {
  it("boosts near-vertical velocity to the floor, preserving |v|", () => {
    const state = rallyState();
    const ball = makeBall(state, 640, 360, 5, 400);
    const before = Math.hypot(ball.vel.x, ball.vel.y);
    clampMinVx(ball, state.config.tuning);
    const after = Math.hypot(ball.vel.x, ball.vel.y);
    expect(after).toBeCloseTo(before, 6);
    expect(Math.abs(ball.vel.x)).toBeGreaterThanOrEqual(before * 0.22 - 1e-9);
    expect(Math.sign(ball.vel.x)).toBe(1); // sign preserved
  });

  it("uses lastHorizontalDir when vx is exactly 0", () => {
    const state = rallyState();
    const ball = makeBall(state, 640, 360, 0, 400);
    ball.lastHorizontalDir = -1;
    clampMinVx(ball, state.config.tuning);
    expect(ball.vel.x).toBeLessThan(0);
  });
});
