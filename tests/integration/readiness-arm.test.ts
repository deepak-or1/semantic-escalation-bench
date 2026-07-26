import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBenchmark } from "@ssda/agent";
import {
  BenchmarkResultsSchema,
  createRunDir,
  type BenchmarkResults,
  type ScenarioSpec
} from "@ssda/shared";
import { startLab, stopLab, tmpDir, type Lab } from "./helpers";

/**
 * Phase-2B arm machinery, end to end against real engines and a real lab
 * (docs/PROTOCOL_2B.md §Design).
 *
 * PROTOCOL INTEGRITY: none of the five Phase-2B allowlisted scenario ids
 * (f3-page-size-3-a, f3-page-size-3-b, f3-page-size-2-a, f3-page-size-2-b,
 * x-class-l3-page-size-2) appears here, and none is run under `any-row`.
 * Observing those cells' any-row behaviour before the expectations are
 * registered at gate 5 would contaminate the campaign. The scenario below is a
 * clean, default-size dev page under a local id — a page where BOTH arms are
 * expected to behave identically, which is exactly what makes it a safe control.
 */

const CLEAN_DEFAULT: ScenarioSpec = {
  id: "arm-clean-default-size",
  name: "clean, default page size",
  description: "no perturbation, full-size tables — both arms see a ready page",
  chaos: [],
  seed: 2201,
  session: "fresh",
  expected: "success",
  group: "core"
};

let lab: Lab;
let tempRunsDir: string;
let prevRunsDir: string | undefined;

async function runArm(config: {
  readinessMode?: "frozen" | "any-row";
  campaignProtocolId?: string;
}): Promise<{ results: BenchmarkResults; dir: string }> {
  const { dir, runId } = await createRunDir({ kind: "bench", labUrl: lab.url });
  const results = await runBenchmark({
    labUrl: lab.url,
    engines: ["baseline", "hybrid"],
    scenarios: [CLEAN_DEFAULT],
    trialsPerScenario: 1,
    headless: true,
    benchDir: dir,
    benchId: runId,
    ...(config.readinessMode ? { readinessMode: config.readinessMode } : {}),
    ...(config.campaignProtocolId ? { campaignProtocolId: config.campaignProtocolId } : {})
  });
  return { results, dir };
}

beforeAll(async () => {
  prevRunsDir = process.env.SSDA_RUNS_DIR;
  tempRunsDir = await tmpDir("ssda-runs-arm-");
  process.env.SSDA_RUNS_DIR = tempRunsDir;
  lab = await startLab();
});

afterAll(async () => {
  await stopLab(lab);
  if (prevRunsDir === undefined) delete process.env.SSDA_RUNS_DIR;
  else process.env.SSDA_RUNS_DIR = prevRunsDir;
});

describe("readiness arm stamping", () => {
  it("a run with NO arm flag stamps readinessMode \"frozen\" — the resolved value, never silence", async () => {
    const { results, dir } = await runArm({});
    expect(results.environment.readinessMode).toBe("frozen");
    // …and it is in the WRITTEN artifact, not just the in-memory object.
    const raw: unknown = JSON.parse(await readFile(path.join(dir, "results.json"), "utf8"));
    const parsed = BenchmarkResultsSchema.parse(raw);
    expect(parsed.environment.readinessMode).toBe("frozen");
    // No campaign was configured, so the record names none.
    expect(Object.hasOwn(parsed.environment, "campaignProtocolId")).toBe(false);
  });

  it("--readiness-mode any-row stamps the relaxed arm, and both arms agree on a clean default-size page", async () => {
    const { results } = await runArm({ readinessMode: "any-row" });
    expect(results.environment.readinessMode).toBe("any-row");
    // The control property: on a page whose tables are full, relaxing the
    // readiness threshold changes nothing about what the engines achieve. Any
    // divergence HERE would mean the arm switch leaked into something other than
    // the readiness count.
    const frozen = (await runArm({})).results;
    const outcomeOf = (r: BenchmarkResults, engine: string) =>
      r.trials.find((t) => t.engine === engine)?.outcome;
    for (const engine of ["baseline", "hybrid"]) {
      expect(outcomeOf(results, engine)).toBe(outcomeOf(frozen, engine));
    }
  });

  it("campaignProtocolId is stamped VERBATIM when configured, and only then", async () => {
    const { results, dir } = await runArm({ campaignProtocolId: "phase2b-ablation-v1" });
    expect(results.environment.campaignProtocolId).toBe("phase2b-ablation-v1");
    const raw: unknown = JSON.parse(await readFile(path.join(dir, "results.json"), "utf8"));
    const parsed = BenchmarkResultsSchema.parse(raw);
    expect(parsed.environment.campaignProtocolId).toBe("phase2b-ablation-v1");
    // The suite's own lineage id is untouched — the two stamps are distinct.
    expect(parsed.environment.protocolId).not.toBe("phase2b-ablation-v1");
  });
});
