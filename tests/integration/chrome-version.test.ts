import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MissingChromeVersionError, runBenchmark } from "@ssda/agent";
import { createRunDir, type ScenarioSpec } from "@ssda/shared";
import { fileExists, startLab, stopLab, tmpDir, type Lab } from "./helpers";

/**
 * Browser-build acquisition end to end (gate-3 task 1), against real engines and
 * a real in-process lab. Keyless throughout — the baseline never uses a model
 * and the hybrid's repair path is key-gated — so this test spends nothing.
 *
 * Two properties are pinned:
 *  1. EVERY trial that launched a browser records its build, INCLUDING trials
 *     that fail. That was the gate-1 defect: the version was attached only to a
 *     completed attempt's outcome, so a trial whose attempts all threw recorded
 *     null even though the browser had been launched and read successfully.
 *  2. `requireChromeVersion` aborts BEFORE any evidence bundle is written, on a
 *     trial that genuinely has no build to record.
 */

/** A scenario every engine passes, and one no keyless engine can pass. */
const CLEAN: ScenarioSpec = {
  id: "cv-clean",
  name: "clean",
  description: "no perturbation",
  chaos: [],
  seed: 2201,
  session: "fresh",
  expected: "success",
  group: "core"
};
const DRIFT: ScenarioSpec = {
  id: "cv-class-drift",
  name: "class drift",
  description: "selectors drift; keyless engines cannot repair",
  chaos: ["classDrift"],
  seed: 2201,
  session: "fresh",
  expected: "success",
  group: "core"
};

let lab: Lab;
let tempRunsDir: string;
let prevRunsDir: string | undefined;

beforeAll(async () => {
  prevRunsDir = process.env.SSDA_RUNS_DIR;
  tempRunsDir = await tmpDir("ssda-runs-cv-");
  process.env.SSDA_RUNS_DIR = tempRunsDir;
  lab = await startLab();
});

afterAll(async () => {
  await stopLab(lab);
  if (prevRunsDir === undefined) delete process.env.SSDA_RUNS_DIR;
  else process.env.SSDA_RUNS_DIR = prevRunsDir;
});

describe("chromeVersion acquisition", () => {
  it("records a build on EVERY trial, including the ones that FAIL mid-attempt", async () => {
    const { dir, runId } = await createRunDir({ kind: "bench", labUrl: lab.url });
    const results = await runBenchmark({
      labUrl: lab.url,
      engines: ["baseline", "hybrid"],
      scenarios: [CLEAN, DRIFT],
      trialsPerScenario: 1,
      headless: true,
      benchDir: dir,
      benchId: runId
    });

    // The fixture only means anything if it actually produced failures: the
    // drift scenario must defeat both keyless engines mid-attempt.
    const failures = results.trials.filter((t) => t.outcome === "fail");
    expect(failures.length).toBeGreaterThan(0);

    for (const t of results.trials) {
      expect(
        t.chromeVersion,
        `${t.runId} (${t.engine}, outcome=${t.outcome}) recorded no browser build`
      ).not.toBeNull();
      expect(t.chromeVersion!.length).toBeGreaterThan(0);
    }
  });

  it("--require-chrome-version aborts before writing any results.json", async () => {
    // A genuine null with nothing mocked: the hybrid engine resolves its seed
    // cache BEFORE it launches a browser, so a missing cache file fails the
    // trial with no browser ever started — exactly the case where there is no
    // build to record, and exactly what strict mode must refuse to ship.
    const { dir, runId } = await createRunDir({ kind: "bench", labUrl: lab.url });
    await expect(
      runBenchmark({
        labUrl: lab.url,
        engines: ["hybrid"],
        scenarios: [CLEAN],
        trialsPerScenario: 1,
        headless: true,
        requireChromeVersion: true,
        // A seeded run must declare a non-cold purpose (the evidence-separation
        // rule); "persistence" is the honest label for a warm-start replay.
        runPurpose: "persistence",
        seedCacheFile: path.join(tempRunsDir, "no-such-healed-cache.json"),
        benchDir: dir,
        benchId: runId
      })
    ).rejects.toThrow(MissingChromeVersionError);

    // The evidence bundle was never produced.
    expect(await fileExists(path.join(dir, "results.json"))).toBe(false);
  });

  it("WITHOUT the flag the same run completes and records the null (record version 2 allows it)", async () => {
    const { dir, runId } = await createRunDir({ kind: "bench", labUrl: lab.url });
    const results = await runBenchmark({
      labUrl: lab.url,
      engines: ["hybrid"],
      scenarios: [CLEAN],
      trialsPerScenario: 1,
      headless: true,
      runPurpose: "persistence",
      seedCacheFile: path.join(tempRunsDir, "no-such-healed-cache.json"),
      benchDir: dir,
      benchId: runId
    });
    expect(results.trials).toHaveLength(1);
    expect(results.trials[0]!.chromeVersion).toBeNull();
    expect(await fileExists(path.join(dir, "results.json"))).toBe(true);
  });
});
