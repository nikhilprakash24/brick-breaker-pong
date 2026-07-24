/**
 * AiController (SPEC-3.9 §9.1). An ordinary InputController with no
 * privileged channel: it sees Readonly<MatchState>, moves through the same
 * paddle kinematics, and emits the same SideInput a human would. All
 * randomness is from its private stream (deriveStream ids 3/4, AR2-1) — never
 * stored in or read from MatchState, so the AI is fully deterministic and
 * replayable and provably changes nothing except through its inputs.
 *
 * Per-tick pipeline: Perception (throttled, noisy, reaction-delayed ball
 * futures) → InterceptPlanner (desired y per paddle, split-zone assignment) →
 * TargetingBrain (contact offset for the imminent hit) → Actuator (→ MoveDir)
 * → PlacementPlanner + PowerupPolicy.
 */

import type { InputController, MoveDir, SideInput } from "../../input/controller";
import type { MatchState, PaddleState, Side } from "../state";
import type { ResolvedOpponent } from "../../config/opponents";
import { deriveStream, rngGaussian, STREAM_AI_LEFT, STREAM_AI_RIGHT, type Rng } from "../rng";
import { DT_MS } from "../../config/types";
import { predictBall, type BallPlan } from "./predict";
import { chooseReturnOffset, newBrainMemory, type BrainMemory } from "./targeting";
import { proposePlacement } from "./placement";
import { chooseActivation } from "./powerupPolicy";

const DT_S = DT_MS / 1000;
const msToTicks = (ms: number): number => Math.max(1, Math.round(ms / DT_MS));

interface InboundTrack {
  noise: number; // held between opponent hits
  sinceTick: number; // when this inbound began (reaction clock)
  aimOffset: number | null; // cached bounce-aware aim (computed once at commit)
  aimTick: number; // tick the aim was chosen (refresh cadence)
}

export class AiController implements InputController {
  private readonly rng: Rng;
  private readonly reactionTicks: number;
  private readonly replanTicks: number;
  private readonly mem: BrainMemory = newBrainMemory();

  private plans: BallPlan[] = [];
  private lastPlanTick = -1;
  private readonly vxSign = new Map<number, number>();
  private readonly inbound = new Map<number, InboundTrack>();

  constructor(
    private readonly opponent: ResolvedOpponent,
    private readonly side: Side,
    matchSeed: number,
  ) {
    this.rng = deriveStream(matchSeed, side === "left" ? STREAM_AI_LEFT : STREAM_AI_RIGHT);
    this.reactionTicks = msToTicks(opponent.perception.reactionMs);
    this.replanTicks = msToTicks(opponent.perception.replanMs);
  }

  sample(readonly: Readonly<MatchState>, side: Side): SideInput {
    const state = readonly as MatchState;
    const paddles = state.sides[side].paddles;
    const input: SideInput = {
      paddles: paddles.map(() => ({ move: 0 as MoveDir, action: false })),
      activateSlot: null,
      placement: null,
      placementWindow: null,
    };
    if (state.phase.kind === "matchOver" || state.phase.kind === "intro") {
      // Station centrally; no aiming during non-play phases.
      paddles.forEach((p, i) => (input.paddles[i] = { move: this.actuate(p, this.center(p)), action: false }));
      return input;
    }

    this.updatePlans(state, side);
    this.updateInbound(state);

    const assignment = this.assignPlansToPaddles(state, side, paddles);
    paddles.forEach((p, i) => {
      const plan = assignment[i];
      let desiredY: number;
      if (plan && this.committed(state, plan.ballId)) {
        const track = this.inbound.get(plan.ballId)!;
        const contactY = (plan.interceptY ?? p.yCenter) + track.noise;
        const ball = state.balls.find((b) => b.id === plan.ballId);
        const speed = ball ? Math.hypot(ball.vel.x, ball.vel.y) : state.config.tuning.physics.ball_base_speed;
        // Choose the aim ONCE per commit — the bounce-aware search runs a
        // handful of predicts and must not repeat every tick/replan. The
        // target lane has its own hysteresis, so a per-commit choice is stable.
        if (track.aimOffset === null) {
          track.aimOffset = chooseReturnOffset(
            this.opponent.targeting,
            state,
            side,
            contactY,
            speed,
            this.mem,
            this.rng,
          );
          track.aimTick = state.tick;
        }
        const r = state.config.tuning.physics.ball_radius;
        desiredY = contactY - track.aimOffset * (p.halfHeight + r);
      } else {
        desiredY = this.station(state, side, p);
      }
      const clamped = Math.max(p.zone.yMin, Math.min(p.zone.yMax, desiredY));
      input.paddles[i] = { move: this.actuate(p, clamped), action: false };
    });

    // Placement + powerup firing (dormant until powerup earning, Phase 5).
    if (this.opponent.placement.style !== "never") {
      input.placement = proposePlacement(state, side, this.opponent.placement.style);
    }
    input.activateSlot = chooseActivation(state, side, this.opponent.powerup.style);
    return input;
  }

  // ── perception ──────────────────────────────────────────────────────────────

  private updatePlans(state: MatchState, side: Side): void {
    // Replan on: a ball's vx sign flip (opponent/wall hit) OR the ball SET
    // changing (spawn/despawn) — otherwise a mid-rally despawn would leave a
    // stale plan for a ball that no longer exists until the throttle expires.
    const liveIds = new Set(state.balls.map((b) => b.id));
    let dirty = liveIds.size !== this.vxSign.size;
    for (const b of state.balls) {
      const s = Math.sign(b.vel.x);
      if (this.vxSign.get(b.id) !== s) dirty = true;
      this.vxSign.set(b.id, s);
    }
    for (const id of [...this.vxSign.keys()]) if (!liveIds.has(id)) this.vxSign.delete(id);
    if (!dirty && state.tick - this.lastPlanTick < this.replanTicks) return;
    this.lastPlanTick = state.tick;
    this.plans = state.balls
      .map((b) => predictBall(state, b.id, side, state.config.tuning.ai.ai_predict_max_ticks))
      .filter((p) => p.interceptY !== null);
  }

  /** Track newly-inbound balls (fresh noise per opponent hit / serve). */
  private updateInbound(state: MatchState): void {
    // Prune by BOTH the live ball set and the current plans, so a despawned
    // ball can never keep an inbound track alive.
    const liveBalls = new Set(state.balls.map((b) => b.id));
    const live = new Set(this.plans.map((p) => p.ballId).filter((id) => liveBalls.has(id)));
    for (const id of [...this.inbound.keys()]) if (!live.has(id)) this.inbound.delete(id);
    for (const plan of this.plans) {
      if (!this.inbound.has(plan.ballId)) {
        this.inbound.set(plan.ballId, {
          noise: rngGaussian(this.rng) * this.opponent.perception.aimNoiseU,
          sinceTick: state.tick,
          aimOffset: null,
          aimTick: 0,
        });
      }
    }
  }

  private committed(state: MatchState, ballId: number): boolean {
    const t = this.inbound.get(ballId);
    return t !== undefined && state.tick - t.sinceTick >= this.reactionTicks;
  }

  // ── intercept & stations ────────────────────────────────────────────────────

  private assignPlansToPaddles(
    state: MatchState,
    side: Side,
    paddles: PaddleState[],
  ): (BallPlan | null)[] {
    void side;
    const sorted = [...this.plans].sort((a, b) => a.interceptTick - b.interceptTick);
    const out: (BallPlan | null)[] = paddles.map(() => null);
    const taken = new Set<number>();
    // Each paddle claims its earliest-arriving plan whose intercept y is in
    // (or nearest to) its zone. Split paddles thus each defend their band.
    for (let i = 0; i < paddles.length; i++) {
      for (const plan of sorted) {
        if (taken.has(plan.ballId)) continue;
        const y = plan.interceptY!;
        const owns = paddles.length === 1 || this.nearestPaddle(paddles, y) === i;
        if (owns) {
          out[i] = plan;
          taken.add(plan.ballId);
          break;
        }
      }
    }
    return out;
  }

  private nearestPaddle(paddles: PaddleState[], y: number): number {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < paddles.length; i++) {
      const p = paddles[i]!;
      const center = (p.zone.yMin + p.zone.yMax) / 2;
      const d = y < p.zone.yMin ? p.zone.yMin - y : y > p.zone.yMax ? y - p.zone.yMax : 0;
      const dist = d === 0 ? Math.abs(y - center) : d;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }

  private station(state: MatchState, side: Side, p: PaddleState): number {
    if (this.opponent.station === "denial") {
      // Park at the own most-critical lane (min total HP; tie → nearest).
      const wall = state.sides[side].wall;
      const laneH = 720 / wall.laneCount;
      let bestLane = 0;
      let bestHp = Infinity;
      let bestDist = Infinity;
      for (let lane = 0; lane < wall.laneCount; lane++) {
        let hp = 0;
        for (const row of wall.layers) hp += row[lane]?.hp ?? 0;
        const y = (lane + 0.5) * laneH;
        const dist = Math.abs(y - p.yCenter);
        if (hp < bestHp || (hp === bestHp && dist < bestDist)) {
          bestHp = hp;
          bestDist = dist;
          bestLane = lane;
        }
      }
      return (bestLane + 0.5) * laneH;
    }
    return this.center(p);
  }

  private center(p: PaddleState): number {
    return (p.zone.yMin + p.zone.yMax) / 2;
  }

  // ── actuator (never teleports; only outputs MoveDir) ────────────────────────

  private actuate(p: PaddleState, desiredY: number): MoveDir {
    const delta = desiredY - p.yCenter;
    const deadZone = Math.max(2, p.speed * DT_S * 0.5);
    if (Math.abs(delta) < deadZone) return 0;
    return delta > 0 ? 1 : -1;
  }
}
