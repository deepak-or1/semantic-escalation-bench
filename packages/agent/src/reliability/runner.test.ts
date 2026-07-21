import { computeBuiltinCatalogHash } from "@ssda/shared";
import { describe, expect, it } from "vitest";
import { resolveSuiteProvenance } from "./runner";

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
