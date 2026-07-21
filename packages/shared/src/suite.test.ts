import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SCENARIOS } from "./scenarios";
import {
  ScenarioSuiteError,
  computeBuiltinCatalogHash,
  loadScenarioSuite,
  serializeScenariosCanonical,
  type SuiteScenario
} from "./suite";

const dir = mkdtempSync(path.join(tmpdir(), "ssda-suite-"));
let n = 0;

/** Write `obj` as JSON to a fresh temp file and return { path, bytes }. */
function writeSuiteFile(obj: unknown): { file: string; bytes: Buffer } {
  const file = path.join(dir, `suite-${n++}.json`);
  const text = JSON.stringify(obj, null, 2);
  const bytes = Buffer.from(text, "utf8");
  writeFileSync(file, bytes);
  return { file, bytes };
}

function f2Scenario(over: Partial<SuiteScenario> = {}): SuiteScenario {
  return {
    id: "f2-l1-a",
    name: "F2 decoy rebinding, level 1, instance a",
    description: "Fixed [pagination, hiddenTab] scaffold; decoyLevel 1 rebinds next-page.",
    chaos: ["pagination", "hiddenTab"],
    params: {
      decoyLevel: 1,
      decoyCopy: { "next-page": "Load more results" },
      decoyPlacement: "after"
    },
    seed: 2210,
    session: "fresh",
    expected: "success",
    stratum: "F2",
    stratumId: "level-1",
    predictions: {
      A: "observed-failure",
      B: "observed-failure",
      B2: "observed-failure",
      C: "observed-failure",
      D: "all-pass"
    },
    ...over
  };
}

function suiteOf(scenarios: SuiteScenario[]): { protocolId: string; scenarios: SuiteScenario[] } {
  return { protocolId: "phase2a-v1", scenarios };
}

describe("loadScenarioSuite", () => {
  it("loads a valid suite and returns protocolId, scenarios, and the file-bytes suiteHash", () => {
    const suite = suiteOf([
      f2Scenario(),
      f2Scenario({ id: "f2-l1-b", name: "instance b", seed: 2211 })
    ]);
    const { file, bytes } = writeSuiteFile(suite);
    const loaded = loadScenarioSuite(file);

    expect(loaded.protocolId).toBe("phase2a-v1");
    expect(loaded.scenarios).toHaveLength(2);
    // suiteHash is SHA-256 hex of the exact raw file bytes, independently computed.
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(loaded.suiteHash).toBe(expected);
    expect(loaded.suiteHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts repeated seeds across scenarios (paired seeds across levels, §4)", () => {
    const suite = suiteOf([
      f2Scenario({ id: "f2-l0-a", stratumId: "level-0", params: { decoyLevel: 0 }, seed: 2210 }),
      f2Scenario({ id: "f2-l1-a", stratumId: "level-1", seed: 2210 })
    ]);
    const { file } = writeSuiteFile(suite);
    const loaded = loadScenarioSuite(file);
    expect(loaded.scenarios.map((s) => s.seed)).toEqual([2210, 2210]);
  });

  it("rejects a duplicate scenario id (uniqueness is on ids, not seeds)", () => {
    const { file } = writeSuiteFile(suiteOf([f2Scenario(), f2Scenario({ seed: 2211 })]));
    expect(() => loadScenarioSuite(file)).toThrow(ScenarioSuiteError);
    expect(() => loadScenarioSuite(file)).toThrow(/duplicate scenario id/i);
  });

  it("rejects a seed outside the reserved 2201–2299 range", () => {
    const { file } = writeSuiteFile(suiteOf([f2Scenario({ seed: 2300 })]));
    expect(() => loadScenarioSuite(file)).toThrow(/range 2201.?2299|reserved Phase-2A seed range/i);
  });

  it("rejects a flag-XOR-param contradiction (§3 precedence)", () => {
    // pagination flag + pageSize param target the same surface — mutually exclusive.
    const bad = f2Scenario({
      id: "f3-bad",
      stratum: "F3",
      stratumId: "pageSize-3",
      chaos: ["pagination"],
      params: { pageSize: 3 }
    });
    const { file } = writeSuiteFile(suiteOf([bad]));
    expect(() => loadScenarioSuite(file)).toThrow(/mutually exclusive/i);
  });

  it("rejects an F2 scenario missing the [pagination, hiddenTab] scaffold (§3)", () => {
    const bad = f2Scenario({ chaos: ["pagination"] }); // hiddenTab missing
    const { file } = writeSuiteFile(suiteOf([bad]));
    expect(() => loadScenarioSuite(file)).toThrow(/scaffold/i);
  });

  it("rejects decoyLevel >= 1 composed with a layout condition at load (§3)", () => {
    const bad = f2Scenario({
      id: "x-decoy-layout",
      stratum: "X",
      stratumId: "decoy×cards",
      chaos: ["pagination"],
      params: { decoyLevel: 1, layoutCondition: "cards" }
    });
    const { file } = writeSuiteFile(suiteOf([bad]));
    expect(() => loadScenarioSuite(file)).toThrow(/Layout suppresses pagination/);
  });

  it("rejects a non-permutation columnOrder at load", () => {
    const bad = f2Scenario({
      id: "k-badorder",
      stratum: "K",
      stratumId: "cols",
      chaos: [],
      params: { columnOrder: ["P", "P", "W", "D", "L", "GF", "GA", "GD", "Form"] as never } // dup P, no Pts
    });
    const { file } = writeSuiteFile(suiteOf([bad]));
    expect(() => loadScenarioSuite(file)).toThrow(/permutation/i);
  });

  it("rejects an inverted timing range at load (same scenario the lab 400s)", () => {
    const bad = f2Scenario({
      id: "k-timing",
      stratum: "K",
      stratumId: "timing",
      chaos: ["delayedRender"],
      params: { delayRangeMs: [500, 100] }
    });
    const { file } = writeSuiteFile(suiteOf([bad]));
    expect(() => loadScenarioSuite(file)).toThrow(/inverted/i);
  });

  it("rejects a non-fresh session, naming the scenario and the §3 rule", () => {
    const bad = f2Scenario({ id: "sess-bad", session: "reuse" });
    const { file } = writeSuiteFile(suiteOf([bad]));
    expect(() => loadScenarioSuite(file)).toThrow(ScenarioSuiteError);
    expect(() => loadScenarioSuite(file)).toThrow(/sess-bad.*fresh-session.*§3/s);
  });

  it("rejects a non-success expectation, naming the scenario and the §3 rule", () => {
    const bad = f2Scenario({ expected: "validation-failure" });
    const { file } = writeSuiteFile(suiteOf([bad]));
    expect(() => loadScenarioSuite(file)).toThrow(ScenarioSuiteError);
    expect(() => loadScenarioSuite(file)).toThrow(/f2-l1-a.*expected: "success".*§3/s);
  });

  it("rejects a bad prediction value (schema)", () => {
    const bad = f2Scenario();
    (bad.predictions as Record<string, string>).C = "maybe";
    const { file } = writeSuiteFile(suiteOf([bad]));
    expect(() => loadScenarioSuite(file)).toThrow(/predictions/i);
  });

  it("rejects a bad stratum label (schema)", () => {
    const bad = f2Scenario();
    (bad as Record<string, unknown>).stratum = "F4";
    const { file } = writeSuiteFile(suiteOf([bad]));
    expect(() => loadScenarioSuite(file)).toThrow(/stratum/i);
  });

  it("rejects a suite whose top-level JSON is malformed", () => {
    const file = path.join(dir, `broken-${n++}.json`);
    writeFileSync(file, "{ not json");
    expect(() => loadScenarioSuite(file)).toThrow(/not valid JSON/i);
  });
});

describe("computeBuiltinCatalogHash", () => {
  it("is the SHA-256 of the catalog's canonical serialization, via the one serializer", () => {
    const viaSerializer = createHash("sha256")
      .update(serializeScenariosCanonical(SCENARIOS))
      .digest("hex");
    expect(computeBuiltinCatalogHash()).toBe(viaSerializer);
  });

  it("is a stable 64-char hex digest across calls", () => {
    const a = computeBuiltinCatalogHash();
    const b = computeBuiltinCatalogHash();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
