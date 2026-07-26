import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ChromeVersionUnavailableError,
  MissingChromeVersionError,
  acquireChromeVersionFromCdp,
  runBenchmark,
  runPipeline
} from "@ssda/agent";
import { createRunDir, createRunLogger, type ScenarioSpec, type TrialResult } from "@ssda/shared";
import { fileExists, startLab, stopLab, tmpDir, type Lab } from "./helpers";
import path from "node:path";

/**
 * ITEM 4 — strict browser provenance must not lose spend, and must abort before
 * semantic work. Two layers, neither of which weakens the non-null requirement:
 *
 *  4a. ACQUISITION-TIME abort: with `requireChromeVersion`, a build that cannot
 *      be read throws a distinguished error at init — before any navigation —
 *      so a strict run never spends a whole attempt on a trial whose provenance
 *      can never satisfy the protocol.
 *  4b. ACCOUNTING BEFORE THROWING: when a completed attempt yields a null build,
 *      the runner banks that trial's spend through `afterTrial` BEFORE aborting.
 *      Otherwise a trial that really did spend tokens vanishes from the ledger
 *      and the budget is enforced against an understated total.
 */

let lab: Lab;
let prevRunsDir: string | undefined;

// `restoreAllMocks` does NOT undo `stubGlobal`, and a stubbed `fetch` left in
// place breaks the lab's readiness poll in the runner-level suite below.
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const CLEAN: ScenarioSpec = {
  id: "cvs-clean",
  name: "clean",
  description: "no perturbation",
  chaos: [],
  seed: 2201,
  session: "fresh",
  expected: "success",
  group: "core"
};

describe("4a: acquisition-time abort", () => {
  it("throws the DISTINGUISHED error when a required build cannot be acquired", async () => {
    // The endpoint never answers; strict mode turns the null into an abort.
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    await expect(
      acquireChromeVersionFromCdp(() => "ws://127.0.0.1:9222/devtools/browser/x", {
        budgetMs: 60,
        retryMs: 20,
        required: true
      })
    ).rejects.toThrow(ChromeVersionUnavailableError);
  });

  it("the abort message says it stopped BEFORE any navigation or semantic step", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    await expect(
      acquireChromeVersionFromCdp(() => "ws://127.0.0.1:9222/devtools/browser/x", {
        budgetMs: 60,
        retryMs: 20,
        required: true
      })
    ).rejects.toThrow(/before any navigation or semantic step/);
  });

  it("NON-strict behaviour is unchanged: the same failure still yields null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    await expect(
      acquireChromeVersionFromCdp(() => "ws://127.0.0.1:9222/devtools/browser/x", {
        budgetMs: 60,
        retryMs: 20
      })
    ).resolves.toBeNull();
  });

  it("a successful read is unaffected by strictness", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ Browser: "Chrome/1.2.3" }) }) as unknown as Response)
    );
    await expect(
      acquireChromeVersionFromCdp(() => "ws://127.0.0.1:9222/devtools/browser/x", { required: true })
    ).resolves.toBe("Chrome/1.2.3");
  });
});

describe("4b: accounting before throwing", () => {
  beforeAllLab();

  it("banks the trial through afterTrial BEFORE MissingChromeVersionError propagates", async () => {
    // A hybrid trial whose seed cache is missing dies before a browser launches,
    // so it records chromeVersion null with a completed trial record — exactly
    // the case where spend could already have happened.
    const { dir, runId } = await createRunDir({ kind: "bench", labUrl: lab.url });
    const order: string[] = [];
    const seen: TrialResult[] = [];

    await expect(
      runBenchmark({
        labUrl: lab.url,
        engines: ["hybrid"],
        scenarios: [CLEAN],
        trialsPerScenario: 1,
        headless: true,
        requireChromeVersion: true,
        runPurpose: "persistence",
        seedCacheFile: path.join(dir, "no-such-healed-cache.json"),
        benchDir: dir,
        benchId: runId,
        hooks: {
          afterTrial: async (record) => {
            order.push("afterTrial");
            seen.push(record);
          }
        }
      })
    ).rejects.toThrow(MissingChromeVersionError);
    order.push("threw");

    // CALL ORDER is the point: the ledger sees the trial first, the abort second.
    expect(order).toEqual(["afterTrial", "threw"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.chromeVersion).toBeNull();
    // …and no evidence bundle is produced on this path.
    expect(await fileExists(path.join(dir, "results.json"))).toBe(false);
  });

  it("without the flag the same trial is recorded normally and the bundle is written", async () => {
    const { dir, runId } = await createRunDir({ kind: "bench", labUrl: lab.url });
    const results = await runBenchmark({
      labUrl: lab.url,
      engines: ["hybrid"],
      scenarios: [CLEAN],
      trialsPerScenario: 1,
      headless: true,
      runPurpose: "persistence",
      seedCacheFile: path.join(dir, "no-such-healed-cache.json"),
      benchDir: dir,
      benchId: runId
    });
    expect(results.trials).toHaveLength(1);
    expect(results.trials[0]!.chromeVersion).toBeNull();
    expect(await fileExists(path.join(dir, "results.json"))).toBe(true);
  });
});

describe("4a abort ORDER through the pipeline", () => {
  /**
   * WHY THIS IS TESTED AT THE PIPELINE LAYER, NOT END-TO-END THROUGH AN ENGINE.
   * The honest simulation would be "the browser started but its /json/version
   * never answered" — but Stagehand ITSELF resolves its CDP websocket through
   * /json/version during init, so stubbing that endpoint prevents the browser
   * from connecting at all and the trial fails for the wrong reason. That state
   * is not reachable in this harness (confirmed empirically: the attempt failed
   * at init and never reached acquisition). What IS testable, and is what the
   * ordering guarantee actually rests on, is that the abort propagates out of
   * the attempt loop UNRETRIED — proven here — plus the acquisition-level
   * `required` behaviour proven above and the call-site threading in both
   * engines.
   */
  it("the abort is NOT retried and NOT converted into a failed result — it propagates", async () => {
    const attempts: number[] = [];
    await expect(
      runPipeline(
        "hybrid",
        {
          labUrl: "http://127.0.0.1:0",
          pages: ["stats", "odds"],
          credentials: { username: "u", password: "p" },
          session: { mode: "fresh" },
          runId: "abort-order",
          runDir: await tmpDir("ssda-abort-"),
          logger: createRunLogger({ runId: "abort-order", file: path.join(await tmpDir("ssda-abort-log-"), "e.jsonl"), console: false }),
          headless: true,
          // TWO attempts available — the point is that the abort consumes neither
          // a retry nor produces a result.
          maxAttempts: 2,
          navTimeoutMs: 1_000,
          stepTimeoutMs: 1_000,
          env: "local",
          requireChromeVersion: true
        },
        async (attempt) => {
          attempts.push(attempt);
          // Exactly what the engines now throw at their acquisition call site,
          // immediately after init and before load-session / goto-stats.
          throw new ChromeVersionUnavailableError("CDP /json/version did not answer");
        }
      )
    ).rejects.toThrow(ChromeVersionUnavailableError);
    // ONE attempt only: no retry, and no failed PipelineResult was manufactured.
    expect(attempts).toEqual([1]);
  });

  it("an ORDINARY attempt failure still retries and still returns a failed result", async () => {
    // The contrast that proves the rethrow is narrow: nothing else changed.
    const attempts: number[] = [];
    const result = await runPipeline(
      "hybrid",
      {
        labUrl: "http://127.0.0.1:0",
        pages: ["stats", "odds"],
        credentials: { username: "u", password: "p" },
        session: { mode: "fresh" },
        runId: "ordinary",
        runDir: await tmpDir("ssda-ordinary-"),
        logger: createRunLogger({ runId: "ordinary", file: path.join(await tmpDir("ssda-ordinary-log-"), "e.jsonl"), console: false }),
        headless: true,
        maxAttempts: 2,
        navTimeoutMs: 1_000,
        stepTimeoutMs: 1_000,
        env: "local"
      },
      async (attempt) => {
        attempts.push(attempt);
        throw new Error("standings table not found");
      }
    );
    expect(attempts).toEqual([1, 2]);
    expect(result.success).toBe(false);
  });
});

/** Shared lab lifecycle for the runner-level cases. */
function beforeAllLab(): void {
  beforeAll(async () => {
    prevRunsDir = process.env.SSDA_RUNS_DIR;
    process.env.SSDA_RUNS_DIR = await tmpDir("ssda-runs-cvs-");
    lab = await startLab();
  });
  afterAll(async () => {
    await stopLab(lab);
    if (prevRunsDir === undefined) delete process.env.SSDA_RUNS_DIR;
    else process.env.SSDA_RUNS_DIR = prevRunsDir;
  });
}
