/**
 * Level schema + wall authoring grammar (SPEC-2.2 §2.2.5, §7.9): run-length
 * expansion, mirror / mirror-check suffixes, R-1.3 layer cap, cross-refs —
 * every failing fixture with a path-precise message.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  expandLayerSpec,
  resolveMatchConfig,
  validateLevelJson,
} from "../src/config/levels";
import type { ValidationError } from "../src/config/validate";
import { materials, panels, tuning } from "./helpers";

function goodLevel(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("../src/config/data/levels/dev-flat.json", import.meta.url), "utf-8"),
  );
}

function ctx(errors: ValidationError[]) {
  return { file: "t.json", path: "walls.left.layers[0]", errors };
}

describe("wall authoring grammar (§2.2.5)", () => {
  it("expands run-length strings to lane_count entries", () => {
    const errors: ValidationError[] = [];
    const row = expandLayerSpec("hay*2 brick*8 hay*2", 12, materials, ctx(errors));
    expect(errors).toEqual([]);
    expect(row).toHaveLength(12);
    expect(row![0]).toBe("hay");
    expect(row![2]).toBe("brick");
    expect(row![11]).toBe("hay");
  });

  it("accepts bare tokens as count 1", () => {
    const errors: ValidationError[] = [];
    const row = expandLayerSpec("hay*4 obsidian hay*2 obsidian hay*4", 12, materials, ctx(errors));
    expect(errors).toEqual([]);
    expect(row![4]).toBe("obsidian");
    expect(row![7]).toBe("obsidian");
  });

  it("rejects a count mismatch with the expected lane_count in the message", () => {
    const errors: ValidationError[] = [];
    expandLayerSpec("brick*11", 12, materials, ctx(errors));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe("walls.left.layers[0]");
    expect(errors[0]!.message).toContain("lane_count = 12");
  });

  it("rejects unknown materials", () => {
    const errors: ValidationError[] = [];
    expandLayerSpec("obsidan*12", 12, materials, ctx(errors)); // the spec's own typo example
    expect(errors[0]!.message).toContain('unknown material "obsidan"');
  });

  it("rejects malformed run-length tokens", () => {
    const errors: ValidationError[] = [];
    expandLayerSpec("brick*x hay*11", 12, materials, ctx(errors));
    expect(errors[0]!.message).toContain('"brick*x"');
  });

  it("| mirror authors the first half and mirrors it (even lane count)", () => {
    const errors: ValidationError[] = [];
    const row = expandLayerSpec("hay*2 brick*4 | mirror", 12, materials, ctx(errors));
    expect(errors).toEqual([]);
    expect(row).toEqual([
      "hay", "hay", "brick", "brick", "brick", "brick",
      "brick", "brick", "brick", "brick", "hay", "hay",
    ]);
  });

  it("| mirror shares the center lane on odd counts", () => {
    const errors: ValidationError[] = [];
    const row = expandLayerSpec("hay*3 metal*4 | mirror", 13, materials, ctx(errors));
    expect(errors).toEqual([]);
    expect(row).toHaveLength(13);
    expect(row![6]).toBe("metal"); // center authored once
    expect(row![0]).toBe(row![12]);
    expect(row![3]).toBe(row![9]);
  });

  it("| mirror with the wrong half-length is rejected", () => {
    const errors: ValidationError[] = [];
    expandLayerSpec("hay*4 | mirror", 12, materials, ctx(errors));
    expect(errors[0]!.message).toContain("ceil(lane_count/2) = 6");
  });

  it("| mirror-check passes symmetric rows and rejects asymmetric ones", () => {
    const ok: ValidationError[] = [];
    expandLayerSpec("hay*4 obsidian*1 hay*2 obsidian*1 hay*4 | mirror-check", 12, materials, ctx(ok));
    expect(ok).toEqual([]);
    const bad: ValidationError[] = [];
    expandLayerSpec("obsidian*1 hay*11 | mirror-check", 12, materials, ctx(bad));
    expect(bad[0]!.message).toContain("mirror-check");
  });

  it("rejects an unknown suffix", () => {
    const errors: ValidationError[] = [];
    expandLayerSpec("hay*12 | mirrorr", 12, materials, ctx(errors));
    expect(errors[0]!.message).toContain("unknown layer suffix");
  });

  it("explicit arrays are validated for length and materials", () => {
    const errors: ValidationError[] = [];
    expandLayerSpec(["hay", "hay"], 12, materials, ctx(errors));
    expect(errors[0]!.message).toContain("2 entries");
  });
});

describe("level schema (§7.3 Phase-2 subset)", () => {
  it("accepts both shipped level files", () => {
    for (const f of ["dev-flat.json", "dev-asym.json"]) {
      const raw = JSON.parse(
        readFileSync(new URL(`../src/config/data/levels/${f}`, import.meta.url), "utf-8"),
      );
      const { level, errors } = validateLevelJson(f, raw, materials, panels);
      expect(errors).toEqual([]);
      expect(level).toBeDefined();
      expect(level!.walls.left.layers.every((l) => l.length === level!.walls.lane_count)).toBe(true);
    }
  });

  it("rejects a 4th authored layer (R-1.3)", () => {
    const bad = goodLevel();
    (bad.walls as { left: { layers: unknown[] } }).left.layers = [
      "hay*12", "hay*12", "hay*12", "hay*12",
    ];
    const { level, errors } = validateLevelJson("t.json", bad, materials, panels);
    expect(level).toBeUndefined();
    expect(errors[0]!.path).toBe("walls.left.layers");
    expect(errors[0]!.message).toContain("max is 3");
  });

  it("accepts a 0-layer side", () => {
    const lvl = goodLevel();
    (lvl.walls as { left: { layers: unknown[] } }).left.layers = [];
    const { level, errors } = validateLevelJson("t.json", lvl, materials, panels);
    expect(errors).toEqual([]);
    expect(level!.walls.left.layers).toEqual([]);
  });

  it("rejects an unknown rebuild material with a path-precise report", () => {
    const bad = goodLevel();
    (bad.rules as Record<string, unknown>).rebuild_material = "straw";
    const { errors } = validateLevelJson("t.json", bad, materials, panels);
    expect(errors).toContainEqual(
      expect.objectContaining({ path: "rules.rebuild_material" }),
    );
  });

  it("rejects unknown and missing keys", () => {
    const bad = goodLevel();
    (bad as Record<string, unknown>).arena_shape = "flat";
    delete (bad as Record<string, unknown>).display_name;
    const { errors } = validateLevelJson("t.json", bad, materials, panels);
    expect(errors.map((e) => e.path)).toContain("arena_shape");
    expect(errors.map((e) => e.path)).toContain("display_name");
  });
});

describe("resolveMatchConfig (§7.7)", () => {
  it("story mode: the human (left) receives first (R-2.1)", () => {
    const { level } = validateLevelJson("dev-flat.json", goodLevel(), materials, panels);
    const cfg = resolveMatchConfig(level!, tuning, materials, panels, "story");
    expect(cfg.rules.first_receiver).toBe("left");
    expect(cfg.laneCount).toBe(12);
    expect(cfg.walls.left.layers).toHaveLength(2);
  });

  it("versus mode: seeded coin flip", () => {
    const { level } = validateLevelJson("dev-flat.json", goodLevel(), materials, panels);
    const cfg = resolveMatchConfig(level!, tuning, materials, panels, "versus");
    expect(cfg.rules.first_receiver).toBe("random");
  });
});
