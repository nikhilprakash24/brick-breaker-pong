/**
 * InputController boundary (SPEC-3.1 §1.3). Anything that produces inputs —
 * keyboard, AI, replay stream, scripted test driver — implements this;
 * main.ts calls sample() once per sim tick.
 */

import type { MatchState, Side } from "../sim/state";

export type MoveDir = -1 | 0 | 1; // -1 = up (−y), +1 = down (+y)

export interface PaddleInput {
  move: MoveDir;
  /** Sticky-paddle release (§11.6). Edge-triggered. */
  action: boolean;
}

export interface PlacementCommand {
  kind: "place_brick" | "extra_layer";
  slot: number;
  /** place_brick only: target cell on the OWN wall. */
  layer?: number;
  lane?: number;
}

export interface SideInput {
  /** paddles[0] always; paddles[1] only for split-paddle opponents. */
  paddles: PaddleInput[];
  /** Activate the powerup banked in this slot. Edge-triggered; null = none. */
  activateSlot: number | null;
  /** Placement confirm command, the tick it is issued. */
  placement: PlacementCommand | null;
  /** Human placement-mode window control (SPEC-OPEN-21). The AI never opens
   *  a window — it sends `placement` directly. Edge-triggered. */
  placementWindow: { action: "open"; slot: number } | { action: "cancel" } | null;
}

export interface TickInputs {
  left: SideInput;
  right: SideInput;
}

export interface InputController {
  /** MUST NOT mutate state. */
  sample(state: Readonly<MatchState>, side: Side): SideInput;
}

export function neutralSideInput(): SideInput {
  return {
    paddles: [{ move: 0, action: false }],
    activateSlot: null,
    placement: null,
    placementWindow: null,
  };
}

/** Placeholder until keyboard sampling lands in Phase 1. */
export class NullController implements InputController {
  sample(): SideInput {
    return neutralSideInput();
  }
}
