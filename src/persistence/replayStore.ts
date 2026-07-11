/**
 * Replay record/verify (SPEC-3.12 §12.4). A replay stores INPUTS, not
 * events; events regenerate on replay. Checkpoint hashes every 600 ticks
 * make divergence bisectable. RLE compression arrives with the ring-buffer
 * dev recorder; Phase 1 stores per-tick inputs verbatim.
 */

import type { TickInputs } from "../input/controller";
import type { MatchConfig } from "../config/types";
import { createMatch, hashState, stepMatch } from "../sim";
import type { MatchState } from "../sim/state";

export const CHECKPOINT_EVERY = 600;

export interface ReplayBlob {
  version: 1;
  matchSeed: number;
  inputs: TickInputs[];
  checkpoints: { tick: number; hash: number }[];
}

export class ReplayRecorder {
  private readonly inputs: TickInputs[] = [];
  private readonly checkpoints: { tick: number; hash: number }[] = [];

  constructor(private readonly matchSeed: number) {}

  /** Call after each stepMatch with the inputs that fed it. */
  record(state: MatchState, inputs: TickInputs): void {
    this.inputs.push(inputs);
    if (state.tick % CHECKPOINT_EVERY === 0) {
      this.checkpoints.push({ tick: state.tick, hash: hashState(state) });
    }
  }

  blob(): ReplayBlob {
    return {
      version: 1,
      matchSeed: this.matchSeed,
      inputs: [...this.inputs],
      checkpoints: [...this.checkpoints],
    };
  }
}

export interface VerifyResult {
  ok: boolean;
  checkpointsCompared: number;
  firstDivergence: { tick: number; expected: number; actual: number } | null;
}

/** Re-run the recorded inputs and compare every checkpoint hash. */
export function verifyReplay(config: MatchConfig, replay: ReplayBlob): VerifyResult {
  const state = createMatch(config, replay.matchSeed);
  let compared = 0;
  let idx = 0;
  for (const inputs of replay.inputs) {
    stepMatch(state, inputs);
    const cp = replay.checkpoints[idx];
    if (cp && state.tick === cp.tick) {
      const actual = hashState(state);
      compared += 1;
      if (actual !== cp.hash) {
        return {
          ok: false,
          checkpointsCompared: compared,
          firstDivergence: { tick: cp.tick, expected: cp.hash, actual },
        };
      }
      idx += 1;
    }
  }
  return { ok: true, checkpointsCompared: compared, firstDivergence: null };
}

/** Convenience for tests: run a controller pair, return blob + final state. */
export function recordRun(
  config: MatchConfig,
  seed: number,
  ticks: number,
  makeInputs: (state: Readonly<MatchState>, tick: number) => TickInputs,
): { blob: ReplayBlob; final: MatchState } {
  const state = createMatch(config, seed);
  const rec = new ReplayRecorder(seed);
  for (let i = 0; i < ticks; i++) {
    const inputs = makeInputs(state, i);
    stepMatch(state, inputs);
    rec.record(state, inputs);
    if (state.phase.kind === "matchOver") break;
  }
  return { blob: rec.blob(), final: state };
}
