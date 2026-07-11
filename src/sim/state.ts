/**
 * MatchState & entity types (SPEC-3.2 §2.5) — the whole mutable world.
 * Everything is plain data (no methods, class instances, or DOM handles) so
 * deep copy, JSON serialization, and hashing stay trivial.
 *
 * Phase 1 carries the full shape; powerup-only fields (effects, slots,
 * pending placements) exist but stay empty until Phase 5.
 */

import type { Rng } from "./rng";
import type { MatchConfig } from "../config/types";
import type { PlacementCommand, SideInput } from "../input/controller";

export type Side = "left" | "right";
export type MaterialId = string; // key into materials.json
export type PowerupId = string; // key into powerups.json
export type LevelId = string;

export interface Vec2 {
  x: number;
  y: number;
}

export interface AABB {
  min: Vec2;
  max: Vec2;
}

/** Sweep result (§3.2/§3.3): t = time-of-impact fraction, normal unit-length. */
export interface Hit {
  t: number;
  normal: Vec2;
}

export interface PerSide<T> {
  left: T;
  right: T;
}

export function otherSide(side: Side): Side {
  return side === "left" ? "right" : "left";
}

/** Edge-triggered inputs buffered while freezeTicks > 0 (stage 1). Booleans
 *  OR-accumulate; nullable commands last-write-wins; drained in stage 3. */
export interface LatchedInput {
  action: boolean[]; // per paddle index
  activateSlot: number | null;
  placement: PlacementCommand | null;
  placementWindow: SideInput["placementWindow"];
}

export interface BallState {
  id: number;
  pos: Vec2;
  vel: Vec2; // u/s
  radius: number; // u
  /** speed multiplier snapshot applied at last rescale (§3.7) */
  speedMult: number;
  damage: 1 | 2; // heavy ball ⇒ 2
  heavyHitsLeft: number;
  curveAccel: number; // u/s², signed lateral; 0 = none
  stuckToPaddle: { side: Side; paddleIndex: number; offset: number } | null;
  lastHitBy: Side | null;
  /** sign of vx last time |vx| ≥ min clamp — fallback for the clamp (§3.6.3) */
  lastHorizontalDir: 1 | -1;
  justTeleported: boolean; // render snap flag (§2.3)
}

export interface PaddleState {
  index: number; // 0, or 0|1 for split opponents
  yCenter: number; // u
  halfHeight: number; // u
  x: number; // front-face plane x (fixed per side)
  speed: number; // u/s
  zone: { yMin: number; yMax: number }; // travel clamp for yCenter
  stickyArmed: boolean;
}

/** A LIVE brick; open cells are null. */
export interface BrickCell {
  material: MaterialId;
  hp: number;
  maxHp: number;
}

/** Depth-slot metadata parallel to layers[] (§4.1 slot rule). */
export interface WallLayerMeta {
  slot: 0 | 1 | 2 | 3;
}

export interface PendingCell {
  slot: 0 | 1 | 2 | 3;
  lane: number;
  material: MaterialId;
  createsLayer: boolean;
  returnable: { slotIndex: number; powerupId: PowerupId } | null;
  ticksLeft: number | null;
}

export interface WallState {
  side: Side;
  laneCount: number;
  /** layers[0] = frontmost (court-facing). length 0..4. null = open cell. */
  layers: (BrickCell | null)[][];
  /** parallel to layers[]: which depth slot each layer occupies (§4.1) */
  layerSlots: WallLayerMeta[];
  /** derived caches, kept in sync by breach.ts — NEVER computed ad hoc */
  breachedLanes: boolean[];
  breachCount: number;
  criticalLanes: boolean[];
  startingLayerCount: number; // 0..3
  shieldCharges: number;
  pending: PendingCell[];
}

export interface EffectInstance {
  id: number;
  powerupId: PowerupId;
  ownerSide: Side;
  targetSide: Side;
  remainingTicks: number | null;
  magnitude: number;
}

export interface SlotState {
  powerupId: PowerupId | null;
  locked: boolean;
}

export interface SideState {
  lives: number;
  paddles: PaddleState[];
  wall: WallState;
  slots: SlotState[];
  claimedThresholds: number[];
  extraBallSign: 1 | -1;
  placementCooldownTicks: number;
  placementWindow: { slot: number; powerupId: PowerupId; ticksLeft: number } | null;
}

export type MatchPhase =
  | { kind: "intro"; ticksLeft: number }
  | { kind: "serving"; receiver: Side; ticksLeft: number }
  | { kind: "rally" }
  | { kind: "lifeLostSeq"; loser: Side | "both"; ticksLeft: number }
  | { kind: "matchOver"; winner: Side };

export interface RallyState {
  hitCount: number; // GLOBAL, unbounded; cap applied at lookup (AR2-2)
  lastThresholdHitBy: Side | null;
  exchangeLifeLost: PerSide<boolean>;
  lastTouchSide: Side | null;
  lastReceiver: Side;
  lastTouchTick: number; // stall watchdog bookkeeping (R-5.4)
}

/** Arena collision geometry, baked once at createMatch (§3.8.2). */
export interface ArenaSegment {
  id: number;
  a: Vec2;
  b: Vec2;
  normal: Vec2; // unit, points INTO the court
  aabb: AABB;
  kind: "boundary" | "back" | "oneWay" | "lever" | "panel";
  /** back boundaries only: which side's wall this sits behind */
  backSide: Side | null;
  objectIndex: number; // → wallObjects[] for lever/panel/oneWay, else -1
}

/** Slope elevation profile for field mode (§3.8.4); null on non-slope arenas. */
export interface SlopeProfile {
  mode: "reflection_only" | "field";
  rampStartX: number;
  plateauStartX: number;
  plateauEndX: number;
  rampEndX: number;
  slopeHeight: number; // H
}

export interface ArenaRuntime {
  segments: ArenaSegment[];
  topVerts: Vec2[];
  bottomVerts: Vec2[];
  slope: SlopeProfile | null;
}

export interface WallObjectState {
  index: number;
  kind: "lever" | "panel" | "oneWay";
  segmentId: number;
  cooldownTicks: number;
  cooldownTotal: number;
  panelDir?: Vec2; // panel: unit direction (color-resolved)
  flipped?: boolean; // panel_flip powerup (Phase 5)
  blockNormal?: Vec2; // oneWay: reflect iff vel·blockNormal < 0 (§3.3)
}

/** MatchStatsSummary accumulator — sim-tracked so rules.ts can embed the
 *  summary in MatchOver (SPEC-3.5 §5.2). */
export interface StatsAcc {
  firstBreachTick: { left: number | null; right: number | null };
  bricksDestroyed: PerSide<number>;
  longestRally: number;
  powerupsUsed: PerSide<number>;
  livesLost: PerSide<number>;
}

/** Embedded in MatchOver for the results screen. */
export interface MatchStatsSummary {
  durationTicks: number;
  firstBreachTick: { left?: number; right?: number };
  bricksDestroyed: PerSide<number>;
  longestRally: number;
  powerupsUsed: PerSide<number>;
  livesLost: PerSide<number>;
}

export interface PendingCrossing {
  side: Side; // the DEFENDER who conceded
  lane: number;
  ballId: number;
}

export interface MatchState {
  tick: number;
  matchSeed: number;
  phase: MatchPhase;
  freezeTicks: number;
  inputLatch: PerSide<LatchedInput>;
  sides: PerSide<SideState>;
  balls: BallState[]; // sorted by id ascending (determinism)
  effects: EffectInstance[];
  wallObjects: WallObjectState[];
  arena: ArenaRuntime; // immutable after createMatch
  rally: RallyState;
  rng: { serve: Rng; powerup: Rng; misc: Rng };
  nextEntityId: number;
  overtimeNextTick: number | null;
  overtimeStarted: boolean;
  stats: StatsAcc;
  /** Queued by stage 6, resolved by stage 8 same tick. Always empty at tick
   *  end (asserted); EXCLUDED from hashState (AR2-23). */
  pendingCrossings: PendingCrossing[];
  config: Readonly<MatchConfig>; // frozen; shared by reference on clone
}

export function emptyLatchedInput(): LatchedInput {
  return { action: [], activateSlot: null, placement: null, placementWindow: null };
}
