/**
 * App FSM table (SPEC-3.6 §6.1) + match FSM rows M1–M11 (§6.2):
 * serve auto-launch timing and angle clamp, loser-receives, per-defender
 * life cap incl. same-tick dual crossings → sudden death, all-balls-dead
 * receiver, stall void, overtime, hit-stop freeze.
 */

import { describe, expect, it } from "vitest";
import { AppFsm } from "../src/app/appFsm";
import { createMatch, stepMatch } from "../src/sim";
import type { GameEvent } from "../src/sim/events";
import type { BallState, MatchState } from "../src/sim/state";
import { neutralInputs, testMatchConfig, tuning } from "./helpers";

function injectBall(
  state: MatchState,
  x: number,
  y: number,
  vx: number,
  vy: number,
): BallState {
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

function stepN(state: MatchState, n: number): GameEvent[] {
  const all: GameEvent[] = [];
  for (let i = 0; i < n; i++) all.push(...stepMatch(state, neutralInputs()));
  return all;
}

const makeFsm = (effects: string[]) =>
  new AppFsm([
    { from: "BOOT", event: "configLoaded", to: "TITLE", effect: () => effects.push("boot-ok") },
    { from: "BOOT", event: "configError", to: "BOOT" },
    { from: "TITLE", event: "anyKey", to: "MAIN_MENU" },
    { from: "MAIN_MENU", event: "selectStory", to: "MATCH" },
  ]);

describe("app FSM", () => {
  it("starts in BOOT and follows the declared boot path", () => {
    const effects: string[] = [];
    const fsm = makeFsm(effects);
    expect(fsm.state).toBe("BOOT");
    expect(fsm.dispatch("configLoaded")).toBe(true);
    expect(fsm.state).toBe("TITLE");
    expect(effects).toEqual(["boot-ok"]);
    fsm.dispatch("anyKey");
    fsm.dispatch("selectStory");
    expect(fsm.state).toBe("MATCH");
  });

  it("ignores undeclared (state, event) pairs", () => {
    const fsm = makeFsm([]);
    expect(fsm.dispatch("anyKey")).toBe(false); // anyKey not declared for BOOT
    expect(fsm.state).toBe("BOOT");
  });

  it("configError keeps the app on the BOOT error screen", () => {
    const fsm = makeFsm([]);
    expect(fsm.dispatch("configError")).toBe(true);
    expect(fsm.state).toBe("BOOT");
  });
});

describe("match FSM — serve model (M1/M2, R-2.x)", () => {
  it("intro → serving at exactly intro_duration; serving → rally at exactly serve_delay", () => {
    const state = createMatch(testMatchConfig(), 11);
    expect(state.phase.kind).toBe("intro");
    stepN(state, tuning.rules.intro_duration - 1);
    expect(state.phase.kind).toBe("intro");
    stepN(state, 1);
    expect(state.phase.kind).toBe("serving");
    const events = stepN(state, tuning.rules.serve_delay);
    expect(state.phase.kind).toBe("rally");
    expect(state.balls).toHaveLength(1);
    const serve = events.find((e) => e.type === "Serve");
    expect(serve).toBeDefined();
  });

  it("serve launches from court center toward the receiver within the ±25° fan (AR2-26)", () => {
    const maxSin = Math.sin((tuning.rules.serve_angle_max * Math.PI) / 180) + 1e-6;
    for (let seed = 0; seed < 25; seed++) {
      const state = createMatch(testMatchConfig({ rules: { first_receiver: "left" } }), seed);
      stepN(state, tuning.rules.intro_duration + tuning.rules.serve_delay);
      const ball = state.balls[0]!;
      expect(ball.vel.x).toBeLessThan(0); // toward the left receiver
      const speed = Math.hypot(ball.vel.x, ball.vel.y);
      expect(speed).toBeCloseTo(tuning.physics.ball_base_speed, 4);
      expect(Math.abs(ball.vel.y) / speed).toBeLessThanOrEqual(maxSin);
    }
  });
});

describe("match FSM — lives & crossings (M3', M5, M6, M7, M10)", () => {
  function rallyWithBreachedLeft(lives: { left: number; right: number }): MatchState {
    const state = createMatch(
      testMatchConfig({ wallsLeft: [], rules: { lives, first_receiver: "right" } }),
      5,
    );
    state.phase = { kind: "rally" };
    state.rally.lastReceiver = "right";
    return state;
  }

  it("breach crossing costs the defender a life; loser RECEIVES the re-serve (R-2.2)", () => {
    const state = rallyWithBreachedLeft({ left: 3, right: 3 });
    injectBall(state, 60, 30, -420, 0);
    const events = stepN(state, 30);
    const lifeLost = events.find((e) => e.type === "LifeLost");
    expect(lifeLost).toMatchObject({ side: "left", livesLeft: 2, lane: 0 });
    expect(state.phase.kind).toBe("lifeLostSeq");
    stepN(state, tuning.rules.life_lost_seq);
    expect(state.phase).toMatchObject({ kind: "serving", receiver: "left" });
  });

  it("dual same-tick crossings cost both sides a life; at 0/0 → sudden death (R-4.7/R-6.4)", () => {
    const state = createMatch(
      testMatchConfig({
        wallsLeft: [],
        wallsRight: [],
        rules: { lives: { left: 1, right: 1 }, first_receiver: "right" },
      }),
      5,
    );
    state.phase = { kind: "rally" };
    injectBall(state, 60, 30, -420, 0);
    injectBall(state, 1220, 30, 420, 0);
    const events = stepN(state, 30);
    expect(events.filter((e) => e.type === "LifeLost")).toHaveLength(2);
    expect(state.phase).toMatchObject({ kind: "lifeLostSeq", loser: "both" });
    const after = stepN(state, tuning.rules.life_lost_seq);
    expect(after.some((e) => e.type === "SuddenDeath")).toBe(true);
    expect(state.sides.left.lives).toBe(1);
    expect(state.sides.right.lives).toBe(1);
    expect(state.phase.kind).toBe("serving");
  });

  it("multi-ball life cap: second crossing in the same exchange despawns without a life (R-4.6)", () => {
    const state = rallyWithBreachedLeft({ left: 3, right: 3 });
    injectBall(state, 60, 30, -420, 0);
    injectBall(state, 80, 90, -420, 0); // arrives a few ticks later, same exchange
    const events = stepN(state, 30);
    expect(events.filter((e) => e.type === "LifeLost")).toHaveLength(1);
    expect(state.sides.left.lives).toBe(2);
  });

  it("reaching 0 lives ends the match with stats (M7, R-6.2)", () => {
    const state = rallyWithBreachedLeft({ left: 1, right: 3 });
    injectBall(state, 60, 30, -420, 0);
    const events = stepN(state, 30 + tuning.rules.life_lost_seq);
    const over = events.find((e) => e.type === "MatchOver");
    expect(over).toBeDefined();
    expect((over as { winner: string }).winner).toBe("right");
    expect((over as { stats: { livesLost: { left: number } } }).stats.livesLost.left).toBe(1);
    expect(state.phase.kind).toBe("matchOver");
  });

  it("all balls dead without life loss re-serves toward the non-toucher (M5, R-2.3)", () => {
    const state = createMatch(testMatchConfig({ rules: { first_receiver: "right" } }), 5);
    state.phase = { kind: "rally" };
    state.rally.lastTouchSide = "right";
    const events = stepN(state, 1);
    expect(state.phase).toMatchObject({ kind: "serving", receiver: "left" });
    expect(events.some((e) => e.type === "MatchPhaseChanged")).toBe(true);
  });

  it("stall soft-timeout homes each ball toward the nearest paddle, magnitude preserved (M11, R-5.4)", () => {
    const state = createMatch(testMatchConfig({ rules: { first_receiver: "right" } }), 5);
    state.phase = { kind: "rally" };
    // Ball high in the court moving upward, away from both paddles (at y=360
    // below it); the direction-only nudge bends its heading downward toward
    // the nearer paddle while preserving |v|.
    const b = injectBall(state, 400, 200, 300, -120);
    const vyBefore = b.vel.y;
    const speedBefore = Math.hypot(b.vel.x, b.vel.y);
    state.rally.lastTouchTick = state.tick - tuning.rules.stall_soft_timeout - 1;
    stepMatch(state, neutralInputs());
    expect(b.vel.y).toBeGreaterThan(vyBefore); // bent toward the paddles below
    expect(Math.hypot(b.vel.x, b.vel.y)).toBeCloseTo(speedBefore, 4); // direction-only
  });

  it("stall hard-timeout voids the exchange: balls despawn, no life lost (M11, R-5.4)", () => {
    const state = createMatch(testMatchConfig({ rules: { first_receiver: "right" } }), 5);
    state.phase = { kind: "rally" };
    state.rally.lastReceiver = "right";
    injectBall(state, 640, 360, 100, 380);
    state.rally.lastTouchTick =
      state.tick - (tuning.rules.stall_soft_timeout + tuning.rules.stall_hard_timeout) - 1;
    const events = stepN(state, 2);
    expect(events.some((e) => e.type === "BallRemoved" && e.cause === "stall")).toBe(true);
    expect(events.some((e) => e.type === "LifeLost")).toBe(false);
    expect(state.phase.kind).toBe("serving");
  });
});

describe("match FSM — overtime & hit-stop (M9, R-5.5)", () => {
  it("overtime starts past overtime_start and decays all bricks on both sides (R-6.3)", () => {
    const state = createMatch(
      testMatchConfig({ rules: { overtime_start: 50, first_receiver: "right" } }),
      5,
    );
    state.phase = { kind: "rally" };
    injectBall(state, 640, 100, 100, 380);
    let sawStart = false;
    let sawTick = false;
    const period = tuning.rules.overtime_tick_period;
    for (let i = 0; i < 60 + period + 10; i++) {
      state.rally.lastTouchTick = state.tick; // hold off the stall watchdog
      state.balls.forEach((b) => {
        b.pos.x = 640; // keep the ball harmlessly mid-court
        b.pos.y = 360;
      });
      const events = stepMatch(state, neutralInputs());
      if (events.some((e) => e.type === "OvertimeStarted")) sawStart = true;
      if (events.some((e) => e.type === "OvertimeTick")) {
        sawTick = true;
        expect(events.some((e) => e.type === "BrickDamaged" && e.byBallId === null)).toBe(true);
        expect(events.some((e) => e.type === "SpeedReset")).toBe(false); // AR2-14
        break;
      }
    }
    expect(sawStart).toBe(true);
    expect(sawTick).toBe(true);
  });

  it("frozen ticks consume time but run no sim stages (R-5.5)", () => {
    const state = createMatch(testMatchConfig(), 5);
    state.phase = { kind: "rally" };
    injectBall(state, 640, 360, 420, 0);
    state.freezeTicks = 3;
    const before = state.balls[0]!.pos.x;
    const events = stepMatch(state, neutralInputs());
    expect(events).toHaveLength(0);
    expect(state.balls[0]!.pos.x).toBe(before);
    expect(state.freezeTicks).toBe(2);
  });
});
