import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDashboardData } from "./data";

/**
 * Every read in data.ts is defensive (readJsonOr + safeParse), so these tests
 * drive it against a throwaway runs/ directory: valid, malformed and missing
 * artifacts all have to leave the dashboard renderable.
 */

/** A schema-valid BenchmarkResults document with no scenarios or trials. */
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

function scenario(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    description: id,
    chaos: [],
    seed: 1101,
    session: "fresh",
    expected: "success"
  };
}

function trial(
  scenarioId: string,
  outcome: "pass" | "fail",
  artifactsDir: string
): Record<string, unknown> {
  return {
    scenarioId,
    engine: "hybrid",
    trial: 1,
    runId: "bench-x",
    outcome,
    outcomeReason: outcome === "fail" ? "row coverage 0" : "ok",
    outcomeClass: outcome === "fail" ? "hard-failure" : "pass",
    pipelineSuccess: outcome === "pass",
    extractionSuccess: outcome === "pass",
    validationSuccess: outcome === "pass",
    accuracy: null,
    durationMs: 1200,
    retries: 0,
    recoveredAfterFailure: false,
    artifactsDir
  };
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data), "utf8");
}

describe("loadDashboardData", () => {
  let runsDir: string;
  let prevRunsDir: string | undefined;

  beforeEach(async () => {
    prevRunsDir = process.env.SSDA_RUNS_DIR;
    runsDir = await mkdtemp(path.join(tmpdir(), "ssda-dashboard-"));
    process.env.SSDA_RUNS_DIR = runsDir;
  });

  afterEach(async () => {
    if (prevRunsDir === undefined) delete process.env.SSDA_RUNS_DIR;
    else process.env.SSDA_RUNS_DIR = prevRunsDir;
    await rm(runsDir, { recursive: true, force: true });
  });

  it("returns typed nulls (not an error) for an empty runs directory", async () => {
    const data = await loadDashboardData();
    expect(data.bench).toBeNull();
    expect(data.agent).toBeNull();
    expect(Number.isNaN(Date.parse(data.generatedAt))).toBe(false);
  });

  it("collapses a malformed or partial results.json to a null bench", async () => {
    const file = path.join(runsDir, "latest", "results.json");
    await writeJson(file, { benchId: "missing-everything-else" });
    expect((await loadDashboardData()).bench).toBeNull();

    await writeFile(file, "{ not json at all", "utf8");
    expect((await loadDashboardData()).bench).toBeNull();
  });

  it("keeps only failed trials, in scenario order, with served artifact paths", async () => {
    await writeJson(path.join(runsDir, "latest", "results.json"), {
      ...baseResults(),
      scenarios: [scenario("s-a"), scenario("s-b")],
      trials: [
        trial("s-b", "fail", "/elsewhere/runs/bench-x/trials/t-b"),
        trial("s-a", "pass", "/elsewhere/runs/bench-x/trials/t-ok"),
        trial("s-a", "fail", "/elsewhere/runs/bench-x/trials/t-a")
      ]
    });
    // artifactsDir records the original absolute path; on disk the trial lives
    // under latest/trials/<basename>, which is what the dashboard must read.
    const artifactsDir = path.join(runsDir, "latest", "trials", "t-a", "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(path.join(artifactsDir, "stats-1.png"), "fake-png", "utf8");

    const bench = (await loadDashboardData()).bench;
    expect(bench?.isFixture).toBe(false);
    expect(bench?.failures.map((f) => f.trial.scenarioId)).toEqual(["s-a", "s-b"]);
    expect(bench?.failures[0]?.scenario?.id).toBe("s-a");
    expect(bench?.failures[0]?.eventsUrl).toBe("/runs/latest/trials/t-a/events.jsonl");
    expect(bench?.failures[0]?.screenshots).toEqual([
      {
        name: "stats-1.png",
        absPath: path.join(artifactsDir, "stats-1.png"),
        url: "/runs/latest/trials/t-a/artifacts/stats-1.png",
        label: "stats",
        sizeBytes: 8
      }
    ]);
    // The failing trial with no artifacts on disk still renders, just empty.
    expect(bench?.failures[1]?.screenshots).toEqual([]);
  });

  it("carries the per-engine summary computed from the parsed trials", async () => {
    await writeJson(path.join(runsDir, "latest", "results.json"), {
      ...baseResults(),
      scenarios: [scenario("s-a")],
      trials: [
        {
          ...trial("s-a", "pass", "/elsewhere/runs/bench-x/trials/t-ok"),
          tokens: { llmCalls: 3 },
          healedSteps: ["login"]
        },
        {
          ...trial("s-a", "fail", "/elsewhere/runs/bench-x/trials/t-bad"),
          retries: 2
        }
      ]
    });

    expect((await loadDashboardData()).bench?.summary).toEqual([
      {
        engine: "hybrid",
        trials: 2,
        passes: 1,
        semanticInterventions: 1,
        deterministicRepairs: 0,
        llmCalls: 3,
        retries: 2
      }
    ]);
  });

  it("reads SSDA_DASHBOARD_FIXTURE instead of runs/latest and flags it as a fixture", async () => {
    const fixtureDir = await mkdtemp(path.join(tmpdir(), "ssda-fixture-"));
    try {
      await writeJson(path.join(fixtureDir, "sample-results.json"), {
        ...baseResults(),
        benchId: "from-fixture"
      });
      await writeJson(path.join(runsDir, "latest", "results.json"), {
        ...baseResults(),
        benchId: "from-latest"
      });

      const bench = (
        await loadDashboardData({ ...process.env, SSDA_DASHBOARD_FIXTURE: fixtureDir })
      ).bench;
      expect(bench?.isFixture).toBe(true);
      expect(bench?.results.benchId).toBe("from-fixture");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("loads the agent run, dropping event lines and a watchlist that fail their schema", async () => {
    const runId = "agent-2026-07-20";
    const runDir = path.join(runsDir, runId);
    await writeJson(path.join(runDir, "manifest.json"), {
      runId,
      kind: "agent",
      createdAt: "2026-07-20T00:00:00.000Z"
    });
    await writeFile(
      path.join(runDir, "events.jsonl"),
      [
        JSON.stringify({ ts: "2026-07-20T00:00:00.000Z", runId, level: "info", event: "run.start" }),
        JSON.stringify({ ts: "2026-07-20T00:00:01.000Z", runId, level: "shout", event: "bad.level" }),
        JSON.stringify({ ts: "2026-07-20T00:00:02.000Z", runId, level: "info", event: "run.finish" })
      ].join("\n") + "\n",
      "utf8"
    );
    await writeJson(path.join(runDir, "watchlist.json"), { generatedAt: "2026-07-20T00:00:00.000Z" });
    await mkdir(path.join(runDir, "artifacts"), { recursive: true });
    for (const name of ["stats-a1.png", "odds-b2.png", "failure-x.png", "notes.txt"]) {
      await writeFile(path.join(runDir, "artifacts", name), "fake-png", "utf8");
    }

    const agent = (await loadDashboardData()).agent;
    expect(agent?.manifest.runId).toBe(runId);
    expect(agent?.result).toBeNull();
    expect(agent?.watchlist).toBeNull();
    expect(agent?.events.map((e) => e.event)).toEqual(["run.start", "run.finish"]);
    expect(agent?.screenshots.map((s) => [s.name, s.label])).toEqual([
      ["failure-x.png", "failure"],
      ["odds-b2.png", "odds"],
      ["stats-a1.png", "stats"]
    ]);
    expect(agent?.screenshots[0]?.url).toBe(`/runs/${runId}/artifacts/failure-x.png`);
  });
});
