/**
 * Batch-runner smoke (Phase 2 DoD support): a ReflexBot-vs-ReflexBot match
 * on the shipped default level runs headless to completion, produces a
 * first breach, and stays inside the SPEC-2.9 hard duration bound. The full
 * matrix report runs via `npm run batch` (see tools/batchRunner.ts).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMatch, stepMatch } from "../src/sim";
import { resolveMatchConfig, validateLevelJson } from "../src/config/levels";
import { ReflexBot } from "../tools/reflexBot";
import { materials, panels, tuning } from "./helpers";

const HARD_BOUND_TICKS = 420 * 120; // §2.9.1 p95 bound as a per-match ceiling here

describe("batch runner building blocks", () => {
  it.each([11, 222])("seed %i: default level resolves a full bot match in bounds", (seed) => {
    const raw = JSON.parse(
      readFileSync(new URL("../src/config/data/levels/dev-flat.json", import.meta.url), "utf-8"),
    );
    const { level } = validateLevelJson("dev-flat.json", raw, materials, panels);
    const config = resolveMatchConfig(level!, tuning, materials, panels, "versus");
    const state = createMatch(config, seed);
    const left = new ReflexBot("left", seed);
    const right = new ReflexBot("right", seed);
    while (state.phase.kind !== "matchOver" && state.tick < HARD_BOUND_TICKS + 1) {
      stepMatch(state, {
        left: left.sample(state, "left"),
        right: right.sample(state, "right"),
      });
    }
    expect(state.phase.kind).toBe("matchOver");
    expect(state.tick).toBeLessThanOrEqual(HARD_BOUND_TICKS);
    const fb = state.stats.firstBreachTick;
    expect(fb.left !== null || fb.right !== null).toBe(true); // a real siege happened
    expect(state.stats.livesLost.left + state.stats.livesLost.right).toBeGreaterThan(0);
  });

  it("bot runs are deterministic: same seed ⇒ identical outcome", () => {
    const raw = JSON.parse(
      readFileSync(new URL("../src/config/data/levels/dev-flat.json", import.meta.url), "utf-8"),
    );
    const { level } = validateLevelJson("dev-flat.json", raw, materials, panels);
    const config = resolveMatchConfig(level!, tuning, materials, panels, "versus");
    const run = (): { ticks: number; winner: string } => {
      const state = createMatch(config, 4242);
      const left = new ReflexBot("left", 4242);
      const right = new ReflexBot("right", 4242);
      while (state.phase.kind !== "matchOver" && state.tick < HARD_BOUND_TICKS) {
        stepMatch(state, {
          left: left.sample(state, "left"),
          right: right.sample(state, "right"),
        });
      }
      return {
        ticks: state.tick,
        winner: state.phase.kind === "matchOver" ? state.phase.winner : "cap",
      };
    };
    expect(run()).toEqual(run());
  });
});
