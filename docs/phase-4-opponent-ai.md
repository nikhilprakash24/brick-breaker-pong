# Phase 4 — Opponent AI: Output Document

*Build hand-off report. Spec: `../10_brick-breaker-pong-spec-pass2.md` (SPEC-2.7, SPEC-3.9,
§7.4, Part VI Phase 4). Canonical numbers: `../05_brick-breaker-pong-decisions-registry.md` §3.10.*

## What shipped

| Module | Spec | Contents |
|---|---|---|
| `src/config/data/opponents.json` | §7.4, §2.7.2, §2.7.5 | T1–T5 tier ladder verbatim from the registry; all 9 archetypes (5 field + 4 boss) incl. twins' split paddles, trickster's `offset_flip`, mason/architect `fortify` |
| `src/config/opponents.ts` | §2.7.5, §7.3 | Validation + the tier → archetype-delta → level-override merge (`resolveOpponent`); `resolveTierPure` for ladder measurement |
| `src/sim/ai/predict.ts` | §9.3 | `predictBall` forward simulation reusing the live sweep/reflect/slope primitives on a copied ball; terminates at brick / own-paddle-plane / back-boundary; panels & levers as plain reflection (documented §9.3.2 inaccuracy); `predictReturnLane` for aim verification |
| `src/sim/ai/targeting.ts` | §2.7.3, §9.4.3–9.4.4 | All four brains — spray (uniform ±0.8), focus (weighted lane scorer + retarget hysteresis), breach (widest-run center, focus-fallback with w_adj×2), denial (3-candidate safe return) — plus feasibility inversion and a bounded **bounce-aware aim** (see deviations) |
| `src/sim/ai/placement.ts` | §2.7.4, §9.5 | Plug / reinforce / fortify / extra_layer scoring with style floors — structurally complete, dormant until Phase 5 earning exists |
| `src/sim/ai/powerupPolicy.ts` | §9.6 | reactive/eager firing policy — dormant until Phase 5 |
| `src/sim/ai/aiController.ts` | §9.1–9.4 | The `InputController`: throttled+event-gated replanning, reaction delay, per-inbound noise (re-rolled per serve/opponent hit, held between), split-zone plan assignment, denial stationing, aim-offset positioning, MoveDir actuator |
| `src/sim/index.ts` (`makePaddles`) | §7.4.3 | Physical layouts: offset-shifted zones, split paddles straddling an uncovered center gap |
| `tools/aiLadder.ts` | §2.9.2 | Tier-monotonicity + focus-vs-spray acceptance gate (`npm run ai:ladder`) |
| `tests/ai.interface.test.ts` | §9.3.3, §12.1 | Purity over 10k fuzzed states (hash-equal before/after every `sample()`), legal-command shape, AI-vs-AI determinism, recorded-input replay ≡ live AI run |
| `tests/ai.behavior.test.ts` | Phase 4 DoD | focus-beats-spray, split-paddle zones + both twins hit, reduced-seed tier monotonicity |

In-game: levels with an `opponent` block boot as story mode (human left vs AI right) —
`1` Dev Court (warden T3), `7` The Twins (twins T4). The HUD shows `archetype Ttier`.

## DoD scorecard

| DoD item | Status |
|---|---|
| `ai.interface.test.ts` green — purity + legal commands over 10k fuzzed states | ✅ hash-equal purity, 10,000 fuzzed states, plus replay-equality |
| `focus` opens breaches faster than `spray` (ttfb ≤ 0.75×), same body | ✅ **0.71×** (median 238 s vs 335 s, 60 seeds) |
| Split-paddle opponent works | ✅ zones verified, both paddles register hits over a match |
| Tier-ladder monotonicity 60–85% per adjacent pair | ⚠ T5v4 ✅ in band; T2v1/T3v2/T4v3 **above** the 85% ceiling — see meta commentary §3 |
| Human win rates roughly track §8.2 on T1–T3 | ⏳ requires a human playtest session (creator) |

## Ladder gate results (60 seeds/pair, `npm run ai:ladder -- --seeds 60`)

| Check | Result | Band | Verdict |
|---|---|---|---|
| T2 beats T1 | 93% (56/60) | 60–85% | ⚠ above ceiling |
| T3 beats T2 | 92% (55/60) | 60–85% | ⚠ above ceiling |
| T4 beats T3 | 93% (56/60) | 60–85% | ⚠ above ceiling |
| T5 beats T4 | **60%** (36/60) | 60–85% | ✅ |
| focus ttfb vs spray | **0.71×** (238 s / 335 s) | ≤ 0.75× | ✅ |

Environment: tier-pure stat blocks (no archetype ceiling), symmetric brick-front/hay-rear
walls, 3 lives, flat arena, seeds `n × 7919`.

## Deviations from the spec (all deliberate, all documented)

1. **Bounce-aware aim replaces pure §9.4.4 geometric inversion.** §9.4.4 prescribes a
   single geometric inversion + one predict-verify, "no search". On a 720-u-tall court
   nearly every non-flat trajectory bounces off top/bottom before the far wall, so the
   geometric aim *scatters* — measured focus-vs-spray ttfb ratio was **0.99–1.12** (spray
   occasionally *beat* focus). That makes §2.9.2's acceptance gate (focus ≤ 0.75× spray)
   unsatisfiable as written. Resolution: a bounded candidate search (17 offsets in 0.125
   steps + the geometric one), each verified by one `predictReturnLane`, choosing the
   first-brick-strike nearest the target lane; computed **once per committed inbound**
   (cached, refreshed at replan cadence), so the per-hit predict budget is fixed. Where
   two spec clauses conflicted, the *measurable acceptance gate* won.
2. **`station` is a first-class tier field.** The spec implies T5's denial-stationing via
   prose ("`breach` + `denial` stationing"); `opponents.json` encodes it explicitly as
   `station: "center" | "denial"` so the merge stays mechanical.
3. **Archetype perception deltas.** §2.7.5 mixes absolute overrides ("reaction 140,
   noise 14") with deltas ("+20 ms reaction, +15% noise"). The schema supports both:
   `reaction_ms`/`aim_noise_u` absolute, `reaction_ms_delta`/`aim_noise_mult` relative.
4. **Placement/powerup policies are wired but inert** — no powerups are earned until
   Phase 5. The planner and policy run every tick and correctly propose nothing on empty
   slots; their scoring is unit-testable now and gets live coverage in Phase 5.
5. **Rubber-banding (§2.7.7)** is not implemented in this phase; it ships default-OFF as
   Assist Mode alongside story-mode UI (Phase 6).

## Meta commentary — what actually happened building this

1. **The `Infinity ≤ Infinity` freeze.** First playable AI stood motionless at center.
   Instrumentation showed `interceptY = -Infinity`: in the prediction loop, when a tick
   hit *neither* a collider nor the paddle plane, both times-of-impact were `Infinity`,
   and `planeT <= bestT` evaluated **true** — reporting a plane crossing at t=∞. One
   guard fixed it, and the same smoke run flipped from "AI loses 3–0 with 7 paddle hits"
   to "AI wins with 100 hits and 4 drilled breaches". Lesson recorded for Phase 5+:
   every earliest-of comparison over optional events needs an existence guard first.
2. **The perfect-tracker measurement trap.** The first focus-vs-spray gate used a
   perfect tracking bot as the defender. Against a perfect defender almost nothing
   leaks, so time-to-first-breach was governed by the *defender's* rare timing failures
   (random lanes), not the attacker's aim — the gate inverted (spray "beat" focus).
   Diagnosis came from a lane-damage histogram: focus's damage concentration was 0.10–0.44
   (≈ spray's). The gate now uses a realistic leaky defender (tier-pure T2) with body
   stats held constant on the attacker, matching §2.9.2's intent ("same body stats").
3. **The monotonicity band failed in the opposite direction from the prediction.** The
   working hypothesis was that T5v4 would *under*-separate (its differentiators —
   `fortify` placement, `eager` powerups — are dormant until Phase 5, and at σ = 13/8 u
   noise vs 55 u coverage gaussian noise essentially never causes a T4/T5 miss,
   P ≈ 2×10⁻⁵). Measured: T5v4 landed **in band at 60%** — exactly the compressed-but-
   monotone result that reasoning implies — while the LOWER pairs came out at 92–93%,
   **above** the 85% "cliff" ceiling. Reading: AI-vs-AI mirror matches are maximally
   skill-transitive — a 3× per-exchange miss-rate gap (σ34→σ26 across T1→T2) compounds
   over a whole match with no style mismatch or human variance to dampen it. The tier
   values are canonical (registry §3.10) and not this phase's to retune; the spec's own
   protocol re-baselines these thresholds against human telemetry (§2.9.2 last ¶), and
   the nightly 200-seed gate re-runs after Phase 5 arms the full kit. Recorded, not
   hidden: if the cliff is real for players, the designer's lever is the tier
   `aim_noise_u` spacing, and this table is the falsifier.
4. **A test-construction bug masqueraded as a design failure.** The first ladder ran
   warden@T1 … warden@T5 head-to-heads — but warden's archetype targeting is `focus`,
   and *labels are ceilings* (§9.4.3), so every tier above T2 was silently demoted to
   focus. The ladder was measuring motor stats only. `resolveTierPure` exists so the
   monotonicity gate measures what the ladder actually defines.
5. **The adversarial review workflow caught a real prediction/sim divergence** — the
   slope-field path inside `predictBall` was missing the trailing min-|vx| clamp that the
   live `applySlopeField` applies, so field-mode predictions could drift from reality.
   (One verify agent also tried to "test" its hypothesis by patching a `globalThis` flag
   into the sim source — the patch was reverted and replaced with the correct
   unconditional clamp; scratch artifacts were removed. Noted as a process hazard:
   review agents get read access, never write.)
6. **Purity is proven, not promised.** The controller's RNG is derived from
   `matchSeed` (streams 3/4) and lives entirely in the controller; the test suite runs a
   full AI match, records its inputs, replays them through a fresh sim with **no AI in
   the loop**, and asserts final `hashState` equality. The AI demonstrably changes the
   world only through its `SideInput`.

## Handles for the creator

- Difficulty feel: play `1` (warden T3) and `7` (twins T4). Tier stats live in
  `opponents.json → tiers` — every knob is registry-named.
- The §8.2 calibration targets (win rate vs T1 ≈ 90% … T5 ≈ 25%) need your hands on the
  paddle; the ladder only proves *relative* ordering.
- `npm run ai:ladder -- --seeds 200` is the full §2.9.2 gate (≈ 60–70 min, headless).
