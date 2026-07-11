/**
 * Replay determinism (Phase 1 DoD / SPEC-3.12 §12.4): a recorded input
 * sequence replays deterministically — every 600-tick checkpoint hash
 * matches on re-run; a divergent run is caught at the first checkpoint.
 */

import { describe, expect, it } from "vitest";
import { recordRun, verifyReplay } from "../src/persistence/replayStore";
import { deriveStream, mulberry32Next } from "../src/sim/rng";
import { moveInputs, testMatchConfig } from "./helpers";

describe("replay record → verify", () => {
  it("5000 ticks of scripted play verifies hash-equal at every checkpoint", () => {
    const config = testMatchConfig({ rules: { first_receiver: "left" } });
    const script = deriveStream(777, 42);
    let mL: -1 | 0 | 1 = 0;
    let mR: -1 | 0 | 1 = 0;
    const { blob } = recordRun(config, 777, 5000, (_state, tick) => {
      if (tick % 11 === 0) mL = ([-1, 0, 1] as const)[Math.floor(mulberry32Next(script) * 3)]!;
      if (tick % 13 === 0) mR = ([-1, 0, 1] as const)[Math.floor(mulberry32Next(script) * 3)]!;
      return moveInputs(mL, mR);
    });
    expect(blob.checkpoints.length).toBeGreaterThanOrEqual(8);
    const result = verifyReplay(config, blob);
    expect(result.firstDivergence).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.checkpointsCompared).toBe(blob.checkpoints.length);
  });

  it("a tampered input stream is caught at the first divergent checkpoint", () => {
    const config = testMatchConfig({ rules: { first_receiver: "left" } });
    const { blob } = recordRun(config, 42, 2000, (_state, tick) =>
      moveInputs(tick % 2 === 0 ? 1 : -1, 0),
    );
    // Flip one paddle input early in the run.
    const tampered = structuredClone(blob);
    tampered.inputs[100]!.left.paddles[0]!.move = -1;
    const result = verifyReplay(config, tampered);
    expect(result.ok).toBe(false);
    expect(result.firstDivergence).not.toBeNull();
    expect(result.firstDivergence!.tick).toBe(600);
  });
});
