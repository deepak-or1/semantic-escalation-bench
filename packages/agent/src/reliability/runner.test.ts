import { computeBuiltinCatalogHash } from "@ssda/shared";
import { describe, expect, it } from "vitest";
import { resolveSuiteProvenance, unanimousChromeVersion } from "./runner";

/**
 * Provenance stamping (PROTOCOL_2A §5 items 4/6). runBenchmark stamps
 * environment.protocolId + environment.suiteHash on EVERY run via
 * resolveSuiteProvenance; this pins the resolution both ways.
 */
describe("resolveSuiteProvenance", () => {
  it("built-in-catalog run (neither field) → phase1-catalog + the catalog hash", () => {
    expect(resolveSuiteProvenance({})).toEqual({
      protocolId: "phase1-catalog",
      suiteHash: computeBuiltinCatalogHash()
    });
  });

  it("scenario-suite run → the suite's protocolId and file-bytes hash verbatim", () => {
    expect(
      resolveSuiteProvenance({ protocolId: "phase2a-v1", suiteHash: "deadbeef".repeat(8) })
    ).toEqual({ protocolId: "phase2a-v1", suiteHash: "deadbeef".repeat(8) });
  });

  it("a bare protocolId still falls back to the catalog hash for suiteHash", () => {
    const r = resolveSuiteProvenance({ protocolId: "phase2a-v1" });
    expect(r.protocolId).toBe("phase2a-v1");
    expect(r.suiteHash).toBe(computeBuiltinCatalogHash());
  });
});

/**
 * Run-level browser provenance (record version 2, docs/RECORD_FORMAT.md). The
 * build is a PER-TRIAL fact; the run-level field is a summary that may only
 * speak when every trial agrees. The bug this pins: collecting reported versions
 * into a Set and emitting when its size is 1 treats a trial that reported
 * NOTHING as agreeing with its siblings, so a baseline+hybrid run gets labelled
 * with whichever engine happened to answer.
 */
describe("unanimousChromeVersion", () => {
  it("every trial reported the SAME build → that build", () => {
    expect(
      unanimousChromeVersion([{ chromeVersion: "140.0.7339.16" }, { chromeVersion: "140.0.7339.16" }])
    ).toBe("140.0.7339.16");
  });

  it("trials reported DIFFERENT builds → null (a run is never labelled with one engine's browser)", () => {
    expect(
      unanimousChromeVersion([
        { chromeVersion: "140.0.7339.16" },
        { chromeVersion: "HeadlessChrome/140.0.7339.16" }
      ])
    ).toBeNull();
  });

  it("NAMED REGRESSION: a silent trial is not a vote — one reporter plus one null → null", () => {
    expect(
      unanimousChromeVersion([{ chromeVersion: "140.0.7339.16" }, { chromeVersion: null }])
    ).toBeNull();
    expect(
      unanimousChromeVersion([{ chromeVersion: "140.0.7339.16" }, { chromeVersion: undefined }])
    ).toBeNull();
    expect(unanimousChromeVersion([{ chromeVersion: "140.0.7339.16" }, {}])).toBeNull();
  });

  it("no trials, or no trial reported anything → null", () => {
    expect(unanimousChromeVersion([])).toBeNull();
    expect(unanimousChromeVersion([{ chromeVersion: null }, { chromeVersion: null }])).toBeNull();
  });
});
