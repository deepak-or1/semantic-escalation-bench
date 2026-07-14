import { describe, expect, it } from "vitest";
import { assessDataset } from "./quality";
import {
  NormalizedTeamStatsSchema,
  type NormalizedDataset,
  type NormalizedMarket,
  type NormalizedTeamStats
} from "./schemas/domain";
import { TrialResultSchema } from "./schemas/benchmark";
import { PipelineResultSchema } from "./schemas/run";
import { generateGroundTruth } from "./seed/generate";

function consistentTeams(): NormalizedTeamStats[] {
  return generateGroundTruth(1101).teams.map((t) => ({
    name: t.name,
    played: t.played,
    goalsFor: t.goalsFor,
    goalsAgainst: t.goalsAgainst,
    wins: t.wins,
    draws: t.draws,
    losses: t.losses,
    points: t.points,
    form: t.form,
    missingFields: []
  }));
}

function dataset(
  teams: NormalizedTeamStats[],
  markets: NormalizedMarket[] = []
): NormalizedDataset {
  return {
    teams,
    markets,
    warnings: [],
    failures: [],
    meta: {
      engine: "baseline",
      source: "test",
      extractedAt: "2026-07-08T00:00:00.000Z"
    }
  };
}

describe("NormalizedTeamStatsSchema", () => {
  const valid = {
    name: "Ashford Rovers",
    played: 22,
    goalsFor: 30,
    goalsAgainst: 20,
    missingFields: []
  };

  it("rejects a negative played count", () => {
    expect(NormalizedTeamStatsSchema.safeParse({ ...valid, played: -3 }).success).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(NormalizedTeamStatsSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
  });

  it("accepts a nullable goalsFor", () => {
    expect(NormalizedTeamStatsSchema.safeParse({ ...valid, goalsFor: null }).success).toBe(true);
  });
});

describe("assessDataset", () => {
  it("passes a consistent 12-team dataset with empty markets", () => {
    const result = assessDataset(dataset(consistentTeams()));
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("fails when a team's W+D+L does not equal played", () => {
    const teams = consistentTeams();
    const target = teams[0]!;
    teams[0] = { ...target, wins: target.wins! + 1 };
    const result = assessDataset(dataset(teams));
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes(target.name))).toBe(true);
  });

  it("fails a dataset with fewer than 2 teams", () => {
    const result = assessDataset(dataset([consistentTeams()[0]!]));
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => /too few teams/.test(f))).toBe(true);
  });

  it("fails when >30% of odds cells are missing", () => {
    const teams = consistentTeams();
    const markets: NormalizedMarket[] = [
      {
        homeTeam: teams[0]!.name,
        awayTeam: teams[1]!.name,
        oneXTwo: { home: 2.1, draw: 3.4, away: 3.2 },
        sourceFormat: "decimal"
      },
      {
        homeTeam: teams[2]!.name,
        awayTeam: teams[3]!.name,
        sourceFormat: "decimal"
      }
    ];
    const result = assessDataset(dataset(teams, markets));
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => /odds cells/.test(f))).toBe(true);
  });

  it("treats a null goalsFor as a warning, not a failure", () => {
    const teams = consistentTeams();
    teams[0] = { ...teams[0]!, goalsFor: null, missingFields: ["goalsFor"] };
    const result = assessDataset(dataset(teams));
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.warnings.some((w) => w.includes(teams[0]!.name))).toBe(true);
  });
});

// Wave F F2: the deterministicFallbacks disclosure flows PipelineResult →
// TrialResult exactly like healedSteps. buildTrialResult is not exported, so this
// is schema-level coverage: both schemas accept and preserve the optional field.
describe("deterministicFallbacks disclosure (F2)", () => {
  const trialBase = {
    scenarioId: "consent-wall",
    engine: "stagehand" as const,
    trial: 1,
    runId: "r",
    outcome: "pass" as const,
    outcomeReason: "ok",
    outcomeClass: "pass" as const,
    pipelineSuccess: true,
    extractionSuccess: true,
    validationSuccess: true,
    accuracy: null,
    durationMs: 1,
    retries: 0,
    recoveredAfterFailure: false,
    artifactsDir: "d"
  };

  const pipelineBase = {
    engine: "stagehand" as const,
    runId: "r",
    labUrl: "http://lab",
    startedAt: "t0",
    finishedAt: "t1",
    durationMs: 1,
    success: true,
    attempts: 1,
    retries: 0,
    recoveredAfterFailure: false,
    steps: [],
    pages: {},
    validation: { extractOk: true, domainOk: true, issues: [] },
    artifacts: { dir: "d", screenshots: [], eventsFile: "e" }
  };

  it("TrialResultSchema accepts and preserves deterministicFallbacks", () => {
    const parsed = TrialResultSchema.parse({
      ...trialBase,
      deterministicFallbacks: ["consent", "dismiss-modal"]
    });
    expect(parsed.deterministicFallbacks).toEqual(["consent", "dismiss-modal"]);
  });

  it("TrialResultSchema leaves it optional (omitted parses)", () => {
    const parsed = TrialResultSchema.parse(trialBase);
    expect(parsed.deterministicFallbacks).toBeUndefined();
  });

  it("PipelineResultSchema accepts deterministicFallbacks (the source of the trial field)", () => {
    const parsed = PipelineResultSchema.parse({
      ...pipelineBase,
      deterministicFallbacks: ["consent"]
    });
    expect(parsed.deterministicFallbacks).toEqual(["consent"]);
  });
});
