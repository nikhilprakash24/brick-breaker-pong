/**
 * Level viewer (Tech Guide Phase 3 tool): render any level JSON's baked
 * colliders as ASCII + a geometry report, and spray test-balls to sanity-
 * check for out-of-hull escapes and MAX_BOUNCES exhaustion. Headless — no
 * canvas — so it runs under tsx and in CI.
 *
 * Run: npm run view -- dev-slope         (or any level id / file name)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMatch, stepMatch } from "../src/sim";
import { simDiagnostics } from "../src/sim/ball";
import { bottomY, topY } from "../src/sim/geometry";
import {
  validateMaterialsJson,
  validatePanelsJson,
  validateTuningJson,
} from "../src/config/load";
import { resolveMatchConfig, validateLevelJson } from "../src/config/levels";
import type { BallState, MatchState } from "../src/sim/state";
import { deriveStream, rngRange } from "../src/sim/rng";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "src", "config", "data");
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf-8"));

const tuning = validateTuningJson(readJson(join(dataDir, "tuning.json"))).tuning!;
const materials = validateMaterialsJson(readJson(join(dataDir, "materials.json"))).materials!;
const panels = validatePanelsJson(readJson(join(dataDir, "panels.json"))).panels!;

const arg = process.argv[2] ?? "dev-flat";
const file = arg.endsWith(".json") ? arg : `${arg}.json`;
const raw = readJson(join(dataDir, "levels", file));
const { level, errors } = validateLevelJson(file, raw, materials, panels);
if (!level) {
  console.error(`invalid level ${file}:\n` + errors.map((e) => `  ${e.path}: ${e.message}`).join("\n"));
  process.exit(1);
}
const config = resolveMatchConfig(level, tuning, materials, panels, "versus");
const state = createMatch(config, 1);

// ── geometry report ───────────────────────────────────────────────────────────

console.log(`\n${level.display_name} (${level.id})  ${file}`);
console.log(`arena: ${state.arena.slope ? `slope[${state.arena.slope.mode}]` : "polyline"}  ` +
  `segments ${state.arena.segments.length}  objects ${state.wallObjects.length}`);
for (const o of state.wallObjects) {
  const seg = state.arena.segments.find((s) => s.id === o.segmentId);
  console.log(
    `  ${o.kind.padEnd(6)} seg#${o.segmentId} ` +
      (seg ? `(${seg.a.x.toFixed(0)},${seg.a.y.toFixed(0)})→(${seg.b.x.toFixed(0)},${seg.b.y.toFixed(0)})` : "") +
      (o.panelDir ? ` dir(${o.panelDir.x.toFixed(2)},${o.panelDir.y.toFixed(2)})` : "") +
      (o.blockNormal ? ` block(${o.blockNormal.x},${o.blockNormal.y})` : "") +
      (o.cooldownTotal ? ` cd${o.cooldownTotal}t` : ""),
  );
}

// ── ASCII court (top/bottom boundary sampled across 64 columns) ────────────────

const COLS = 64;
const ROWS = 22;
const grid: string[][] = Array.from({ length: ROWS }, () => Array(COLS).fill(" "));
for (let col = 0; col < COLS; col++) {
  const x = (col / (COLS - 1)) * 1280;
  const ty = topY(state.arena, x);
  const by = bottomY(state.arena, x);
  const tr = Math.round((ty / 720) * (ROWS - 1));
  const br = Math.round((by / 720) * (ROWS - 1));
  if (grid[tr]) grid[tr]![col] = "─";
  if (grid[br]) grid[br]![col] = "─";
}
console.log("\n" + grid.map((r) => "|" + r.join("") + "|").join("\n"));

// ── spray test (geometry-exploit soak, 5 balls × 4000 ticks) ───────────────────

function sprayBall(s: MatchState, seed: number): BallState {
  const rng = deriveStream(seed, 42 + s.balls.length);
  const angle = rngRange(rng, -1.2, 1.2);
  const dir = rngRange(rng, -1, 1) < 0 ? -1 : 1;
  const speed = tuning.physics.ball_base_speed * 2.5;
  const ball: BallState = {
    id: s.nextEntityId++,
    pos: { x: 640, y: 360 },
    vel: { x: Math.cos(angle) * speed * dir, y: Math.sin(angle) * speed },
    radius: tuning.physics.ball_radius,
    speedMult: 2.5,
    damage: 1,
    heavyHitsLeft: 0,
    curveAccel: 0,
    stuckToPaddle: null,
    lastHitBy: dir > 0 ? "left" : "right",
    lastHorizontalDir: dir as 1 | -1,
    justTeleported: false,
  };
  s.balls.push(ball);
  return ball;
}

state.phase = { kind: "rally" };
let outOfHull = 0;
let exhausted = 0;
let triggers = 0;
for (let i = 0; i < 4000; i++) {
  while (state.balls.length < 5) sprayBall(state, 900 + i);
  state.sides.left.lives = 9;
  state.sides.right.lives = 9;
  state.rally.lastTouchTick = state.tick;
  const events = stepMatch(state, {
    left: { paddles: [{ move: 0, action: false }], activateSlot: null, placement: null, placementWindow: null },
    right: { paddles: [{ move: 0, action: false }], activateSlot: null, placement: null, placementWindow: null },
  });
  exhausted += simDiagnostics.maxBouncesExhausted;
  for (const e of events) if (e.type === "WallObjectTriggered") triggers++;
  for (const b of state.balls) {
    const m = 2;
    if (b.pos.x < -m || b.pos.x > 1280 + m || b.pos.y < topY(state.arena, b.pos.x) - m || b.pos.y > bottomY(state.arena, b.pos.x) + m) {
      outOfHull++;
    }
  }
}
console.log(
  `\nspray soak (5 balls × 4000 ticks): out-of-hull ${outOfHull}  ` +
    `MAX_BOUNCES exhausted ${exhausted}  object triggers ${triggers}`,
);
console.log(outOfHull === 0 && exhausted === 0 ? "GEOMETRY OK ✓\n" : "GEOMETRY EXPLOIT ✗\n");
