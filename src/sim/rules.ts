/**
 * Match FSM (SPEC-3.6 §6.2, rows M1–M11) + hit-stop. Runs as stage 2
 * (pre-step: phase timers, serve launch, life-lost resolution) and stage 8
 * (post-step: queued crossings, all-balls-dead, overtime, stall watchdog)
 * of stepMatch (§2.2).
 */

import type { GameEvent } from "./events";
import type { MatchState, MatchStatsSummary, PendingCrossing, Side } from "./state";
import { otherSide } from "./state";
import { mulberry32Next, rngRange } from "./rng";
import { damageCell, rebuildWall } from "./wall";
import { recomputeAll } from "./breach";
import { removeBall } from "./physics/resolve";
import { setGlobalHitCount } from "./speed";
import { clampMinVx } from "./physics/reflect";
import { bottomY, topY, ARENA_W } from "./geometry";
import { SIM_HZ } from "../config/types";

const DEG = Math.PI / 180;

function changePhase(state: MatchState, to: MatchState["phase"], events: GameEvent[]): void {
  const from = state.phase.kind;
  state.phase = to;
  events.push({ type: "MatchPhaseChanged", from, to: to.kind });
}

/** Rally-scoped resets on entry to serving (M2/M5/M6 note, §6.2). */
function enterServing(state: MatchState, receiver: Side, events: GameEvent[]): void {
  setGlobalHitCount(state, 0, events);
  state.rally.exchangeLifeLost = { left: false, right: false };
  state.rally.lastTouchSide = null;
  state.rally.lastReceiver = receiver;
  state.rally.lastTouchTick = state.tick;
  state.sides.left.claimedThresholds = [];
  state.sides.right.claimedThresholds = [];
  changePhase(
    state,
    { kind: "serving", receiver, ticksLeft: state.config.tuning.rules.serve_delay },
    events,
  );
}

function coinFlipSide(state: MatchState): Side {
  return mulberry32Next(state.rng.serve) < 0.5 ? "left" : "right";
}

/** M2: spawn the serve ball at court center, toward the receiver (R-2.4/2.5). */
function launchServe(state: MatchState, receiver: Side, events: GameEvent[]): void {
  const tuning = state.config.tuning;
  const originX = ARENA_W / 2;
  const originY = (topY(state.arena, originX) + bottomY(state.arena, originX)) / 2;
  const angle = rngRange(
    state.rng.serve,
    -tuning.rules.serve_angle_max * DEG,
    +tuning.rules.serve_angle_max * DEG,
  );
  const dir = receiver === "left" ? -1 : 1; // ball travels TOWARD the receiver
  const speed = tuning.physics.ball_base_speed; // rally counter is 0 at serve
  const ball = {
    id: state.nextEntityId++,
    pos: { x: originX, y: originY },
    vel: { x: Math.cos(angle) * speed * dir, y: Math.sin(angle) * speed },
    radius: tuning.physics.ball_radius,
    speedMult: 1.0,
    damage: 1 as const,
    heavyHitsLeft: 0,
    curveAccel: 0,
    stuckToPaddle: null,
    lastHitBy: null,
    lastHorizontalDir: dir as 1 | -1,
    justTeleported: true,
  };
  clampMinVx(ball, tuning);
  state.balls.push(ball);
  changePhase(state, { kind: "rally" }, events);
  events.push({ type: "Serve", receiver, ballId: ball.id, vel: { ...ball.vel } });
  events.push({ type: "BallSpawned", ballId: ball.id, cause: "serve", pos: { ...ball.pos } });
}

/** Stage 2 — phase timers (M1, M2, M6/M7/M10). */
export function preStep(state: MatchState, events: GameEvent[]): void {
  const phase = state.phase;
  switch (phase.kind) {
    case "intro": {
      phase.ticksLeft -= 1;
      if (phase.ticksLeft <= 0) {
        // M1: receiver — Phase 1 runs local versus: coin flip (R-2.1);
        // config pins it for story/tests.
        const first = state.config.rules.first_receiver;
        const receiver = first === "random" ? coinFlipSide(state) : first;
        enterServing(state, receiver, events);
      }
      return;
    }
    case "serving": {
      phase.ticksLeft -= 1;
      if (phase.ticksLeft <= 0) launchServe(state, phase.receiver, events); // auto-launch (R-2.5)
      return;
    }
    case "lifeLostSeq": {
      phase.ticksLeft -= 1;
      if (phase.ticksLeft > 0) return;
      const zeroSides = (["left", "right"] as const).filter((s) => state.sides[s].lives <= 0);
      if (zeroSides.length === 2) {
        // M10 — sudden death (R-6.4): both restored to 1 life, walls kept.
        state.sides.left.lives = 1;
        state.sides.right.lives = 1;
        events.push({ type: "SuddenDeath" });
        enterServing(state, coinFlipSide(state), events);
        return;
      }
      if (zeroSides.length === 1) {
        // M7 — match over.
        const winner = otherSide(zeroSides[0]!);
        changePhase(state, { kind: "matchOver", winner }, events);
        events.push({
          type: "MatchOver",
          winner,
          ticks: state.tick,
          stats: buildStats(state),
        });
        return;
      }
      // M6 — rebuild loser wall(s), receiver = loser (R-2.2).
      const loser = phase.loser;
      const losers: Side[] = loser === "both" ? ["left", "right"] : [loser];
      for (const s of losers) {
        rebuildWall(state, s, events);
        recomputeAll(state, s, "rebuild", events);
      }
      const receiver = loser === "both" ? coinFlipSide(state) : loser;
      enterServing(state, receiver, events);
      return;
    }
    case "rally":
    case "matchOver":
      return;
  }
}

/** Stage 8 — queued crossings (M3′), M5, overtime (M9), stall (M11), hit-stop. */
export function postStep(state: MatchState, events: GameEvent[]): void {
  const tuning = state.config.tuning;

  if (state.phase.kind === "rally") {
    // M3′ — resolve back-boundary crossings queued by stage 6 (AR2-4).
    if (state.pendingCrossings.length > 0) {
      resolveCrossings(state, state.pendingCrossings, events);
      state.pendingCrossings = [];
    } else {
      // M11 — stall watchdog (R-5.4).
      applyStallWatchdog(state, events);
      // M5 — all balls dead without life loss (R-4.8 → R-2.3).
      if (state.balls.length === 0 && state.phase.kind === "rally") {
        const receiver =
          state.rally.lastTouchSide !== null
            ? otherSide(state.rally.lastTouchSide)
            : state.rally.lastReceiver;
        enterServing(state, receiver, events);
      }
      // M9 — overtime decay (R-6.3).
      if (state.phase.kind === "rally") applyOvertime(state, events);
    }
  }

  applyHitStop(state, events, tuning.juice);
}

function resolveCrossings(
  state: MatchState,
  crossings: PendingCrossing[],
  events: GameEvent[],
): void {
  const perBall = state.config.rules.life_loss_per_exchange === "per_ball";
  const seen = new Set<Side>();
  const losers = new Set<Side>();
  for (const c of crossings) {
    if (!perBall && seen.has(c.side)) continue; // dedup per side unless per_ball
    seen.add(c.side);
    losers.add(c.side);
    state.sides[c.side].lives -= 1;
    state.stats.livesLost[c.side] += 1;
    events.push({
      type: "LifeLost",
      side: c.side,
      livesLeft: state.sides[c.side].lives,
      lane: c.lane,
      ballId: c.ballId,
    });
  }
  // Despawn ALL remaining balls same tick (R-4.6 "immediately").
  for (const ball of [...state.balls]) {
    removeBall(state, ball.id, "exchangeEnd", events);
  }
  const loser: Side | "both" = losers.size === 2 ? "both" : [...losers][0]!;
  changePhase(
    state,
    { kind: "lifeLostSeq", loser, ticksLeft: state.config.tuning.rules.life_lost_seq },
    events,
  );
}

function applyOvertime(state: MatchState, events: GameEvent[]): void {
  const tuning = state.config.tuning;
  if (!state.config.rules.overtime_enabled) return;
  const startTick = state.config.rules.overtime_start ?? tuning.rules.overtime_start;
  if (state.tick <= startTick) return;
  if (!state.overtimeStarted) {
    state.overtimeStarted = true;
    state.overtimeNextTick = state.tick + tuning.rules.overtime_tick_period;
    events.push({ type: "OvertimeStarted" });
    return;
  }
  if (state.overtimeNextTick !== null && state.tick >= state.overtimeNextTick) {
    state.overtimeNextTick = state.tick + tuning.rules.overtime_tick_period;
    events.push({ type: "OvertimeTick" });
    // 1 damage to ALL surviving bricks BOTH sides via the single mutator;
    // never resets rally/speed, never emits SpeedReset (AR2-14).
    for (const side of ["left", "right"] as const) {
      const wall = state.sides[side].wall;
      for (let layer = wall.layers.length - 1; layer >= 0; layer--) {
        for (let lane = 0; lane < wall.laneCount; lane++) {
          if (wall.layers[layer]![lane]) {
            overtimeDamage(state, side, layer, lane, events);
          }
        }
      }
    }
  }
}

/** Overtime routes through the single wall.damageCell mutator (§4.2). */
function overtimeDamage(
  state: MatchState,
  side: Side,
  layer: number,
  lane: number,
  events: GameEvent[],
): void {
  damageCell(state, side, layer, lane, 1, null, events);
}

function applyStallWatchdog(state: MatchState, events: GameEvent[]): void {
  const tuning = state.config.tuning;
  if (state.balls.length === 0) return;
  const idle = state.tick - state.rally.lastTouchTick;
  const soft = tuning.rules.stall_soft_timeout;
  const hard = soft + tuning.rules.stall_hard_timeout;
  if (idle > hard) {
    // Void the exchange: despawn all balls, no life lost (→ M5 path).
    for (const ball of [...state.balls]) removeBall(state, ball.id, "stall", events);
    return;
  }
  if (idle > soft) {
    // Direction-only homing (AR2-20): add accel toward the nearest paddle,
    // renormalize |vel| to its pre-nudge magnitude, then min-|vx| clamp.
    for (const ball of state.balls) {
      const target = nearestPaddleTarget(state, ball.pos.x, ball.pos.y);
      const speed = Math.hypot(ball.vel.x, ball.vel.y);
      if (speed <= 0) continue;
      const dx = target.x - ball.pos.x;
      const dy = target.y - ball.pos.y;
      const dist = Math.hypot(dx, dy) || 1;
      const a = (tuning.rules.stall_nudge_accel * 1) / SIM_HZ;
      ball.vel.x += (dx / dist) * a;
      ball.vel.y += (dy / dist) * a;
      const s = speed / Math.hypot(ball.vel.x, ball.vel.y);
      ball.vel.x *= s;
      ball.vel.y *= s;
      clampMinVx(ball, tuning);
    }
  }
}

function nearestPaddleTarget(state: MatchState, x: number, y: number): { x: number; y: number } {
  let best = { x: 0, y: 0 };
  let bestDist = Infinity;
  for (const side of ["left", "right"] as const) {
    for (const p of state.sides[side].paddles) {
      const d = Math.hypot(p.x - x, p.yCenter - y);
      if (d < bestDist) {
        bestDist = d;
        best = { x: p.x, y: p.yCenter };
      }
    }
  }
  return best;
}

/** Hit-stop (§5.4): rules.ts sets freezeTicks AND emits HitStop. Overtime
 *  brick destruction (byBallId null) does not trigger it; breach does. */
function applyHitStop(
  state: MatchState,
  events: GameEvent[],
  juice: { hit_stop_brick_destroy: number; hit_stop_breach: number; hit_stop_life: number },
): void {
  let ticks = 0;
  let cause: "brickDestroyed" | "breach" | "lifeLost" | null = null;
  for (const e of events) {
    if (e.type === "BrickDestroyed" && e.byBallId !== null && juice.hit_stop_brick_destroy > ticks) {
      ticks = juice.hit_stop_brick_destroy;
      cause = "brickDestroyed";
    } else if ((e.type === "BreachOpened" || e.type === "BreachWidened") && juice.hit_stop_breach > ticks) {
      ticks = juice.hit_stop_breach;
      cause = "breach";
    } else if (e.type === "LifeLost" && juice.hit_stop_life > ticks) {
      ticks = juice.hit_stop_life;
      cause = "lifeLost";
    }
  }
  if (cause !== null && ticks > state.freezeTicks) {
    state.freezeTicks = ticks;
    events.push({ type: "HitStop", ticks, cause });
  }
}

function buildStats(state: MatchState): MatchStatsSummary {
  const fb = state.stats.firstBreachTick;
  const firstBreachTick: { left?: number; right?: number } = {};
  if (fb.left !== null) firstBreachTick.left = fb.left;
  if (fb.right !== null) firstBreachTick.right = fb.right;
  return {
    durationTicks: state.tick,
    firstBreachTick,
    bricksDestroyed: { ...state.stats.bricksDestroyed },
    longestRally: state.stats.longestRally,
    powerupsUsed: { ...state.stats.powerupsUsed },
    livesLost: { ...state.stats.livesLost },
  };
}
