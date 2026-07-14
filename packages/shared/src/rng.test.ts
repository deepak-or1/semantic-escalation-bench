import { describe, expect, it } from "vitest";
import {
  createRng,
  hashSeed,
  poissonSample,
  rngDistinctIndices,
  rngInt,
  rngShuffle
} from "./rng";

function take(fn: () => number, n: number): number[] {
  return Array.from({ length: n }, () => fn());
}

describe("createRng", () => {
  it("produces identical 100-value sequences for the same seed", () => {
    const a = take(createRng(12345), 100);
    const b = take(createRng(12345), 100);
    expect(a).toEqual(b);
  });

  it("produces different sequences for different seeds", () => {
    const a = take(createRng(1), 100);
    const b = take(createRng(2), 100);
    expect(a).not.toEqual(b);
  });

  it("accepts string seeds via hashSeed and stays deterministic", () => {
    const a = take(createRng("league:7"), 50);
    const b = take(createRng("league:7"), 50);
    expect(a).toEqual(b);
  });
});

describe("rngInt", () => {
  it("hits both inclusive bounds over 2000 draws for [0,3]", () => {
    const rng = createRng(99);
    const draws = take(() => rngInt(rng, 0, 3), 2000);
    expect(Math.min(...draws)).toBe(0);
    expect(Math.max(...draws)).toBe(3);
    expect(draws.every((d) => d >= 0 && d <= 3 && Number.isInteger(d))).toBe(true);
  });

  it("throws when max < min", () => {
    expect(() => rngInt(createRng(1), 5, 2)).toThrow();
  });
});

describe("uniform distribution", () => {
  it("mean of 10000 uniforms is within [0.48, 0.52]", () => {
    const rng = createRng(2024);
    const values = take(rng, 10000);
    const mean = values.reduce((a, v) => a + v, 0) / values.length;
    expect(mean).toBeGreaterThanOrEqual(0.48);
    expect(mean).toBeLessThanOrEqual(0.52);
  });
});

describe("rngShuffle", () => {
  it("preserves the multiset", () => {
    const input = Array.from({ length: 50 }, (_, i) => i);
    const shuffled = rngShuffle(createRng(7), input);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(input);
  });

  it("does not mutate the input", () => {
    const input = [1, 2, 3, 4, 5];
    const snapshot = [...input];
    rngShuffle(createRng(7), input);
    expect(input).toEqual(snapshot);
  });

  it("is deterministic for the same seed", () => {
    const input = Array.from({ length: 50 }, (_, i) => i);
    expect(rngShuffle(createRng(7), input)).toEqual(rngShuffle(createRng(7), input));
  });
});

describe("rngDistinctIndices", () => {
  it("returns unique indices within [0, size)", () => {
    const indices = rngDistinctIndices(createRng(3), 10, 5);
    expect(indices).toHaveLength(5);
    expect(new Set(indices).size).toBe(5);
    expect(indices.every((i) => i >= 0 && i < 10)).toBe(true);
  });

  it("throws when count > size", () => {
    expect(() => rngDistinctIndices(createRng(3), 3, 5)).toThrow();
  });
});

describe("poissonSample", () => {
  it("mean of 10000 samples at lambda 1.4 is within 10 percent", () => {
    const rng = createRng(555);
    const samples = take(() => poissonSample(rng, 1.4), 10000);
    const mean = samples.reduce((a, v) => a + v, 0) / samples.length;
    expect(mean).toBeGreaterThanOrEqual(1.4 * 0.9);
    expect(mean).toBeLessThanOrEqual(1.4 * 1.1);
  });

  it("returns 0 for lambda <= 0", () => {
    expect(poissonSample(createRng(1), 0)).toBe(0);
    expect(poissonSample(createRng(1), -2)).toBe(0);
  });
});

describe("hashSeed", () => {
  it("is deterministic", () => {
    expect(hashSeed("a")).toBe(hashSeed("a"));
  });

  it("differs for 'a' vs 'b'", () => {
    expect(hashSeed("a")).not.toBe(hashSeed("b"));
  });
});
