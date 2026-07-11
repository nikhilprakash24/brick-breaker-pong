/**
 * Config validation suite (SPEC-3.12 §12.1, Phase 0 DoD: a deliberately
 * broken config fails boot with a path-precise report).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateTuningJson } from "../src/config/load";

const goodTuning = (): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL("../src/config/data/tuning.json", import.meta.url), "utf-8"));

describe("tuning.json validation", () => {
  it("accepts the shipped tuning file", () => {
    const { tuning, errors } = validateTuningJson(goodTuning());
    expect(errors).toEqual([]);
    expect(tuning).toBeDefined();
  });

  it("converts ms durations to ticks at load (§0.6.1)", () => {
    const { tuning } = validateTuningJson(goodTuning());
    expect(tuning!.rules.intro_duration).toBe(360); // 3000 ms at 120 Hz
    expect(tuning!.rules.serve_delay).toBe(120); // 1000 ms
    expect(tuning!.wall.placement_window).toBe(300); // 2500 ms
    expect(tuning!.rules.life_lost_seq).toBe(108); // 900 ms
  });

  it("rejects a wrong-typed value with a path-precise report", () => {
    const bad = goodTuning();
    (bad.physics as Record<string, unknown>).ball_radius = "7px";
    const { tuning, errors } = validateTuningJson(bad);
    expect(tuning).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.file).toBe("tuning.json");
    expect(errors[0]!.path).toBe("physics.ball_radius");
    expect(errors[0]!.message).toContain('"7px"');
  });

  it("rejects an out-of-range value", () => {
    const bad = goodTuning();
    (bad.physics as Record<string, unknown>).ball_radius = 99;
    const { errors } = validateTuningJson(bad);
    expect(errors.map((e) => e.path)).toContain("physics.ball_radius");
  });

  it("rejects a missing key", () => {
    const bad = goodTuning();
    delete (bad.rally as Record<string, unknown>).rally_cap_hits;
    const { errors } = validateTuningJson(bad);
    expect(errors).toContainEqual(
      expect.objectContaining({ path: "rally.rally_cap_hits", message: "missing required key" }),
    );
  });

  it("rejects an unknown key (registry-id key-set equality, DEC-P2-6)", () => {
    const bad = goodTuning();
    (bad.physics as Record<string, unknown>).ball_radius_typo = 7;
    const { errors } = validateTuningJson(bad);
    expect(errors.some((e) => e.path === "physics.ball_radius_typo")).toBe(true);
  });

  it("reports ALL errors, not just the first", () => {
    const bad = goodTuning();
    (bad.physics as Record<string, unknown>).ball_radius = "7px";
    delete (bad.rally as Record<string, unknown>).overheat_period;
    const { errors } = validateTuningJson(bad);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects a non-monotone speed curve", () => {
    const bad = goodTuning();
    (bad.rally as Record<string, unknown>).speed_curve = [
      1.0, 1.1, 1.2, 1.3, 1.45, 1.4, 1.8, 2.05, 2.3, 2.6, 3.0,
    ];
    const { errors } = validateTuningJson(bad);
    expect(errors.map((e) => e.path)).toContain("rally.speed_curve");
  });

  it("runs the GR2-5 steering audit: cos(cap) must exceed ball_min_vx_frac", () => {
    const bad = goodTuning();
    (bad.physics as Record<string, unknown>).ball_min_vx_frac = 0.35;
    (bad.physics as Record<string, unknown>).steering_angle_cap = 80;
    const { errors } = validateTuningJson(bad);
    expect(errors.some((e) => e.message.includes("GR2-5"))).toBe(true);
  });
});
