/**
 * Raw key state → per-tick sampled SideInput (SPEC-3.1 §1.2 input/).
 * Phase 1 bindings are fixed: left = W/S (+E action), right = ↑/↓ (+Shift).
 * Rebindable keymap (bindings.ts) lands with the settings screen.
 */

import type { InputController, MoveDir, SideInput } from "./controller";
import { neutralSideInput } from "./controller";
import type { MatchState, Side } from "../sim/state";

export class KeyState {
  private readonly down = new Set<string>();

  attach(target: Window): void {
    target.addEventListener("keydown", (e) => {
      this.down.add(e.code);
    });
    target.addEventListener("keyup", (e) => {
      this.down.delete(e.code);
    });
    // Dropped keys on tab-away would stick — clear on blur.
    target.addEventListener("blur", () => this.down.clear());
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }
}

export interface KeyBindings {
  up: string;
  down: string;
  action: string;
}

export const DEFAULT_BINDINGS: { left: KeyBindings; right: KeyBindings } = {
  left: { up: "KeyW", down: "KeyS", action: "KeyE" },
  right: { up: "ArrowUp", down: "ArrowDown", action: "ShiftRight" },
};

export class HumanController implements InputController {
  constructor(
    private readonly keys: KeyState,
    private readonly bindings: KeyBindings,
  ) {}

  sample(_state: Readonly<MatchState>, _side: Side): SideInput {
    const input = neutralSideInput();
    const up = this.keys.isDown(this.bindings.up);
    const down = this.keys.isDown(this.bindings.down);
    const move: MoveDir = up === down ? 0 : up ? -1 : 1;
    input.paddles[0] = { move, action: this.keys.isDown(this.bindings.action) };
    return input;
  }
}
