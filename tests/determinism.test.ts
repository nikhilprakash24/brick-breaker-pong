/**
 * Determinism skeleton (SPEC-3.12 §12.4): same (config, seed) ⇒ identical
 * state; RNG streams are independent; hashing is order-stable.
 */

import { describe, expect, it } from "vitest";
import { cloneMatchState, createMatch, hashState, stepMatch } from "../src/sim";
import { deriveStream, mulberry32Next } from "../src/sim/rng";
import { neutralInputs, testMatchConfig } from "./helpers";

const config = testMatchConfig();
const inputs = neutralInputs;

describe("sim determinism skeleton", () => {
  it("createMatch is pure: same (config, seed) ⇒ identical state hash", () => {
    const a = createMatch(config, 12345);
    const b = createMatch(config, 12345);
    expect(hashState(a)).toBe(hashState(b));
    expect(a).toEqual(b);
  });

  it("different seeds produce different RNG stream states", () => {
    const a = createMatch(config, 1);
    const b = createMatch(config, 2);
    expect(a.rng.serve.s).not.toBe(b.rng.serve.s);
  });

  it("two runs of 1000 ticks stay hash-identical", () => {
    const a = createMatch(config, 777);
    const b = createMatch(config, 777);
    for (let i = 0; i < 1000; i++) {
      stepMatch(a, inputs());
      stepMatch(b, inputs());
    }
    expect(a.tick).toBe(1000);
    expect(hashState(a)).toBe(hashState(b));
  });

  it("a cloned state's future is identical to the original's", () => {
    const a = createMatch(config, 42);
    for (let i = 0; i < 100; i++) stepMatch(a, inputs());
    const b = cloneMatchState(a);
    for (let i = 0; i < 100; i++) {
      stepMatch(a, inputs());
      stepMatch(b, inputs());
    }
    expect(hashState(a)).toBe(hashState(b));
  });

  it("hashState is insensitive to object key insertion order", () => {
    const a = createMatch(config, 9);
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
    expect(hashState(reordered)).toBe(hashState(a));
  });

  it("streams derived from the same seed are independent and deterministic", () => {
    const s1 = deriveStream(555, 1);
    const s2 = deriveStream(555, 2);
    expect(s1.s).not.toBe(s2.s);
    const seqA = [mulberry32Next(s1), mulberry32Next(s1), mulberry32Next(s1)];
    const s1again = deriveStream(555, 1);
    const seqB = [mulberry32Next(s1again), mulberry32Next(s1again), mulberry32Next(s1again)];
    expect(seqA).toEqual(seqB);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
