/**
 * Scripted reflex paddle for the Phase 2 batch runner and tests — the
 * "scripted paddles (or early AI)" of Tech Guide Phase 2. NOT the Phase 4
 * AiController (no prediction, no targeting brains): it tracks the nearest
 * inbound ball's y with a reaction delay and per-exchange gaussian aim
 * error. Deterministic: owns a private mulberry32 stream derived from the
 * match seed (streams 3/4, AR2-1) so it never touches sim RNG.
 */

import type { InputController, MoveDir, SideInput } from "../src/input/controller";
import { neutralSideInput } from "../src/input/controller";
import type { MatchState, Side } from "../src/sim/state";
import {
  deriveStream,
  mulberry32Next,
  rngGaussian,
  rngRange,
  rngSign,
  STREAM_AI_LEFT,
  STREAM_AI_RIGHT,
  type Rng,
} from "../src/sim/rng";

export interface ReflexBotStats {
  /** ticks before the bot reacts to a ball newly heading its way */
  reactionTicks: number;
  /** σ of the small always-on intercept error, in u — keeps returns roughly
   *  on the aimed lane (0.22 offset σ at 55 u coverage) */
  aimNoiseU: number;
  /** probability per inbound exchange of a whiff (a big, miss-sized error) */
  whiffChance: number;
  /** whiff magnitude range, in u (beyond paddle coverage ⇒ a miss) */
  whiffU: [number, number];
  /** dead zone around the target before it stops jittering, in u */
  deadZoneU: number;
}

/** Tuned as a mid-skill human proxy: small tracking error preserves aim
 *  (so drilling concentrates damage), and whiffs set the miss rate — the
 *  SPEC-2.9 rally-median target of 4–7 hits ⇒ whiff every ~6 returns. */
export const DEFAULT_BOT: ReflexBotStats = {
  reactionTicks: 34, // ≈283 ms
  aimNoiseU: 4, // offset σ ≈ 0.07 ⇒ landing σ ≈ 1.2 lanes across the court
  whiffChance: 0.22,
  whiffU: [60, 110],
  deadZoneU: 4,
};

export class ReflexBot implements InputController {
  private readonly rng: Rng;
  private inboundSince: number | null = null;
  private aimError = 0;

  constructor(
    side: Side,
    matchSeed: number,
    private readonly stats: ReflexBotStats = DEFAULT_BOT,
  ) {
    this.rng = deriveStream(matchSeed, side === "left" ? STREAM_AI_LEFT : STREAM_AI_RIGHT);
  }

  sample(state: Readonly<MatchState>, side: Side): SideInput {
    const input = neutralSideInput();
    const paddle = state.sides[side].paddles[0];
    if (!paddle) return input;
    const dir: MoveDir = this.decide(state, side, paddle.yCenter);
    input.paddles[0] = { move: dir, action: false };
    return input;
  }

  private decide(state: Readonly<MatchState>, side: Side, paddleY: number): MoveDir {
    const toward = side === "left" ? -1 : 1;
    const planeX =
      side === "left"
        ? state.config.tuning.paddle.paddle_plane_x_left
        : state.config.tuning.paddle.paddle_plane_x_right;
    let interceptY: number | null = null;
    let bestT = Infinity;
    for (const ball of state.balls) {
      if (Math.sign(ball.vel.x) !== toward || ball.vel.x === 0) continue;
      const t = (planeX - ball.pos.x) / ball.vel.x;
      if (t < 0 || t >= bestT) continue;
      bestT = t;
      // Linear projection with top/bottom wall folding (triangle wave).
      const raw = ball.pos.y + ball.vel.y * t;
      const m = ((raw % 1440) + 1440) % 1440;
      interceptY = m <= 720 ? m : 1440 - m;
    }
    let target: number;
    if (interceptY === null) {
      this.inboundSince = null;
      target = 360; // drift home between exchanges
    } else {
      if (this.inboundSince === null) {
        this.inboundSince = state.tick;
        this.aimError = rngGaussian(this.rng) * this.stats.aimNoiseU;
        if (mulberry32Next(this.rng) < this.stats.whiffChance) {
          const [lo, hi] = this.stats.whiffU;
          this.aimError += rngSign(this.rng) * rngRange(this.rng, lo, hi);
        }
      }
      if (state.tick - this.inboundSince < this.stats.reactionTicks) return 0;
      // Crude drill (early-AI stand-in for the Phase 4 focus/breach brains):
      // offset the intercept so the steered return heads at the opponent's
      // weakest lane — or straight through an existing breach.
      target = interceptY + this.aimError + this.aimOffsetU(state, side, interceptY);
    }
    const delta = target - paddleY;
    if (Math.abs(delta) <= this.stats.deadZoneU) return 0;
    return delta > 0 ? 1 : -1;
  }

  /** Paddle-center displacement (u) that steers the return toward the
   *  opponent's weakest lane, via the §3.6 offset-steering formula. */
  private aimOffsetU(state: Readonly<MatchState>, side: Side, contactY: number): number {
    const opp = state.sides[side === "left" ? "right" : "left"].wall;
    let targetLane = 0;
    let bestScore = Infinity;
    for (let lane = 0; lane < opp.laneCount; lane++) {
      let hp = 0;
      if (!opp.breachedLanes[lane]) {
        for (const row of opp.layers) hp += row[lane]?.hp ?? 0;
      }
      if (hp < bestScore) {
        bestScore = hp;
        targetLane = lane;
      }
    }
    const t = state.config.tuning;
    const laneY = (targetLane + 0.5) * (720 / opp.laneCount);
    const dx = Math.abs(
      (side === "left" ? t.paddle.paddle_plane_x_right : t.paddle.paddle_plane_x_left) -
        (side === "left" ? t.paddle.paddle_plane_x_left : t.paddle.paddle_plane_x_right),
    );
    const thetaDeg = (Math.atan2(laneY - contactY, dx) * 180) / Math.PI;
    const off = Math.max(-0.85, Math.min(0.85, thetaDeg / t.physics.max_bounce_angle));
    const paddle = state.sides[side].paddles[0]!;
    // steering: off = (ballY − center)/(halfH + r) ⇒ center = ballY − off·(halfH + r)
    return -off * (paddle.halfHeight + t.physics.ball_radius);
  }
}
