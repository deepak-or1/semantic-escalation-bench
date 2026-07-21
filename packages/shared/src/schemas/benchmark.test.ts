import { describe, expect, it } from "vitest";
import { BenchmarkResultsSchema } from "./benchmark";

/**
 * The optional `stopped` marker on BenchmarkResults (PROTOCOL_2A §7): present only
 * when a pre-trial budget stop halted the run. Being optional, every pre-existing
 * results.json (which never carried it) must still parse; when present it records
 * why the campaign stopped and how far it got.
 */

/** A minimal, schema-valid results document with no trials (the base to extend). */
function baseResults(): Record<string, unknown> {
  return {
    benchId: "bench-x",
    createdAt: "2026-07-20T00:00:00.000Z",
    labUrl: "http://127.0.0.1:0",
    trialsPerScenario: 1,
    scenarios: [],
    trials: [],
    engines: [],
    comparison: [],
    environment: {
      node: "v20",
      modelProvider: null,
      browserbase: false,
      gitCommit: "commit0",
      gitDirty: false,
      disableRepair: false,
      seedCacheMode: "none",
      seedCacheHash: null,
      promptsHash: "P",
      lockfileHash: "L"
    }
  };
}

describe("BenchmarkResultsSchema — optional stopped marker", () => {
  it("parses a results document WITHOUT stopped (every pre-existing file stays valid)", () => {
    const parsed = BenchmarkResultsSchema.safeParse(baseResults());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.stopped).toBeUndefined();
  });

  it("parses a results document WITH a well-formed stopped marker", () => {
    const parsed = BenchmarkResultsSchema.safeParse({
      ...baseResults(),
      stopped: { reason: "budget stop", completedTrials: 3, plannedTrials: 10 }
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.stopped).toEqual({
        reason: "budget stop",
        completedTrials: 3,
        plannedTrials: 10
      });
    }
  });

  it("rejects a stopped marker missing a required field", () => {
    const parsed = BenchmarkResultsSchema.safeParse({
      ...baseResults(),
      stopped: { reason: "budget stop", completedTrials: 3 } // plannedTrials missing
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a negative completedTrials in the stopped marker", () => {
    const parsed = BenchmarkResultsSchema.safeParse({
      ...baseResults(),
      stopped: { reason: "budget stop", completedTrials: -1, plannedTrials: 10 }
    });
    expect(parsed.success).toBe(false);
  });
});
