/**
 * GameEvent — the complete discriminated union (SPEC-3.5 §5.2).
 *
 * Events are plain data appended to a per-tick array and returned from
 * stepMatch in emission order; the bus lives in main.ts dispatch. Each
 * `type` string literal may appear at exactly one emission point outside
 * this file and tests (SPEC-3.5 §5.3 — grep-auditable).
 */

import type {
  MatchPhase,
  MatchStatsSummary,
  MaterialId,
  PowerupId,
  Side,
  Vec2,
} from "./state";

export type GameEvent =
  // ── ball & rally ──────────────────────────────────────────────────────────
  | { type: "Serve"; receiver: Side; ballId: number; vel: Vec2 }
  | {
      type: "BallPaddleHit";
      side: Side;
      paddleIndex: number;
      ballId: number;
      hitCount: number;
      speedMult: number;
      offset: number; // −1..1
    }
  | { type: "BallBackFaceHit"; side: Side; ballId: number; boosted: boolean }
  | { type: "SpeedReset"; ballId: number; cause: "brick" | "serve" }
  | { type: "SpeedTierChanged"; tier: 0 | 1 | 2 | 3; hitCount: number }
  | { type: "BallSpawned"; ballId: number; cause: "serve" | "powerup"; pos: Vec2 }
  | {
      type: "BallRemoved";
      ballId: number;
      cause: "lifeLost" | "shield" | "exchangeEnd" | "absorbed" | "stall";
    }
  | { type: "StickyCaught"; side: Side; ballId: number }
  | { type: "StickyReleased"; side: Side; ballId: number }
  // ── wall & breach ─────────────────────────────────────────────────────────
  | {
      type: "BrickDamaged";
      side: Side;
      layer: number;
      lane: number;
      material: MaterialId;
      hpLeft: number;
      hpFrac: number;
      byBallId: number | null; // null = overtime decay (R-6.3, AR2-14)
    }
  | {
      type: "BrickDestroyed";
      side: Side;
      layer: number;
      lane: number;
      material: MaterialId;
      byBallId: number | null;
    }
  | { type: "LaneCritical"; side: Side; lane: number }
  | { type: "LaneCriticalCleared"; side: Side; lane: number }
  | { type: "BreachOpened"; side: Side; lane: number; width: number }
  | { type: "BreachWidened"; side: Side; lane: number; width: number }
  | { type: "BreachClosed"; side: Side; lane: number; cause: "placement" | "rebuild" }
  | { type: "BrickPlaced"; side: Side; layer: number; lane: number; material: MaterialId }
  | { type: "LayerAdded"; side: Side; slot: number; material: MaterialId; sparse: boolean }
  | {
      type: "PlacementRejected";
      side: Side;
      reason: "cap" | "occupied" | "phase" | "badSlot" | "cooldown";
    }
  | { type: "PlacementPending"; side: Side; slot: number; lane: number }
  | {
      type: "PlacementReturned";
      side: Side;
      slotIndex: number;
      powerupId: PowerupId;
      cause: "windowExpired" | "pendingTimeout" | "lifeLost" | "matchOver";
    }
  | { type: "WallRebuilt"; side: Side; mode: "full" | "breach_fill" }
  | { type: "ShieldConsumed"; side: Side; chargesLeft: number; ballId: number }
  // ── lives & match flow ────────────────────────────────────────────────────
  | { type: "LifeLost"; side: Side; livesLeft: number; lane: number; ballId: number }
  | { type: "MatchPhaseChanged"; from: MatchPhase["kind"]; to: MatchPhase["kind"] }
  | { type: "OvertimeStarted" }
  | { type: "OvertimeTick" }
  | { type: "SuddenDeath" }
  | { type: "MatchOver"; winner: Side; ticks: number; stats: MatchStatsSummary }
  // ── powerups ──────────────────────────────────────────────────────────────
  | {
      type: "RallyThreshold";
      hitCount: number;
      claimedBy: Side;
      tier: "minor" | "medium" | "major";
    }
  | { type: "PowerupEarned"; side: Side; slot: number; powerupId: PowerupId; tier: string }
  | { type: "PowerupEarnedLost"; side: Side; powerupId: PowerupId }
  | {
      type: "PowerupActivated";
      side: Side;
      slot: number;
      powerupId: PowerupId;
      effectId: number | null;
    }
  | { type: "PowerupExpired"; effectId: number; powerupId: PowerupId; targetSide: Side }
  // ── objects & misc ────────────────────────────────────────────────────────
  | {
      type: "WallObjectTriggered";
      objectIndex: number;
      kind: "lever" | "panel";
      ballId: number;
      newVel: Vec2;
    }
  | { type: "WallSegmentHit"; segmentId: number; ballId: number }
  | { type: "HitStop"; ticks: number; cause: "brickDestroyed" | "breach" | "lifeLost" };
