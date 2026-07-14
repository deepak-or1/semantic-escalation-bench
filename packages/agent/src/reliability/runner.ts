import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BenchmarkResultsSchema,
  LabClient,
  createRunLogger,
  labCredentials,
  mirrorToLatest,
  readJsonOr,
  writeJson,
  type BenchmarkResults,
  type EngineName,
  type PipelineResult,
  type ScenarioSpec,
  type TrialResult
} from "@ssda/shared";
import {
  DEFAULT_PIPELINE_TIMEOUTS,
  loadAgentEnvConfig,
  overallAccuracy,
  scoreOdds,
  scoreStats,
  type Engine
} from "../core";
import { baselineEngine } from "../baseline";
import { stagehandEngine } from "../stagehand";
import { hybridEngine } from "../hybrid";
import { buildComparison, classifyOutcome, summarizeEngine } from "./metrics";
import { renderResultsMarkdown } from "./markdown";
import { prepSessionState } from "./prepSession";

export interface BenchmarkRunConfig {
  labUrl: string;
  /** Requested engines; stagehand is auto-skipped when no model key is set. */
  engines: EngineName[];
  scenarios: ScenarioSpec[];
  /** Trials per scenario per engine (default 1). */
  trialsPerScenario: number;
  headless: boolean;
  /** Caller-created run directory (createRunDir({ kind: "bench" })). */
  benchDir: string;
  benchId: string;
  /**
   * Freeze the hybrid engine's deterministic tier (--no-repair): it never
   * invokes the LLM repair path even with a key present. Baseline/stagehand
   * ignore it.
   */
  disableRepair?: boolean;
  onProgress?: (line: string) => void;
}

// Unlike stagehand, hybrid is never auto-skipped: it is designed to run keyless
// (a model key only unlocks its repair path).
const ENGINE_IMPLS: Record<EngineName, Engine> = {
  stagehand: stagehandEngine,
  baseline: baselineEngine,
  hybrid: hybridEngine
};

const NO_KEY_REASON =
  "no model provider key — set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env";

const STAGEHAND_PKG_JSON =
  "packages/agent/node_modules/@browserbasehq/stagehand/package.json";

export async function runBenchmark(
  config: BenchmarkRunConfig
): Promise<BenchmarkResults> {
  const lab = new LabClient(config.labUrl);
  const envConfig = loadAgentEnvConfig();

  // Stagehand needs an LLM key; without one it is reported as skipped, never
  // run, and never given fabricated trial data.
  const skipStagehand =
    config.engines.includes("stagehand") && envConfig.modelProvider === null;
  const skippedEngines: EngineName[] = skipStagehand ? ["stagehand"] : [];
  const runnableEngines = config.engines.filter(
    (e) => !(e === "stagehand" && skipStagehand)
  );

  const trials: TrialResult[] = [];
  const total =
    config.scenarios.length * runnableEngines.length * config.trialsPerScenario;
  let k = 0;

  for (const scenario of config.scenarios) {
    for (const engine of runnableEngines) {
      const impl = ENGINE_IMPLS[engine];
      for (let trial = 1; trial <= config.trialsPerScenario; trial++) {
        // (1) Reconfigure the lab per trial — this also resets sessions, which
        // session prep below relies on.
        await lab.configure({ seed: scenario.seed, chaos: scenario.chaos });
        // (2) Ground truth for accuracy scoring.
        const { truth, overrides } = await lab.groundTruth();

        const runId = `${scenario.id}-${engine}-t${trial}`;
        const runDir = path.join(config.benchDir, "trials", runId);

        // (3) Session prep.
        let stateFile: string | undefined;
        if (scenario.session !== "fresh") {
          stateFile = path.join(runDir, "session.json");
          await prepSessionState(config.labUrl, labCredentials(), stateFile);
          if (scenario.session === "expired") {
            await lab.expireAllSessions();
          }
        }

        // (4) Per-trial artifacts directory + logger.
        const logger = createRunLogger({
          runId,
          file: path.join(runDir, "events.jsonl"),
          engine,
          scenarioId: scenario.id,
          console: false
        });

        k += 1;
        const started = Date.now();
        let record: TrialResult;
        try {
          // (5) Run the engine.
          const result = await impl.run({
            labUrl: config.labUrl,
            pages: ["stats", "odds"],
            credentials: labCredentials(),
            session: {
              mode: scenario.session,
              ...(stateFile ? { stateFile } : {})
            },
            runId,
            runDir,
            logger,
            scenarioId: scenario.id,
            seed: scenario.seed,
            headless: config.headless,
            maxAttempts: 2,
            navTimeoutMs: DEFAULT_PIPELINE_TIMEOUTS.navTimeoutMs,
            stepTimeoutMs: DEFAULT_PIPELINE_TIMEOUTS.stepTimeoutMs,
            env: "local",
            ...(config.disableRepair ? { disableRepair: true } : {})
          });
          record = buildTrialResult(scenario, engine, trial, runId, runDir, result, {
            truth,
            overrides
          });
        } catch (error) {
          // A thrown engine (not a pre-checked setup error) is an internal
          // failure — record it, never fabricate a clean result.
          const message = error instanceof Error ? error.message : String(error);
          record = {
            scenarioId: scenario.id,
            engine,
            trial,
            runId,
            outcome: "fail",
            outcomeReason: `engine threw before producing a result: ${message}`,
            // A thrown engine is visible breakage (category "internal").
            outcomeClass: "hard-failure",
            pipelineSuccess: false,
            extractionSuccess: false,
            validationSuccess: false,
            accuracy: null,
            durationMs: Date.now() - started,
            retries: 0,
            recoveredAfterFailure: false,
            failureCategory: "internal",
            failureDetail: message,
            artifactsDir: path.relative(process.cwd(), runDir),
            tokens: null
          };
        }

        trials.push(record);
        config.onProgress?.(
          `[${k}/${total}] ${scenario.id} ${engine} -> ${
            record.outcome === "pass" ? "PASS" : "FAIL"
          } (${record.outcomeReason})`
        );
      }
    }
  }

  // Engine summaries: one per requested engine (skipped stagehand included).
  const engines = config.engines.map((engine) => {
    if (engine === "stagehand" && skipStagehand) {
      return summarizeEngine("stagehand", [], NO_KEY_REASON);
    }
    return summarizeEngine(
      engine,
      trials.filter((t) => t.engine === engine)
    );
  });

  const comparison = buildComparison(
    config.scenarios,
    trials,
    config.engines,
    skippedEngines
  );

  const stagehandPkg = await readJsonOr<{ version?: string }>(
    path.resolve(process.cwd(), STAGEHAND_PKG_JSON),
    {}
  );

  const results = BenchmarkResultsSchema.parse({
    benchId: config.benchId,
    createdAt: new Date().toISOString(),
    labUrl: config.labUrl,
    trialsPerScenario: config.trialsPerScenario,
    scenarios: config.scenarios,
    trials,
    engines,
    comparison,
    environment: {
      node: process.version,
      ...(stagehandPkg.version ? { stagehandVersion: stagehandPkg.version } : {}),
      ...(envConfig.stagehandModel
        ? { stagehandModel: envConfig.stagehandModel }
        : {}),
      modelProvider: envConfig.modelProvider ?? null,
      browserbase: envConfig.browserbase.ready
    }
  });

  // Persist: results.json, results.md, failures.jsonl, then mirror to latest.
  await writeJson(path.join(config.benchDir, "results.json"), results);
  await writeFile(
    path.join(config.benchDir, "results.md"),
    renderResultsMarkdown(results),
    "utf8"
  );

  const failureLines = results.trials
    .filter((t) => t.outcome === "fail")
    .map((t) =>
      JSON.stringify({
        scenarioId: t.scenarioId,
        engine: t.engine,
        trial: t.trial,
        failureCategory: t.failureCategory,
        failureDetail: t.failureDetail,
        outcomeReason: t.outcomeReason,
        artifactsDir: t.artifactsDir
      })
    );
  await writeFile(
    path.join(config.benchDir, "failures.jsonl"),
    failureLines.length > 0 ? failureLines.join("\n") + "\n" : "",
    "utf8"
  );

  await mirrorToLatest(config.benchDir);

  return results;
}

interface GroundTruth {
  truth: Awaited<ReturnType<LabClient["groundTruth"]>>["truth"];
  overrides: Awaited<ReturnType<LabClient["groundTruth"]>>["overrides"];
}

function buildTrialResult(
  scenario: ScenarioSpec,
  engine: EngineName,
  trial: number,
  runId: string,
  runDir: string,
  result: PipelineResult,
  gt: GroundTruth
): TrialResult {
  let accuracy: TrialResult["accuracy"] = null;
  let overall: number | undefined;
  if (result.normalized) {
    const stats = scoreStats(result.normalized.teams, gt.truth, gt.overrides);
    const odds = scoreOdds(result.normalized.markets, gt.truth, gt.overrides);
    overall = overallAccuracy(stats, odds);
    accuracy = { stats, odds, ...(overall !== undefined ? { overall } : {}) };
  }

  const { outcome, reason } = judge(scenario, result, overall);
  // Behaviour class is orthogonal to the judged outcome (e.g. a schema-violation
  // refusal is judged PASS but classed safe-failure).
  const outcomeClass = classifyOutcome({
    pipelineSuccess: result.success,
    overall,
    attempts: result.attempts,
    ...(result.healedSteps ? { healedSteps: result.healedSteps } : {}),
    ...(result.failureCategory ? { failureCategory: result.failureCategory } : {})
  });

  return {
    scenarioId: scenario.id,
    engine,
    trial,
    runId,
    outcome,
    outcomeReason: reason,
    outcomeClass,
    pipelineSuccess: result.success,
    extractionSuccess: result.validation.extractOk,
    validationSuccess: result.validation.domainOk,
    accuracy,
    durationMs: result.durationMs,
    retries: result.retries,
    recoveredAfterFailure: result.recoveredAfterFailure,
    ...(result.failureCategory ? { failureCategory: result.failureCategory } : {}),
    ...(result.failureDetail ? { failureDetail: result.failureDetail } : {}),
    artifactsDir: path.relative(process.cwd(), runDir),
    tokens: result.tokens ?? null,
    ...(result.healedSteps && result.healedSteps.length > 0
      ? { healedSteps: result.healedSteps }
      : {})
  };
}

/**
 * Judge a pipeline result against the scenario's expected outcome. Every
 * outcomeReason names the specific rule that decided the verdict.
 *
 * For the `success` and `success-with-warnings` branches the accuracy bar is
 * PERFECT extraction: overall must be present and == 1 (within 1e-9). With
 * override-aware scoring and the odds tolerance, 1.0 means every graded cell is
 * correct within tolerance, so a successful pipeline that scores below 1 — or
 * that produced no accuracy sample at all — is a FAIL (it cannot be shown to
 * have extracted the right data). The `validation-failure` branch is unchanged.
 */
export function judge(
  scenario: ScenarioSpec,
  result: PipelineResult,
  overall: number | undefined
): { outcome: "pass" | "fail"; reason: string } {
  const accuracyPresent = overall !== undefined;
  const accuracyPerfect = overall !== undefined && overall >= 1 - 1e-9;
  const accuracyNote =
    overall === undefined ? "no accuracy sample" : `accuracy ${overall.toFixed(2)}`;
  const failedNote = `pipeline failed [${result.failureCategory ?? "unknown"}] ${
    result.failureDetail ?? ""
  }`.trim();

  switch (scenario.expected) {
    case "success": {
      const loggedIn = result.steps.some((s) => s.name === "login");
      const noLoginOk = scenario.session === "reuse" ? !loggedIn : true;
      if (!result.success) {
        return { outcome: "fail", reason: `expected success but ${failedNote}` };
      }
      if (!noLoginOk) {
        return {
          outcome: "fail",
          reason: "expected success via reused session but a login step ran"
        };
      }
      if (!accuracyPresent) {
        return {
          outcome: "fail",
          reason: "expected success but no accuracy sample — cannot verify extraction"
        };
      }
      if (!accuracyPerfect) {
        return {
          outcome: "fail",
          reason: `expected success but accuracy 1.00 required, got ${overall!.toFixed(2)}`
        };
      }
      return { outcome: "pass", reason: `success: pipeline succeeded (${accuracyNote})` };
    }
    case "success-with-warnings": {
      const warnings = result.normalized?.warnings.length ?? 0;
      if (!result.success) {
        return { outcome: "fail", reason: `expected success-with-warnings but ${failedNote}` };
      }
      if (warnings === 0) {
        return {
          outcome: "fail",
          reason: "expected success-with-warnings but no warnings were emitted"
        };
      }
      if (!accuracyPresent) {
        return {
          outcome: "fail",
          reason:
            "expected success-with-warnings but no accuracy sample — cannot verify extraction"
        };
      }
      if (!accuracyPerfect) {
        return {
          outcome: "fail",
          reason: `expected success-with-warnings but accuracy 1.00 required, got ${overall!.toFixed(2)}`
        };
      }
      return {
        outcome: "pass",
        reason: `success-with-warnings: succeeded with ${warnings} warning(s) (${accuracyNote})`
      };
    }
    case "validation-failure": {
      if (result.success) {
        return {
          outcome: "fail",
          reason: "expected a validation failure but the pipeline succeeded"
        };
      }
      if (result.failureCategory !== "validation") {
        return {
          outcome: "fail",
          reason: `expected a validation failure but failure category was ${
            result.failureCategory ?? "unknown"
          }`
        };
      }
      return {
        outcome: "pass",
        reason: "validation-failure: clean categorised validation failure as expected"
      };
    }
  }
}
