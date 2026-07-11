/**
 * Breach subsystem (SPEC-3.12 §12.1 + §12.3 property test):
 * predicate incl. 0-layer sides, Opened vs Widened vs Closed, width,
 * critical-lane edge triggering, incremental == full recompute under
 * randomized damage, rebuild modes.
 */

import { describe, expect, it } from "vitest";
import { createMatch, stepMatch } from "../src/sim";
import { damageCell, rebuildWall } from "../src/sim/wall";
import { laneBreached, recomputeAll } from "../src/sim/breach";
import type { GameEvent } from "../src/sim/events";
import type { MatchState } from "../src/sim/state";
import { deriveStream, rngInt } from "../src/sim/rng";
import { neutralInputs, testMatchConfig } from "./helpers";

function freshState(overrides = {}): MatchState {
  return createMatch(testMatchConfig(overrides), 7);
}

/** Destroy every live cell in a lane via the single mutator. */
function breachLane(state: MatchState, side: "left" | "right", lane: number): GameEvent[] {
  const events: GameEvent[] = [];
  const wall = state.sides[side].wall;
  for (let layer = 0; layer < wall.layers.length; layer++) {
    let guard = 0;
    while (wall.layers[layer]![lane] && guard++ < 20) {
      damageCell(state, side, layer, lane, 1, 0, events);
    }
  }
  return events;
}

describe("breach predicate & events", () => {
  it("a 0-layer side is breached everywhere from serve one", () => {
    const state = freshState({ wallsLeft: [] });
    const wall = state.sides.left.wall;
    expect(wall.breachCount).toBe(wall.laneCount);
    expect(wall.breachedLanes.every(Boolean)).toBe(true);
    expect(state.sides.right.wall.breachCount).toBe(0);
  });

  it("first lane through emits BreachOpened width 1; adjacent emits BreachWidened width 2", () => {
    const state = freshState();
    const first = breachLane(state, "right", 5);
    const opened = first.find((e) => e.type === "BreachOpened");
    expect(opened).toMatchObject({ side: "right", lane: 5, width: 1 });
    expect(first.some((e) => e.type === "BreachWidened")).toBe(false);

    const second = breachLane(state, "right", 6);
    const widened = second.find((e) => e.type === "BreachWidened");
    expect(widened).toMatchObject({ side: "right", lane: 6, width: 2 });
    expect(second.some((e) => e.type === "BreachOpened")).toBe(false);
  });

  it("a non-adjacent second breach is a fresh BreachOpened", () => {
    const state = freshState();
    breachLane(state, "right", 2);
    const events = breachLane(state, "right", 9);
    expect(events.some((e) => e.type === "BreachOpened")).toBe(true);
  });

  it("LaneCritical fires exactly when remaining lane HP reaches 1", () => {
    const state = freshState(); // brick(3) + hay(1) per lane = 4 HP
    const events: GameEvent[] = [];
    damageCell(state, "left", 0, 3, 1, 0, events); // 4→3
    damageCell(state, "left", 0, 3, 1, 0, events); // 3→2
    expect(events.some((e) => e.type === "LaneCritical")).toBe(false);
    damageCell(state, "left", 0, 3, 1, 0, events); // 2→1 (front brick destroyed)
    expect(events.filter((e) => e.type === "LaneCritical")).toHaveLength(1);
    // Destroying the last cell breaches — critical clears WITHOUT a Cleared event.
    const more: GameEvent[] = [];
    damageCell(state, "left", 1, 3, 1, 0, more);
    expect(state.sides.left.wall.criticalLanes[3]).toBe(false);
    expect(more.some((e) => e.type === "LaneCriticalCleared")).toBe(false);
    expect(more.some((e) => e.type === "BreachOpened")).toBe(true);
  });
});

describe("incremental cache == full recompute (property, §12.3)", () => {
  it("stays consistent under randomized damage sequences (30 seeds × 120 ops)", () => {
    for (let seed = 0; seed < 30; seed++) {
      const state = freshState({
        wallsLeft: [
          Array.from({ length: 12 }, (_, i) => (i % 3 === 0 ? "metal" : "hay")),
          Array.from({ length: 12 }, () => "brick"),
        ],
      });
      const rng = deriveStream(seed, 99);
      const events: GameEvent[] = [];
      for (let op = 0; op < 120; op++) {
        const side = rngInt(rng, 0, 2) === 0 ? "left" : "right";
        const wall = state.sides[side].wall;
        if (wall.layers.length === 0) continue;
        const layer = rngInt(rng, 0, wall.layers.length);
        const lane = rngInt(rng, 0, wall.laneCount);
        damageCell(state, side, layer, lane, 1, 0, events);
        // onLaneChanged dev-asserts cache == recompute internally; verify
        // the predicate agrees lane-by-lane as well:
        for (let l = 0; l < wall.laneCount; l++) {
          expect(wall.breachedLanes[l]).toBe(laneBreached(wall, l));
        }
      }
      // Event-stream sanity: no Closed without a prior Opened on that lane.
      const openedLanes = new Set(
        events.filter((e) => e.type === "BreachOpened" || e.type === "BreachWidened")
          .map((e) => `${(e as { side: string }).side}:${(e as { lane: number }).lane}`),
      );
      for (const e of events) {
        if (e.type === "BreachClosed") {
          expect(openedLanes.has(`${e.side}:${e.lane}`)).toBe(true);
        }
      }
    }
  });
});

describe("rebuild-on-life-lost modes (R-4.5, config-switched)", () => {
  it("breach_fill refills breached lanes with the rebuild material and emits BreachClosed", () => {
    const state = freshState({ rules: { rebuild_on_life_lost: "breach_fill" } });
    breachLane(state, "left", 4);
    expect(state.sides.left.wall.breachedLanes[4]).toBe(true);
    const events: GameEvent[] = [];
    rebuildWall(state, "left", events);
    recomputeAll(state, "left", "rebuild", events);
    expect(events.some((e) => e.type === "WallRebuilt" && e.mode === "breach_fill")).toBe(true);
    expect(events.some((e) => e.type === "BreachClosed" && e.lane === 4)).toBe(true);
    expect(state.sides.left.wall.breachedLanes[4]).toBe(false);
    const refilled = state.sides.left.wall.layers[0]![4];
    expect(refilled?.material).toBe("hay"); // rebuild_material default
  });

  it("full restores the level-start wall", () => {
    const state = freshState({ rules: { rebuild_on_life_lost: "full" } });
    breachLane(state, "left", 0);
    breachLane(state, "left", 1);
    const events: GameEvent[] = [];
    rebuildWall(state, "left", events);
    recomputeAll(state, "left", "rebuild", events);
    const wall = state.sides.left.wall;
    expect(wall.breachCount).toBe(0);
    expect(wall.layers[0]!.every((c) => c !== null && c.hp === c.maxHp)).toBe(true);
  });

  it("none leaves the wall as-is", () => {
    const state = freshState();
    breachLane(state, "left", 0);
    const events: GameEvent[] = [];
    rebuildWall(state, "left", events);
    expect(events).toHaveLength(0);
    expect(state.sides.left.wall.breachedLanes[0]).toBe(true);
  });
});

describe("integration: breach caches never drift in real play", () => {
  it("500 stepMatch ticks with dev assertions on", () => {
    const state = createMatch(testMatchConfig({ rules: { first_receiver: "left" } }), 3);
    for (let i = 0; i < 500; i++) stepMatch(state, neutralInputs());
    expect(state.tick).toBe(500);
  });
});
