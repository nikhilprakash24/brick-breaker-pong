# Brick Breaker Pong

Pong as a siege: break through their castle wall before they break through
yours, then make every shot through the breach count.

Built from **`../10_brick-breaker-pong-spec-pass2.md`** (the build hand-off
spec). **`../05_brick-breaker-pong-decisions-registry.md` is canonical for
every decision and tuning value** — changes land there first, then propagate
to `src/config/data/*.json`.

## Stack

TypeScript strict + HTML5 Canvas 2D, zero engine, zero runtime deps.
Vite build, vitest tests, 120 Hz fixed-timestep deterministic sim decoupled
from RAF rendering.

## Commands

```
npm run dev        # dev server (config JSON hot-editable, fetched not bundled)
npm run build      # typecheck + production build to dist/
npm test           # vitest suites
npm run lint       # ESLint incl. the sim determinism guards
npm run typecheck  # tsc --noEmit
```

## Architecture invariants (lint-enforced)

- No `Math.random` / `Date.now` / `performance.now` inside `src/sim/**` —
  all sim randomness comes from seeded mulberry32 streams in `MatchState`.
- `src/sim/**` may not import from `render/ audio/ ui/ persistence/ debug/`.
- All tuning lives in `src/config/data/*.json`, validated at boot with
  path-precise fatal reports; keys are the registry snake_case ids verbatim.
- `main.ts` contains no gameplay logic.

## Build phase status (spec Part VI — don't start N+1 until N's DoD passes)

| Phase | Status |
|---|---|
| 0 — Scaffold & architecture skeleton | ✅ DoD verified 2026-07-10 |
| 1 — Core physics prototype | ✅ DoD verified 2026-07-10 |
| 2 — Walls, materials & the siege game | ✅ DoD verified 2026-07-11 |
| 3 — Arenas & wall objects | ✅ DoD verified 2026-07-11 |
| 4 — Opponent AI | next |
| 5–10 | pending |

Phase 0 DoD evidence: dev serves a 1280×720 letterboxed canvas; live readout
shows sim 120 Hz vs render 60 fps (plus headless cadence tests in
`tests/loop.test.ts`); a deliberately broken `tuning.json` fails boot with
`tuning.json: physics.ball_radius: expected number in [5, 10], got "7px"`;
the lint guards reject `Math.random` and presentation imports in `src/sim`;
CI (`.github/workflows/ci.yml`) runs typecheck → lint → test → build.

Phase 1 DoD evidence: 2P local match playable start→finish (W/S vs ↑/↓);
lives and per-lane breach-to-score verified live (debug-overlay event tail
shows BallRemoved → LifeLost → HitStop → Serve on a real breach crossing);
`tests/soak.tunneling.test.ts` runs 10k ticks × 3 seeds at the 3.3× cap with
5 balls and dev invariants on — zero tunneling, zero MAX_BOUNCES exhaustion;
the sim runs fully headless; `tests/replay.test.ts` records a 5000-tick
scripted match and re-verifies hash-equal 600-tick checkpoints (and catches
a tampered input at the first divergent checkpoint). Debug overlay: `` ` ``
toggle, `P` pause-sim, `.` step one tick.

Phase 1 A/B answers still open for the creator (playtest falsifiers built
in): `backface_mode` (default "reflect"), `rebuild_on_life_lost` (all three
modes implemented behind the config flag, default "none"), serve-direction
and speed-curve feel — all tunable in `src/config/data/tuning.json`.

Phase 3 DoD evidence: all five arena shapes bake and play — flat, slope
(both `reflection_only` and `field` modes, `slope_accel` 400), angular,
narrowing, zig-zag — authored by profile or explicit vertex lists and
validated against the §3.8.1 rules (increasing x, flat end zones, min court
height). Levers (recall to last hitter), directional panels (global
`panels.json` colour→direction map), and one-way tiles (interior inset gates)
trigger with cooldowns and correct redirects. `npm run view -- <level>`
renders any level's baked colliders as ASCII and runs a spray-soak; all five
arenas + the object levels pass with **zero out-of-hull balls and zero
MAX_BOUNCES exhaustion**, and the tunneling soak now runs on flat AND
slope-field arenas (a §3.4.4 de-penetration fallback contains rare convex-
corner slips under forced-cap stress). Slope serve-clearance verified (no
ramp-clipped serves at ±25°); stall watchdog (R-5.4) verified on soft-nudge
and hard-void fixtures. Menu keys `1`–`6` pick the arena.

Phase 2 DoD evidence: level JSON fully describes both walls
(`src/config/data/levels/*.json`, validated incl. the §2.2.5 authoring
grammar — run-length strings, `| mirror`, `| mirror-check`, R-1.3 layer cap,
0-layer sides, asymmetric walls); `npm run batch` runs the headless
ReflexBot matchup matrix (layers × materials × lives, seeded/deterministic)
and writes duration+ttfb rows to `tools/reports/tuning-report.csv`; the
default level (`dev-flat`: hay front row over a brick-core rear) was
recomposed FROM that matrix and lands on every SPEC-2.9 §2.9.1 target —
duration median 223 s (band 120–240, p95 298 ≤ 420), ttfb median 79 s
(band 45–90), rally median 5 (band 4–7), overtime rate 0%. Breach property
tests (cache == recompute under randomized damage) green. In-game: press
`1`/`2` on the menu to pick the level. The bot proxy is a stand-in for the
Phase 4 AI; §2.9.2's full 200-seed protocol re-baselines these numbers then.
