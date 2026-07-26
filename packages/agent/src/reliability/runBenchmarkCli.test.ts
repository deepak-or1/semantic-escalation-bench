import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// The CLI lives at the repo root; its entrypoint guard means importing it here
// never runs main(). Exercises the --repair-mode flag plumbing (PROTOCOL_2A §1).
import { parseArgs } from "../../../../scripts/run-benchmark";

describe("run-benchmark parseArgs — --repair-mode", () => {
  afterEach(() => vi.restoreAllMocks());

  it("defaults repairMode to llm (policy C)", () => {
    expect(parseArgs([]).repairMode).toBe("llm");
  });

  it("--no-repair resolves to off (the frozen alias)", () => {
    expect(parseArgs(["--no-repair"]).repairMode).toBe("off");
  });

  it("--repair-mode <value> resolves each mode", () => {
    expect(parseArgs(["--repair-mode", "off"]).repairMode).toBe("off");
    expect(parseArgs(["--repair-mode", "deterministic"]).repairMode).toBe("deterministic");
    expect(parseArgs(["--repair-mode", "llm"]).repairMode).toBe("llm");
  });

  it("rejects --no-repair AND --repair-mode together (mutually exclusive)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number): never => {
      throw new Error(`exit ${code}`);
    }) as never);
    expect(() => parseArgs(["--no-repair", "--repair-mode", "off"])).toThrow(/exit/);
    expect(err.mock.calls.flat().join(" ")).toContain("mutually exclusive");
  });

  it("rejects an invalid --repair-mode value", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number): never => {
      throw new Error(`exit ${code}`);
    }) as never);
    expect(() => parseArgs(["--repair-mode", "bogus"])).toThrow(/exit/);
    expect(err.mock.calls.flat().join(" ")).toContain("--repair-mode must be one of");
  });
});

describe("run-benchmark parseArgs — --scenario-suite (PROTOCOL_2A §5 item 4)", () => {
  afterEach(() => vi.restoreAllMocks());

  const dir = mkdtempSync(path.join(tmpdir(), "ssda-cli-suite-"));
  function writeSuite(): { file: string; suiteHash: string } {
    const suite = {
      protocolId: "phase2a-v1",
      scenarios: [
        {
          id: "f2-l1-a",
          name: "F2 level 1 a",
          description: "decoy rebinding level 1",
          chaos: ["pagination", "hiddenTab"],
          params: { decoyLevel: 1, decoyPlacement: "after" },
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
          }
        }
      ]
    };
    const file = path.join(dir, "suite.json");
    const bytes = Buffer.from(JSON.stringify(suite, null, 2), "utf8");
    writeFileSync(file, bytes);
    return { file, suiteHash: createHash("sha256").update(bytes).digest("hex") };
  }

  it("loads the suite: scenarios, protocolId, and the file-bytes suiteHash", () => {
    const { file, suiteHash } = writeSuite();
    const args = parseArgs(["--scenario-suite", file]);
    expect(args.scenarios.map((s) => s.id)).toEqual(["f2-l1-a"]);
    expect(args.protocolId).toBe("phase2a-v1");
    expect(args.suiteHash).toBe(suiteHash);
  });

  it("rejects --scenario-suite together with --scenarios (mutually exclusive)", () => {
    const { file } = writeSuite();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number): never => {
      throw new Error(`exit ${code}`);
    }) as never);
    expect(() => parseArgs(["--scenario-suite", file, "--scenarios", "clean-extraction"])).toThrow(
      /exit/
    );
    expect(err.mock.calls.flat().join(" ")).toContain("mutually exclusive");
  });
});

describe("run-benchmark parseArgs — --only (single-cell reproduction, PROTOCOL_2A §7)", () => {
  afterEach(() => vi.restoreAllMocks());

  const dir = mkdtempSync(path.join(tmpdir(), "ssda-cli-only-"));
  /** A two-F2-scenario suite so filtering to one visibly drops the other. */
  function writeSuite2(): { file: string; suiteHash: string } {
    const mkScenario = (id: string, seed: number) => ({
      id,
      name: id,
      description: "decoy rebinding level 1",
      chaos: ["pagination", "hiddenTab"],
      params: { decoyLevel: 1, decoyPlacement: "after" },
      seed,
      session: "fresh",
      expected: "success",
      stratum: "F2",
      stratumId: "level-1",
      predictions: { A: "observed-failure", B: "observed-failure", B2: "observed-failure", C: "observed-failure", D: "all-pass" }
    });
    const suite = { protocolId: "phase2a-v1", scenarios: [mkScenario("f2-a", 2210), mkScenario("f2-b", 2211)] };
    const file = path.join(dir, "suite2.json");
    const bytes = Buffer.from(JSON.stringify(suite, null, 2), "utf8");
    writeFileSync(file, bytes);
    return { file, suiteHash: createHash("sha256").update(bytes).digest("hex") };
  }

  it("valid filter: keeps only the named ids and leaves suite provenance UNCHANGED", () => {
    const { file, suiteHash } = writeSuite2();
    // The unfiltered suite carries both scenarios and the file-bytes hash.
    const full = parseArgs(["--scenario-suite", file]);
    expect(full.scenarios.map((s) => s.id)).toEqual(["f2-a", "f2-b"]);

    const filtered = parseArgs(["--scenario-suite", file, "--only", "f2-b"]);
    expect(filtered.scenarios.map((s) => s.id)).toEqual(["f2-b"]);
    // Provenance stamps are of the WHOLE suite, unchanged by filtering.
    expect(filtered.protocolId).toBe("phase2a-v1");
    expect(filtered.suiteHash).toBe(suiteHash);
    expect(filtered.suiteHash).toBe(full.suiteHash);
  });

  it("rejects an unknown --only id, listing the valid ids", () => {
    const { file } = writeSuite2();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number): never => {
      throw new Error(`exit ${code}`);
    }) as never);
    expect(() => parseArgs(["--scenario-suite", file, "--only", "nope"])).toThrow(/exit/);
    const msg = err.mock.calls.flat().join(" ");
    expect(msg).toContain('unknown scenario id "nope"');
    expect(msg).toContain("f2-a, f2-b");
  });

  it("rejects --only without --scenario-suite", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number): never => {
      throw new Error(`exit ${code}`);
    }) as never);
    expect(() => parseArgs(["--only", "f2-a"])).toThrow(/exit/);
    expect(err.mock.calls.flat().join(" ")).toContain("valid only together with --scenario-suite");
  });
});

/**
 * Phase-2B arm machinery on the bench CLI (docs/PROTOCOL_2B.md §Design). The
 * default matters as much as the flag: an unflagged run must be the Phase-2A
 * arm, and must say so, so a 2A-style run is never silently unlabelled.
 */
describe("run-benchmark parseArgs — --readiness-mode / --campaign-protocol-id", () => {
  afterEach(() => vi.restoreAllMocks());

  it("defaults readinessMode to frozen (the Phase-2A predicate)", () => {
    expect(parseArgs([]).readinessMode).toBe("frozen");
  });

  it("--readiness-mode any-row selects arm R", () => {
    expect(parseArgs(["--readiness-mode", "any-row"]).readinessMode).toBe("any-row");
  });

  it("--readiness-mode frozen is accepted explicitly", () => {
    expect(parseArgs(["--readiness-mode", "frozen"]).readinessMode).toBe("frozen");
  });

  it("rejects an unknown readiness mode rather than guessing an arm", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => parseArgs(["--readiness-mode", "relaxed"])).toThrow();
    expect(exit).toHaveBeenCalled();
  });

  it("campaignProtocolId is ABSENT unless the flag names one — never defaulted", () => {
    expect(parseArgs([]).campaignProtocolId).toBeUndefined();
    expect(parseArgs(["--campaign-protocol-id", "phase2b-ablation-v1"]).campaignProtocolId).toBe(
      "phase2b-ablation-v1"
    );
  });

  it("--campaign-protocol-id with no value is an error", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => parseArgs(["--campaign-protocol-id"])).toThrow();
    expect(exit).toHaveBeenCalled();
  });
});
