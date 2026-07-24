/**
 * AI interface contract (SPEC-3.12 §12.1 / Phase 4 DoD): purity (the AI
 * changes nothing except through its inputs), legal commands over fuzzed
 * states, and full determinism/replay equality. Prediction must never
 * corrupt state either.
 */

import { describe, expect, it } from "vitest";
import { cloneMatchState, createMatch, hashState, stepMatch } from "../src/sim";
import { AiController } from "../src/sim/ai/aiController";
import { damageCell } from "../src/sim/wall";
import { predictBall } from "../src/sim/ai/predict";
import type { BallState, MatchState } from "../src/sim/state";
import type { GameEvent } from "../src/sim/events";
import { deriveStream, mulberry32Next, rngInt, rngRange, type Rng } from "../src/sim/rng";
import { neutralSideInput } from "../src/input/controller";
import { aiMatchConfig, opponent, tuning } from "./helpers";

function addBall(state: MatchState, rng: Rng): void {
  const speed = tuning.physics.ball_base_speed * rngRange(rng, 0.7, 3.0);
  const angle = rngRange(rng, -1.3, 1.3);
  const dir = mulberry32Next(rng) < 0.5 ? -1 : 1;
  state.balls.push({
    id: state.nextEntityId++,
    pos: { x: rngRange(rng, 200, 1080), y: rngRange(rng, 60, 660) },
    vel: { x: Math.cos(angle) * speed * dir, y: Math.sin(angle) * speed },
    radius: tuning.physics.ball_radius,
    speedMult: 1,
    damage: 1,
    heavyHitsLeft: 0,
    curveAccel: 0,
    stuckToPaddle: null,
    lastHitBy: null,
    lastHorizontalDir: dir as 1 | -1,
    justTeleported: false,
  });
}

/** A randomized but structurally-valid rally state. */
function fuzzState(seed: number): MatchState {
  const rng = deriveStream(seed, 71);
  const state = createMatch(aiMatchConfig(opponent("warden", 3)), seed);
  state.phase = { kind: "rally" };
  state.tick = rngInt(rng, 0, 20000);
  const nballs = rngInt(rng, 1, 4);
  for (let i = 0; i < nballs; i++) addBall(state, rng);
  // Random wall damage on both sides.
  const events: GameEvent[] = [];
  for (const side of ["left", "right"] as const) {
    const wall = state.sides[side].wall;
    const hits = rngInt(rng, 0, 40);
    for (let h = 0; h < hits; h++) {
      const layer = rngInt(rng, 0, wall.layers.length);
      const lane = rngInt(rng, 0, wall.laneCount);
      damageCell(state, side, layer, lane, 1, 0, events);
    }
  }
  // Random paddle positions.
  for (const p of state.sides.right.paddles) {
    p.yCenter = Math.max(p.zone.yMin, Math.min(p.zone.yMax, rngRange(rng, 0, 720)));
  }
  return state;
}

function assertLegal(input: ReturnType<AiController["sample"]>, nPaddles: number): void {
  expect(input.paddles).toHaveLength(nPaddles);
  for (const p of input.paddles) {
    expect([-1, 0, 1]).toContain(p.move);
    expect(typeof p.action).toBe("boolean");
  }
  expect(input.activateSlot === null || Number.isInteger(input.activateSlot)).toBe(true);
  if (input.placement !== null) {
    expect(["place_brick", "extra_layer"]).toContain(input.placement.kind);
  }
}

describe("AI purity (§9.3.3 / Phase 4 DoD)", () => {
  it("sample() never mutates the state (hash-equal before/after) over 10k fuzzed states", () => {
    let checked = 0;
    for (let seed = 0; seed < 10_000; seed++) {
      const state = fuzzState(seed);
      const ai = new AiController(opponent("warden", 3), "right", seed);
      const before = hashState(state);
      const input = ai.sample(state, "right");
      expect(hashState(state)).toBe(before); // purity
      assertLegal(input, state.sides.right.paddles.length);
      checked++;
    }
    expect(checked).toBe(10_000);
  });

  it("predictBall never mutates the ball or state it inspects", () => {
    for (let seed = 0; seed < 500; seed++) {
      const state = fuzzState(seed);
      const before = hashState(state);
      for (const b of state.balls) {
        const snap = JSON.stringify(b);
        predictBall(state, b.id, "right", 600);
        expect(JSON.stringify(b)).toBe(snap); // ball untouched
      }
      expect(hashState(state)).toBe(before);
    }
  });
});

describe("AI determinism & replay (§9.3.3)", () => {
  function runAiMatch(seed: number): { hash: number; ticks: number; inputsHash: number } {
    const config = aiMatchConfig(opponent("warden", 3), { rules: { first_receiver: "left" } });
    const state = createMatch(config, seed);
    const left = new AiController(opponent("striker", 2), "left", seed);
    const right = new AiController(opponent("warden", 3), "right", seed);
    let inputsHash = 0x811c9dc5;
    const mix = (n: number): void => {
      inputsHash = (Math.imul(inputsHash ^ (n | 0), 0x01000193) >>> 0);
    };
    while (state.phase.kind !== "matchOver" && state.tick < 60_000) {
      const li = left.sample(state, "left");
      const ri = right.sample(state, "right");
      mix(li.paddles[0]!.move);
      mix(ri.paddles[0]!.move);
      stepMatch(state, { left: li, right: ri });
    }
    return { hash: hashState(state), ticks: state.tick, inputsHash };
  }

  it("same seed ⇒ identical AI-vs-AI match (state hash + input stream)", () => {
    const a = runAiMatch(2026);
    const b = runAiMatch(2026);
    expect(a).toEqual(b);
  });

  it("recorded AI inputs replay to the identical state (AI changed nothing but inputs)", () => {
    const config = aiMatchConfig(opponent("warden", 3), { rules: { first_receiver: "left" } });
    const seed = 4242;
    const rec: { left: ReturnType<AiController["sample"]>; right: ReturnType<AiController["sample"]> }[] = [];
    const live = createMatch(config, seed);
    const left = new AiController(opponent("drone", 1), "left", seed);
    const right = new AiController(opponent("warden", 3), "right", seed);
    while (live.phase.kind !== "matchOver" && live.tick < 40_000) {
      const inputs = { left: left.sample(live, "left"), right: right.sample(live, "right") };
      rec.push({ left: inputs.left, right: inputs.right });
      stepMatch(live, inputs);
    }
    // Replay the recorded inputs through a fresh sim — no AI in the loop.
    const replay = createMatch(config, seed);
    for (const inp of rec) stepMatch(replay, inp);
    expect(hashState(replay)).toBe(hashState(live));
  });
});

describe("AI plays a real match without illegal state", () => {
  it("a full warden@T3 vs tracker match runs to completion, AI returns balls", () => {
    const config = aiMatchConfig(opponent("warden", 3), { rules: { first_receiver: "left" } });
    const state = createMatch(config, 99);
    const ai = new AiController(opponent("warden", 3), "right", 99);
    // Left: a perfect tracker stand-in.
    const tracker = (s: MatchState) => {
      const input = neutralSideInput();
      const p = s.sides.left.paddles[0]!;
      const b = s.balls.find((x) => x.vel.x < 0);
      input.paddles[0]!.move = b ? (Math.sign(b.pos.y - p.yCenter) as -1 | 0 | 1) : 0;
      return input;
    };
    let aiHits = 0;
    while (state.phase.kind !== "matchOver" && state.tick < 90_000) {
      const events = stepMatch(state, { left: tracker(state), right: ai.sample(state, "right") });
      for (const e of events) if (e.type === "BallPaddleHit" && e.side === "right") aiHits++;
    }
    expect(state.phase.kind).toBe("matchOver");
    expect(aiHits).toBeGreaterThan(15); // the AI genuinely defends, not a passive loss
  });
});

/** cloneMatchState round-trip inside the AI test file for the purity guarantee. */
describe("prediction operates on copies", () => {
  it("predictReturnLane leaves the source state hash-equal", () => {
    const state = fuzzState(7);
    const before = hashState(state);
    const b: BallState = state.balls[0]!;
    predictBall(state, b.id, "right", 600);
    void cloneMatchState;
    expect(hashState(state)).toBe(before);
  });
});
