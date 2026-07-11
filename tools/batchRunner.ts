/**
 * Headless matchup matrix runner (Tech Guide Phase 2 / SPEC-2.9 §2.9.2
 * protocol skeleton). Pits two ReflexBots across layers × materials × lives
 * matrices plus the shipped default level, and reports duration + ttfb
 * distributions against the SPEC-2.9 §2.9.1 targets (2–4 min median,
 * ttfb 45–90 s median). Full AI-vs-AI protocol (200 seeds, archetype tiers,
 * placement/powerup metrics) replaces the bot proxy in Phase 4+.
 *
 * Run: npm run batch [-- --seeds 20] [--quick]
 * Writes per-match rows to tools/reports/tuning-report.csv.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMatch, stepMatch } from "../src/sim";
import type { MatchConfig } from "../src/config/types";
import {
  validateMaterialsJson,
  validatePanelsJson,
  validateTuningJson,
} from "../src/config/load";
import { validateLevelJson, resolveMatchConfig } from "../src/config/levels";
import { flatArena } from "../src/sim/geometry";
import { ReflexBot } from "./reflexBot";
import { SIM_HZ } from "../src/app/loop";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "src", "config", "data");

function readJson(p: string): unknown {
  return JSON.parse(readFileSync(p, "utf-8"));
}

const { tuning } = validateTuningJson(readJson(join(dataDir, "tuning.json")));
const { materials } = validateMaterialsJson(readJson(join(dataDir, "materials.json")));
const { panels } = validatePanelsJson(readJson(join(dataDir, "panels.json")));
if (!tuning || !materials || !panels) throw new Error("config invalid — run npm test");

// ── matrix ──────────────────────────────────────────────────────────────────

type Comp = "hay" | "brick" | "mixed";

function compositionLayers(comp: Comp, layers: number): string[][] {
  const row = (m: string): string[] => Array.from({ length: 12 }, () => m);
  const out: string[][] = [];
  for (let i = 0; i < layers; i++) {
    if (comp === "hay") out.push(row("hay"));
    else if (comp === "brick") out.push(row("brick"));
    // mixed: hay front over brick core — the §2.2.3 authoring doctrine.
    else out.push(i === 0 && layers > 1 ? row("hay") : row("brick"));
  }
  return out;
}

function matrixConfig(comp: Comp, layers: number, lives: number): MatchConfig {
  const wall = { layers: compositionLayers(comp, layers) };
  return {
    tuning: tuning!,
    materials: materials!,
    laneCount: 12,
    walls: { left: { layers: wall.layers.map((l) => [...l]) }, right: { layers: wall.layers.map((l) => [...l]) } },
    arena: flatArena(),
    objects: [],
    panels: panels!,
    rules: {
      lives: { left: lives, right: lives },
      rebuild_on_life_lost: "none",
      rebuild_material: "hay",
      life_loss_per_exchange: 1,
      overtime_enabled: true,
      overtime_start: null,
      first_receiver: "random",
    },
  };
}

// ── one match ───────────────────────────────────────────────────────────────

interface MatchRow {
  config: string;
  seed: number;
  durationS: number;
  ttfbLeftS: number | null;
  ttfbRightS: number | null;
  winner: string;
  overtime: boolean;
  longestRally: number;
  rallies: number[];
  livesLostL: number;
  livesLostR: number;
}

const TICK_CAP = 90_000; // 12.5 min safety net; overtime should end matches long before

function runMatch(name: string, config: MatchConfig, seed: number): MatchRow {
  const state = createMatch(config, seed);
  const left = new ReflexBot("left", seed);
  const right = new ReflexBot("right", seed);
  let overtime = false;
  const rallies: number[] = [];
  let prevHits = 0;

  while (state.phase.kind !== "matchOver" && state.tick < TICK_CAP) {
    const inputs = {
      left: left.sample(state, "left"),
      right: right.sample(state, "right"),
    };
    const events = stepMatch(state, inputs);
    if (state.rally.hitCount === 0 && prevHits > 0) rallies.push(prevHits);
    prevHits = state.rally.hitCount;
    for (const e of events) if (e.type === "OvertimeStarted") overtime = true;
  }

  const fb = state.stats.firstBreachTick;
  return {
    config: name,
    seed,
    durationS: state.tick / SIM_HZ,
    ttfbLeftS: fb.left === null ? null : fb.left / SIM_HZ,
    ttfbRightS: fb.right === null ? null : fb.right / SIM_HZ,
    winner: state.phase.kind === "matchOver" ? state.phase.winner : "cap",
    overtime,
    longestRally: state.stats.longestRally,
    rallies,
    livesLostL: state.stats.livesLost.left,
    livesLostR: state.stats.livesLost.right,
  };
}

// ── stats helpers ───────────────────────────────────────────────────────────

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx]!;
}

function summarize(name: string, rows: MatchRow[]): string {
  const dur = rows.map((r) => r.durationS).sort((a, b) => a - b);
  const ttfb = rows
    .flatMap((r) => [r.ttfbLeftS, r.ttfbRightS])
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b);
  const allRallies = rows.flatMap((r) => r.rallies).sort((a, b) => a - b);
  const otPct = (100 * rows.filter((r) => r.overtime).length) / rows.length;
  const capPct = (100 * rows.filter((r) => r.winner === "cap").length) / rows.length;
  const f = (x: number): string => (Number.isNaN(x) ? "  —" : x.toFixed(0).padStart(4));
  return (
    `${name.padEnd(22)} n=${String(rows.length).padStart(3)}  ` +
    `dur s p10/med/p95 ${f(quantile(dur, 0.1))}/${f(quantile(dur, 0.5))}/${f(quantile(dur, 0.95))}  ` +
    `ttfb med ${f(quantile(ttfb, 0.5))}  ` +
    `rally med/p95 ${f(quantile(allRallies, 0.5))}/${f(quantile(allRallies, 0.95))}  ` +
    `OT ${otPct.toFixed(0)}%  cap ${capPct.toFixed(0)}%`
  );
}

// ── main ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const seedsArg = args.indexOf("--seeds");
const SEEDS = seedsArg !== -1 ? Number(args[seedsArg + 1]) : 20;
const QUICK = args.includes("--quick");

const configs: { name: string; config: MatchConfig }[] = [];

// The shipped default level — the Phase 2 DoD band check.
{
  const raw = readJson(join(dataDir, "levels", "dev-flat.json"));
  const { level, errors } = validateLevelJson("dev-flat.json", raw, materials, panels);
  if (!level) throw new Error("dev-flat invalid: " + JSON.stringify(errors));
  configs.push({
    name: "default(dev-flat)",
    config: resolveMatchConfig(level, tuning, materials, panels, "versus"),
  });
}

const comps: Comp[] = QUICK ? ["mixed"] : ["hay", "brick", "mixed"];
const layerCounts = QUICK ? [2] : [1, 2, 3];
const livesOptions = QUICK ? [3] : [2, 3, 5];
for (const comp of comps) {
  for (const layers of layerCounts) {
    for (const lives of livesOptions) {
      configs.push({
        name: `${comp} L${layers} ${lives}♥`,
        config: matrixConfig(comp, layers, lives),
      });
    }
  }
}

const t0 = performance.now();
const csv: string[] = [
  "config,seed,duration_s,ttfb_left_s,ttfb_right_s,winner,overtime,longest_rally,lives_lost_l,lives_lost_r",
];
console.log(`batch: ${configs.length} configs × ${SEEDS} seeds\n`);
console.log("── SPEC-2.9 targets: dur median 120–240 s (p95 ≤ 420) · ttfb median 45–90 s · rally med 4–7 ──");
for (const { name, config } of configs) {
  const rows: MatchRow[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const row = runMatch(name, config, seed * 7919);
    rows.push(row);
    csv.push(
      [
        JSON.stringify(row.config),
        row.seed,
        row.durationS.toFixed(1),
        row.ttfbLeftS?.toFixed(1) ?? "",
        row.ttfbRightS?.toFixed(1) ?? "",
        row.winner,
        row.overtime,
        row.longestRally,
        row.livesLostL,
        row.livesLostR,
      ].join(","),
    );
  }
  console.log(summarize(name, rows));
}

const reportDir = join(here, "reports");
mkdirSync(reportDir, { recursive: true });
const reportPath = join(reportDir, "tuning-report.csv");
writeFileSync(reportPath, csv.join("\n") + "\n");
console.log(`\n${csv.length - 1} match rows → ${reportPath}`);
console.log(`elapsed ${((performance.now() - t0) / 1000).toFixed(1)} s`);
