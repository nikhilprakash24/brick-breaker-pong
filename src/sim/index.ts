/**
 * Public sim API (SPEC-3.1 §1.3). Pure module: no DOM, canvas, audio,
 * storage, config fetching, or wall clock at step time. stepMatch executes
 * the normative stage order (SPEC-3.2 §2.2) — reordering breaks replays.
 */

import type { TickInputs } from "../input/controller";
import type { MatchConfig } from "../config/types";
import type { GameEvent } from "./events";
import type {
  BallState,
  LatchedInput,
  MatchState,
  PaddleState,
  PerSide,
  Side,
  SideState,
} from "./state";
import { emptyLatchedInput } from "./state";
import { deriveStream, STREAM_MISC, STREAM_POWERUP, STREAM_SERVE } from "./rng";
import { bakeFlatArena, bottomY, topY, ARENA_H, ARENA_W } from "./geometry";
import { buildWall } from "./wall";
import { recomputeAll } from "./breach";
import { integrateBall, simDiagnostics } from "./ball";
import { stepPaddles } from "./paddle";
import { preStep, postStep } from "./rules";

export type { GameEvent } from "./events";
export type { MatchState, Side } from "./state";
export { simDiagnostics } from "./ball";

function makePaddle(side: Side, config: MatchConfig): PaddleState {
  const t = config.tuning.paddle;
  const x = side === "left" ? t.paddle_plane_x_left : t.paddle_plane_x_right;
  const halfHeight = t.paddle_half_height;
  // Boundaries are flat at paddle x (§3.8.3) — zone constant per match.
  return {
    index: 0,
    yCenter: ARENA_H / 2, // R-1.5: spawn at travel-range center
    halfHeight,
    x,
    speed: t.paddle_speed,
    zone: { yMin: halfHeight, yMax: ARENA_H - halfHeight },
    stickyArmed: false,
  };
}

function makeSide(side: Side, config: MatchConfig): SideState {
  const wall = buildWall(
    side,
    config.laneCount,
    config.walls[side].layers,
    (m) => config.materials[m]!.hp,
  );
  return {
    lives: config.rules.lives[side],
    paddles: [makePaddle(side, config)],
    wall,
    slots: Array.from({ length: config.tuning.paddle.slot_count }, () => ({
      powerupId: null,
      locked: false,
    })),
    claimedThresholds: [],
    extraBallSign: 1,
    placementCooldownTicks: 0,
    placementWindow: null,
  };
}

/** Pure: same (config, seed) ⇒ identical state. */
export function createMatch(config: MatchConfig, seed: number): MatchState {
  const state: MatchState = {
    tick: 0,
    matchSeed: seed | 0,
    phase: { kind: "intro", ticksLeft: config.tuning.rules.intro_duration },
    freezeTicks: 0,
    inputLatch: { left: emptyLatchedInput(), right: emptyLatchedInput() },
    sides: { left: makeSide("left", config), right: makeSide("right", config) },
    balls: [],
    effects: [],
    wallObjects: [],
    arena: bakeFlatArena(),
    rally: {
      hitCount: 0,
      lastThresholdHitBy: null,
      exchangeLifeLost: { left: false, right: false },
      lastTouchSide: null,
      lastReceiver: "left",
      lastTouchTick: 0,
    },
    rng: {
      serve: deriveStream(seed, STREAM_SERVE),
      powerup: deriveStream(seed, STREAM_POWERUP),
      misc: deriveStream(seed, STREAM_MISC),
    },
    nextEntityId: 0,
    overtimeNextTick: null,
    overtimeStarted: false,
    stats: {
      firstBreachTick: { left: null, right: null },
      bricksDestroyed: { left: 0, right: 0 },
      longestRally: 0,
      powerupsUsed: { left: 0, right: 0 },
      livesLost: { left: 0, right: 0 },
    },
    pendingCrossings: [],
    config,
  };
  // Initial cache build (§4.4.3); creation-time events (0-layer sides are
  // breached from serve one) are discarded — nothing is listening yet.
  const scratch: GameEvent[] = [];
  recomputeAll(state, "left", "damage", scratch);
  recomputeAll(state, "right", "damage", scratch);
  return state;
}

function bufferEdgeInputs(latch: LatchedInput, input: TickInputs["left"]): void {
  input.paddles.forEach((p, i) => {
    latch.action[i] = (latch.action[i] ?? false) || p.action;
  });
  if (input.activateSlot !== null) latch.activateSlot = input.activateSlot;
  if (input.placement !== null) latch.placement = input.placement;
  if (input.placementWindow !== null) latch.placementWindow = input.placementWindow;
}

/**
 * Advance exactly one tick. MUTATES state in place; returns this tick's
 * events in emission order. Deterministic.
 */
export function stepMatch(state: MatchState, inputs: TickInputs): GameEvent[] {
  // Stage 0
  const events: GameEvent[] = [];
  state.tick += 1;
  simDiagnostics.reset();

  // Stage 1 — hit-stop: frozen ticks consume time and buffer edge inputs.
  if (state.freezeTicks > 0) {
    state.freezeTicks -= 1;
    bufferEdgeInputs(state.inputLatch.left, inputs.left);
    bufferEdgeInputs(state.inputLatch.right, inputs.right);
    return events;
  }

  // Stage 2 — match-FSM pre-step (timers, serve launch, life-lost end).
  preStep(state, events);

  // Stage 3 — latched + fresh discrete inputs (placement/powerups: Phase 5).
  state.inputLatch = { left: emptyLatchedInput(), right: emptyLatchedInput() };

  // Stage 4 — paddle kinematics.
  const paddleVelY: PerSide<number[]> = stepPaddles(state, inputs);

  // Stage 5 — powerup effect ticking (Phase 5).

  // Stage 6 — ball integration, ascending ball id. Iterate a snapshot: balls
  // may despawn mid-stage (crossings queue; resolution is stage 8, AR2-4).
  const ballIds = state.balls.map((b) => b.id);
  for (const id of ballIds) {
    const ball = state.balls.find((b) => b.id === id);
    if (ball) integrateBall(state, ball, paddleVelY, events);
  }

  // Stage 7 — object/placement cooldown ticking.
  for (const side of ["left", "right"] as const) {
    const s = state.sides[side];
    if (s.placementCooldownTicks > 0) s.placementCooldownTicks -= 1;
  }

  // Stage 8 — match-FSM post-step.
  postStep(state, events);

  // Stage 9 — dev-build invariant assertions (§12.2).
  if (import.meta.env.DEV) assertInvariants(state);

  return events;
}

function assertInvariants(state: MatchState): void {
  for (let i = 1; i < state.balls.length; i++) {
    if (state.balls[i]!.id <= state.balls[i - 1]!.id) {
      throw new Error("invariant: balls array must be id-sorted");
    }
  }
  for (const ball of state.balls) {
    const { x, y } = ball.pos;
    const m = 1; // skin margin
    if (
      x < -m ||
      x > ARENA_W + m ||
      y < topY(state.arena, x) - m ||
      y > bottomY(state.arena, x) + m
    ) {
      throw new Error(`invariant: ball ${ball.id} out of hull at (${x.toFixed(2)}, ${y.toFixed(2)})`);
    }
  }
  if (state.pendingCrossings.length !== 0) {
    throw new Error("invariant: pendingCrossings must be empty at tick end");
  }
  const j = state.config.tuning.juice;
  const maxFreeze = Math.max(j.hit_stop_brick_destroy, j.hit_stop_breach, j.hit_stop_life);
  if (state.freezeTicks > maxFreeze) {
    throw new Error("invariant: freezeTicks exceeds max hit-stop");
  }
}

/** Hand-written deep copy (§2.6). `config` is frozen — shared by reference. */
export function cloneMatchState(state: MatchState): MatchState {
  const cloneBall = (b: BallState): BallState => ({
    ...b,
    pos: { ...b.pos },
    vel: { ...b.vel },
    stuckToPaddle: b.stuckToPaddle ? { ...b.stuckToPaddle } : null,
  });
  const cloneSide = (s: SideState): SideState => ({
    ...s,
    paddles: s.paddles.map((p) => ({ ...p, zone: { ...p.zone } })),
    wall: {
      ...s.wall,
      layers: s.wall.layers.map((row) => row.map((c) => (c ? { ...c } : null))),
      layerSlots: s.wall.layerSlots.map((m) => ({ ...m })),
      breachedLanes: [...s.wall.breachedLanes],
      criticalLanes: [...s.wall.criticalLanes],
      pending: s.wall.pending.map((p) => ({
        ...p,
        returnable: p.returnable ? { ...p.returnable } : null,
      })),
    },
    slots: s.slots.map((sl) => ({ ...sl })),
    claimedThresholds: [...s.claimedThresholds],
    placementWindow: s.placementWindow ? { ...s.placementWindow } : null,
  });
  const cloneLatch = (l: LatchedInput): LatchedInput => ({
    action: [...l.action],
    activateSlot: l.activateSlot,
    placement: l.placement ? { ...l.placement } : null,
    placementWindow: l.placementWindow ? { ...l.placementWindow } : null,
  });
  return {
    ...state,
    phase: { ...state.phase },
    inputLatch: {
      left: cloneLatch(state.inputLatch.left),
      right: cloneLatch(state.inputLatch.right),
    },
    sides: { left: cloneSide(state.sides.left), right: cloneSide(state.sides.right) },
    balls: state.balls.map(cloneBall),
    effects: state.effects.map((e) => ({ ...e })),
    wallObjects: state.wallObjects.map((w) => ({
      ...w,
      ...(w.panelDir ? { panelDir: { ...w.panelDir } } : {}),
    })),
    arena: state.arena, // immutable after createMatch — shared
    rally: { ...state.rally, exchangeLifeLost: { ...state.rally.exchangeLifeLost } },
    rng: {
      serve: { ...state.rng.serve },
      powerup: { ...state.rng.powerup },
      misc: { ...state.rng.misc },
    },
    stats: {
      firstBreachTick: { ...state.stats.firstBreachTick },
      bricksDestroyed: { ...state.stats.bricksDestroyed },
      longestRally: state.stats.longestRally,
      powerupsUsed: { ...state.stats.powerupsUsed },
      livesLost: { ...state.stats.livesLost },
    },
    pendingCrossings: state.pendingCrossings.map((c) => ({ ...c })),
    config: state.config,
  };
}

/**
 * Order-stable FNV-1a 32-bit hash over the canonical serialization
 * (SPEC-3.12 §12.4). Excluded: `config` and `arena` (immutable inputs, not
 * mutable state) and `pendingCrossings` (intra-tick transient, asserted
 * empty — AR2-23).
 */
export function hashState(state: MatchState): number {
  let h = 0x811c9dc5;
  const write = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== "object") {
      write(JSON.stringify(value) ?? "undefined");
      return;
    }
    if (Array.isArray(value)) {
      write("[");
      for (const v of value) {
        walk(v);
        write(",");
      }
      write("]");
      return;
    }
    const obj = value as Record<string, unknown>;
    write("{");
    for (const key of Object.keys(obj).sort()) {
      write(key + ":");
      walk(obj[key]);
      write(",");
    }
    write("}");
  };
  const { config: _config, pendingCrossings: _pc, arena: _arena, ...hashed } = state;
  walk(hashed);
  return h >>> 0;
}
