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
