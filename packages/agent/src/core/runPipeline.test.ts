import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRunLogger,
  generateGroundTruth,
  RunEventSchema,
  type ExtractedOddsRow,
  type ExtractedStatsRow,
  type FixtureMarket,
  type StepResult,
  type TeamSeasonStats
} from "@ssda/shared";
import { afterEach, describe, expect, it } from "vitest";
import { runPipeline, type AttemptFn } from "./runPipeline";
import { AttemptFailure, DEFAULT_PIPELINE_TIMEOUTS, type AttemptOutcome, type PipelineOptions } from "./types";

const truth = generateGroundTruth(1101);
const cleanup: string[] = [];

afterEach(() => {
  cleanup.length = 0;
});

function statsRowFromTruth(t: TeamSeasonStats): ExtractedStatsRow {
  return {
    team: t.name,
    played: t.played,
    wins: t.wins,
    draws: t.draws,
    losses: t.losses,
    goalsFor: t.goalsFor,
    goalsAgainst: t.goalsAgainst,
    points: t.points,
    form: t.form
  };
}

function oddsRowFromTruth(m: FixtureMarket): ExtractedOddsRow {
  return {
    homeTeam: m.homeTeam,
    awayTeam: m.awayTeam,
    kickoff: m.kickoff,
    homeOdds: m.oneXTwo.home.toFixed(2),
    drawOdds: m.oneXTwo.draw.toFixed(2),
    awayOdds: m.oneXTwo.away.toFixed(2),
    totalsLine: String(m.totals.line),
    overOdds: m.totals.over.toFixed(2),
    underOdds: m.totals.under.toFixed(2)
  };
}

const statsRawFromTruth = (): unknown => ({ rows: truth.teams.map(statsRowFromTruth) });
const oddsRawFromTruth = (): unknown => ({ rows: truth.markets.map(oddsRowFromTruth) });

function step(name: string): StepResult {
  return { name, status: "passed", attempts: 1, durationMs: 1 };
}

const okSteps: StepResult[] = [step("goto-stats"), step("extract-stats"), step("extract-odds")];

function outcome(over: Partial<AttemptOutcome> = {}): AttemptOutcome {
  return {
    steps: okSteps,
    statsRaw: statsRawFromTruth(),
    oddsRaw: oddsRawFromTruth(),
    screenshots: ["artifacts/stats-a1.png"],
    tokens: null,
    ...over
  };
}

async function makeOptions(over: Partial<PipelineOptions> = {}): Promise<PipelineOptions> {
  const runDir = await mkdtemp(path.join(tmpdir(), "ssda-run-"));
  cleanup.push(runDir);
  const logger = createRunLogger({ runId: "run-test", file: path.join(runDir, "events.jsonl") });
  return {
    labUrl: "http://localhost:4517",
    pages: ["stats", "odds"],
    credentials: { username: "analyst", password: "scout-the-lab" },
    session: { mode: "fresh" },
    runId: "run-test",
    runDir,
    logger,
    headless: true,
    maxAttempts: 2,
    navTimeoutMs: DEFAULT_PIPELINE_TIMEOUTS.navTimeoutMs,
    stepTimeoutMs: DEFAULT_PIPELINE_TIMEOUTS.stepTimeoutMs,
    env: "local",
    seed: 1101,
    ...over
  };
}

async function assertEventsParse(file: string): Promise<number> {
  const text = await readFile(file, "utf8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    const parsed = RunEventSchema.safeParse(JSON.parse(line));
    expect(parsed.success).toBe(true);
  }
  return lines.length;
}

describe("runPipeline", () => {
  it("(a) success path: writes artifacts and reports domainOk", async () => {
    const options = await makeOptions();
    const result = await runPipeline("baseline", options, async () => outcome());

    expect(result.success).toBe(true);
    expect(result.validation.extractOk).toBe(true);
    expect(result.validation.domainOk).toBe(true);
    expect(result.retries).toBe(0);
    expect(result.attempts).toBe(1);

    const normalized = JSON.parse(await readFile(path.join(options.runDir, "normalized.json"), "utf8"));
    expect(normalized.teams).toHaveLength(12);
    expect(normalized.markets).toHaveLength(6);
    await readFile(path.join(options.runDir, "raw", "stats-attempt-1.json"), "utf8");
    await readFile(path.join(options.runDir, "raw", "odds-attempt-1.json"), "utf8");

    await options.logger.flush();
    await assertEventsParse(options.logger.file);
  });

  it("(b) recovers after one AttemptFailure", async () => {
    const options = await makeOptions();
    let calls = 0;
    const attemptFn: AttemptFn = async () => {
      calls += 1;
      if (calls === 1) {
        throw new AttemptFailure("transient", "navigation", "goto-stats", [step("goto-stats")]);
      }
      return outcome();
    };
    const result = await runPipeline("baseline", options, attemptFn);

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.retries).toBe(1);
    expect(result.recoveredAfterFailure).toBe(true);
  });

  it("(c) exhausts retries on a persistent auth failure", async () => {
    const options = await makeOptions({ maxAttempts: 2 });
    const attemptFn: AttemptFn = async () => {
      throw new AttemptFailure("login bounced", "auth", "login", [step("login")]);
    };
    const result = await runPipeline("baseline", options, attemptFn);

    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("auth");
    expect(result.attempts).toBe(2);
    expect(result.retries).toBe(1);
    expect(result.recoveredAfterFailure).toBe(false);
  });

  it("(d) played -3 fails domain validation while extraction schema passes", async () => {
    const options = await makeOptions({ pages: ["stats"] });
    const rows = truth.teams.map(statsRowFromTruth);
    rows[0]!.played = -3;
    const result = await runPipeline("baseline", options, async () =>
      outcome({ statsRaw: { rows }, oddsRaw: undefined })
    );

    expect(result.success).toBe(false);
    expect(result.validation.extractOk).toBe(true);
    expect(result.validation.domainOk).toBe(false);
    expect(result.failureCategory).toBe("validation");
  });

  it("(e) a schema-invalid stats shape fails extraction", async () => {
    const options = await makeOptions({ pages: ["stats"] });
    const result = await runPipeline("baseline", options, async () =>
      outcome({ statsRaw: { rows: [{ team: 123 }] }, oddsRaw: undefined })
    );

    expect(result.validation.extractOk).toBe(false);
    expect(result.failureCategory).toBe("extraction");
    expect(result.success).toBe(false);
  });

  it("(f) categorises a plain connection error as navigation", async () => {
    const options = await makeOptions({ maxAttempts: 1 });
    const attemptFn: AttemptFn = async () => {
      throw new Error("net::ERR_CONNECTION_REFUSED at http://localhost:4517/stats");
    };
    const result = await runPipeline("baseline", options, attemptFn);

    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("navigation");
    expect(result.attempts).toBe(1);

    await options.logger.flush();
    await assertEventsParse(options.logger.file);
  });

  // ── G2: heals / deterministic-fallback firings are recorded across ALL
  // attempts, not just the successful/final one. The engine's lists are
  // trial-scoped, so attempt 1's firing survives into attempt 2's outcome.
  it("(g2-accumulate-on-recovery) a recovered trial carries lists accumulated across all attempts", async () => {
    const options = await makeOptions();
    let calls = 0;
    const attemptFn: AttemptFn = async () => {
      calls += 1;
      if (calls === 1) {
        // Attempt 1 fires the consent guard and heals login, then fails.
        throw new AttemptFailure(
          "consent stuck",
          "blocked_ui",
          "consent",
          [step("consent")],
          [],
          null,
          ["login"], // trial-scoped healedSteps snapshot
          ["consent"] // trial-scoped deterministicFallbacks snapshot
        );
      }
      // Attempt 2 succeeds; its outcome is TRIAL-scoped, so it still carries
      // attempt 1's consent firing + login heal, plus a new dismiss-modal firing.
      return outcome({
        healedSteps: ["login"],
        deterministicFallbacks: ["consent", "dismiss-modal"]
      });
    };
    const result = await runPipeline("hybrid", options, attemptFn);

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.deterministicFallbacks).toEqual(["consent", "dismiss-modal"]);
    expect(result.healedSteps).toEqual(["login"]);
  });

  it("(g2-accumulate-on-total-failure) a wholly-failed trial still carries the last failure's accumulated lists", async () => {
    const options = await makeOptions({ maxAttempts: 2 });
    let calls = 0;
    const attemptFn: AttemptFn = async () => {
      calls += 1;
      if (calls === 1) {
        throw new AttemptFailure(
          "attempt 1 down",
          "blocked_ui",
          "consent",
          [step("consent")],
          [],
          null,
          ["login"],
          ["consent"]
        );
      }
      // Attempt 2 also fails; the trial-scoped lists have accumulated further.
      throw new AttemptFailure(
        "attempt 2 down",
        "not_found",
        "reveal-table",
        [step("reveal-table")],
        [],
        null,
        ["login", "reveal-table"],
        ["consent", "dismiss-modal"]
      );
    };
    const result = await runPipeline("hybrid", options, attemptFn);

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.deterministicFallbacks).toEqual(["consent", "dismiss-modal"]);
    expect(result.healedSteps).toEqual(["login", "reveal-table"]);
  });
});
