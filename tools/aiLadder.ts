/**
 * AI tier-ladder & targeting gate (SPEC-2.9 §2.9.2, Phase 4 DoD). Runs the
 * full 200-seed AI-vs-AI monotonicity matrix (a higher tier must beat the
 * next-lower one in 60–85% of head-to-heads) and the focus-vs-spray
 * time-to-first-breach check (focus ≤ 0.75× spray). Headless via tsx.
 *
 * Run: npm run ai:ladder [-- --seeds 200]
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMatch, stepMatch } from "../src/sim";
import {
  validateMaterialsJson,
  validatePanelsJson,
  validateTuningJson,
} from "../src/config/load";
import {
  validateOpponentsJson,
  resolveOpponent,
  resolveTierPure,
  type ResolvedOpponent,
  type Targeting,
} from "../src/config/opponents";
import { flatArena } from "../src/sim/geometry";
import { AiController } from "../src/sim/ai/aiController";
import type { MatchConfig } from "../src/config/types";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "src", "config", "data");
const rd = (p: string): unknown => JSON.parse(readFileSync(join(dataDir, p), "utf-8"));

const tuning = validateTuningJson(rd("tuning.json")).tuning!;
const materials = validateMaterialsJson(rd("materials.json")).materials!;
const panels = validatePanelsJson(rd("panels.json")).panels!;
const opponents = validateOpponentsJson(rd("opponents.json")).opponents!;

const SIM_HZ = 120;
const args = process.argv.slice(2);
const seedsArg = args.indexOf("--seeds");
const SEEDS = seedsArg !== -1 ? Number(args[seedsArg + 1]) : 200;

function opp(archetype: string, tier: number) {
  return resolveOpponent({ tier, archetype }, opponents, {
    paddleHalfHeight: tuning.paddle.paddle_half_height,
  });
}

/** Brick front (3 HP) over hay backing: concentration of fire matters, so a
 *  focused drill breaches a lane faster than a spread of spray hits. */
function symWall(): string[][] {
  return [
    Array.from({ length: 12 }, () => "brick"),
    Array.from({ length: 12 }, () => "hay"),
  ];
}

function baseConfig(leftPaddle: unknown, rightPaddle: unknown): MatchConfig {
  return {
    tuning,
    materials,
    laneCount: 12,
    walls: { left: { layers: symWall() }, right: { layers: symWall() } },
    arena: flatArena(),
    objects: [],
    panels,
    paddles: { left: leftPaddle as never, right: rightPaddle as never },
    rules: {
      lives: { left: 3, right: 3 },
      rebuild_on_life_lost: "none",
      rebuild_material: "hay",
      life_loss_per_exchange: 1,
      overtime_enabled: true,
      overtime_start: null,
      first_receiver: "random",
    },
  };
}

/** Tier-pure lo vs hi on standard bodies (§2.9.2); return 'hi' | 'lo' | 'cap'.
 *  Tier-pure, NOT warden@tier: warden's `focus` targeting ceiling would mask
 *  the T3+ breach brain — the very thing the ladder separates on. */
function headToHead(loTier: number, hiTier: number, seed: number): "hi" | "lo" | "cap" {
  const base = { paddleHalfHeight: tuning.paddle.paddle_half_height };
  const lo = resolveTierPure(loTier, opponents, base);
  const hi = resolveTierPure(hiTier, opponents, base);
  const config = baseConfig(lo.paddle, hi.paddle);
  const state = createMatch(config, seed);
  const loAi = new AiController(lo, "left", seed);
  const hiAi = new AiController(hi, "right", seed);
  while (state.phase.kind !== "matchOver" && state.tick < 120_000) {
    stepMatch(state, { left: loAi.sample(state, "left"), right: hiAi.sample(state, "right") });
  }
  if (state.phase.kind !== "matchOver") return "cap";
  return state.phase.winner === "right" ? "hi" : "lo";
}

/**
 * Time-to-first-breach for a given targeting BRAIN, holding body stats
 * constant (§2.9.2 "same body stats"): a warden@T3 attacker on the right
 * whose only variable is its brain, vs a fixed mid-skill AI defender
 * (warden@T2) on the left that leaks realistically so aim matters.
 */
function ttfbForBrain(brain: Targeting, seed: number): number | null {
  const base = { paddleHalfHeight: tuning.paddle.paddle_half_height };
  const atk: ResolvedOpponent = { ...resolveTierPure(3, opponents, base), targeting: brain, station: "center" };
  const def = resolveTierPure(2, opponents, base);
  const config = baseConfig(def.paddle, atk.paddle);
  config.rules.first_receiver = "left";
  const state = createMatch(config, seed);
  const defAi = new AiController(def, "left", seed);
  const atkAi = new AiController(atk, "right", seed);
  while (state.phase.kind !== "matchOver" && state.tick < 90_000) {
    stepMatch(state, { left: defAi.sample(state, "left"), right: atkAi.sample(state, "right") });
    if (state.stats.firstBreachTick.left !== null) return state.stats.firstBreachTick.left / SIM_HZ;
  }
  return state.stats.firstBreachTick.left === null ? null : state.stats.firstBreachTick.left / SIM_HZ;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? NaN;
}

// ── run ───────────────────────────────────────────────────────────────────────

const t0 = performance.now();
console.log(`AI ladder gate — ${SEEDS} seeds/pair\n`);
console.log("tier-ladder monotonicity (higher beats lower; target 60–85%):");
let allPass = true;
for (const [lo, hi] of [
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 5],
] as const) {
  let hiWins = 0;
  let decided = 0;
  for (let s = 1; s <= SEEDS; s++) {
    const r = headToHead(lo, hi, s * 7919);
    if (r === "cap") continue;
    decided++;
    if (r === "hi") hiWins++;
  }
  const rate = decided > 0 ? hiWins / decided : NaN;
  const ok = rate >= 0.6 && rate <= 0.85;
  allPass = allPass && ok;
  console.log(
    `  T${hi} vs T${lo}: ${(rate * 100).toFixed(0)}% (${hiWins}/${decided})  ${ok ? "OK" : "OUT OF BAND"}`,
  );
}

console.log("\ntargeting sanity (same body; focus ttfb ≤ 0.75× spray):");
const focus = Array.from({ length: SEEDS }, (_, i) => ttfbForBrain("focus", (i + 1) * 6151)).filter(
  (x): x is number => x !== null,
);
const spray = Array.from({ length: SEEDS }, (_, i) => ttfbForBrain("spray", (i + 1) * 6151)).filter(
  (x): x is number => x !== null,
);
const mFocus = median(focus);
const mSpray = median(spray);
const focusOk = mFocus <= 0.75 * mSpray;
allPass = allPass && focusOk;
console.log(
  `  focus median ${mFocus.toFixed(0)}s vs spray median ${mSpray.toFixed(0)}s  ` +
    `(ratio ${(mFocus / mSpray).toFixed(2)})  ${focusOk ? "OK" : "FAIL"}`,
);

console.log(`\n${allPass ? "LADDER GATE PASS ✓" : "LADDER GATE FAIL ✗"}  (${((performance.now() - t0) / 1000).toFixed(0)}s)`);
process.exit(allPass ? 0 : 1);
