import { describe, expect, it } from "vitest";
import { BenchmarkResultsSchema, TrialResultSchema } from "./benchmark";

/**
 * The optional `stopped` marker on BenchmarkResults (PROTOCOL_2A §7): present only
 * when a pre-trial budget stop halted the run. Being optional, every pre-existing
 * results.json (which never carried it) must still parse; when present it records
 * why the campaign stopped and how far it got.
 */

/** A minimal, schema-valid results document with no trials (the base to extend). */
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

describe("BenchmarkResultsSchema — optional stopped marker", () => {
  it("parses a results document WITHOUT stopped (every pre-existing file stays valid)", () => {
    const parsed = BenchmarkResultsSchema.safeParse(baseResults());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.stopped).toBeUndefined();
  });

  it("parses a results document WITH a well-formed stopped marker", () => {
    const parsed = BenchmarkResultsSchema.safeParse({
      ...baseResults(),
      stopped: { reason: "budget stop", completedTrials: 3, plannedTrials: 10 }
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.stopped).toEqual({
        reason: "budget stop",
        completedTrials: 3,
        plannedTrials: 10
      });
    }
  });

  it("rejects a stopped marker missing a required field", () => {
    const parsed = BenchmarkResultsSchema.safeParse({
      ...baseResults(),
      stopped: { reason: "budget stop", completedTrials: 3 } // plannedTrials missing
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a negative completedTrials in the stopped marker", () => {
    const parsed = BenchmarkResultsSchema.safeParse({
      ...baseResults(),
      stopped: { reason: "budget stop", completedTrials: -1, plannedTrials: 10 }
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * Record version 2 (docs/RECORD_FORMAT.md). Every addition is OPTIONAL, so the
 * compatibility rule the format promises — "v1 bundles must keep verifying
 * byte-for-byte" — is a schema property, not a convention: a stored v1 record
 * still parses and reports every v2 field as absent, while a v2 record
 * round-trips its grading inputs unchanged.
 */

/** A trial record in the SHIPPED version-1 shape (no v2 field is present). */
function v1Trial(): Record<string, unknown> {
  return {
    scenarioId: "clean-extraction",
    engine: "baseline",
    trial: 1,
    runId: "clean-extraction-baseline-t1",
    outcome: "pass",
    outcomeReason: "success: pipeline succeeded (accuracy 1.00)",
    outcomeClass: "pass",
    pipelineSuccess: true,
    extractionSuccess: true,
    validationSuccess: true,
    accuracy: {
      stats: {
        expectedRows: 1,
        matchedRows: 1,
        fieldChecks: 4,
        fieldMatches: 4,
        rowCoverage: 1,
        fieldAccuracy: 1,
        duplicateRows: 0,
        unexpectedRows: 0,
        score: 1
      },
      overall: 1
    },
    durationMs: 1234,
    retries: 0,
    recoveredAfterFailure: false,
    artifactsDir: "runs/bench-x/trials/clean-extraction-baseline-t1",
    tokens: null
  };
}

/** The v1 trial above, upgraded in place with the v2 additions. */
function v2Trial(): Record<string, unknown> {
  return {
    ...v1Trial(),
    recordVersion: 2,
    chromeVersion: "HeadlessChrome/140.0.7339.16",
    canonical: {
      // The pre-normalization payloads: the root of the re-derivable chain. The
      // record schema pins the CONTAINER only — validating the rows here would
      // make extractionSuccess true by construction and defeat the point.
      raw: {
        stats: {
          rows: [
            {
              team: "Ashford United",
              played: 12,
              goalsFor: 21,
              goalsAgainst: 9,
              points: 26
            }
          ]
        },
        odds: {
          rows: [
            {
              homeTeam: "Ashford United",
              awayTeam: "Brackley Town",
              homeOdds: "2.10",
              drawOdds: "3.40",
              awayOdds: "3.60",
              totalsLine: "2.5",
              overOdds: "1.95",
              underOdds: "1.90"
            }
          ]
        }
      },
      stats: [
        {
          name: "Ashford United",
          played: 12,
          goalsFor: 21,
          goalsAgainst: 9,
          points: 26,
          missingFields: []
        }
      ],
      odds: [
        {
          homeTeam: "Ashford United",
          awayTeam: "Brackley Town",
          oneXTwo: { home: 2.1, draw: 3.4, away: 3.6 },
          totals: { line: 2.5, over: 1.95, under: 1.9 },
          sourceFormat: "decimal"
        }
      ],
      failures: [],
      warnings: []
    },
    stepTrace: [
      { step: "reveal-table", readinessOutcome: "ready", modelCallsAtStep: 0 },
      {
        step: "extract-stats",
        cachedSelectorMatched: false,
        escalationTriggered: true,
        repairAttempted: true,
        repairSucceeded: true,
        repairKind: "llm",
        modelCallsAtStep: 1,
        downstreamRecovered: true,
        note: "observe re-discovered the control"
      }
    ]
  };
}

describe("record version 2 — additive, so v1 keeps parsing", () => {
  it("parses a stored v1 trial record and reports every v2 field as absent", () => {
    const parsed = TrialResultSchema.safeParse(v1Trial());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.recordVersion).toBeUndefined();
    expect(parsed.data.canonical).toBeUndefined();
    expect(parsed.data.stepTrace).toBeUndefined();
  });

  it("parses a stored v1 results document and reports every run-level v2 field as absent", () => {
    const parsed = BenchmarkResultsSchema.safeParse({
      ...baseResults(),
      trials: [v1Trial()]
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.oracles).toBeUndefined();
    expect(parsed.data.environment.modelConfig).toBeUndefined();
    expect(parsed.data.environment.chromeVersion).toBeUndefined();
    expect(parsed.data.environment.pricesPinnedAt).toBeUndefined();
  });

  it("round-trips a v2 trial record: canonical rows and stepTrace survive parsing unchanged", () => {
    const input = v2Trial();
    const parsed = TrialResultSchema.safeParse(input);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.recordVersion).toBe(2);
    expect(parsed.data.canonical).toEqual(input.canonical);
    expect(parsed.data.stepTrace).toEqual(input.stepTrace);
    // Re-parsing the parsed value is a fixed point — nothing was coerced away.
    expect(TrialResultSchema.parse(parsed.data)).toEqual(parsed.data);
  });

  it("round-trips a v2 results document: oracles and the v2 environment stamps survive", () => {
    const oracle = {
      truth: {
        seed: 7,
        league: {
          name: "Test League",
          season: "2025/26",
          avgGoalsPerTeamPerGame: 1.4,
          trueHomeAdvantage: 1.2
        },
        teams: [
          {
            id: "t1",
            name: "Ashford United",
            played: 12,
            wins: 8,
            draws: 2,
            losses: 2,
            goalsFor: 21,
            goalsAgainst: 9,
            points: 26,
            form: "WWDLW"
          }
        ],
        fixtures: [
          {
            id: "f1",
            homeTeam: "Ashford United",
            awayTeam: "Brackley Town",
            kickoff: "2026-01-01T15:00:00.000Z"
          }
        ],
        markets: [
          {
            fixtureId: "f1",
            homeTeam: "Ashford United",
            awayTeam: "Brackley Town",
            kickoff: "2026-01-01T15:00:00.000Z",
            oneXTwo: { home: 2.1, draw: 3.4, away: 3.6 },
            totals: { line: 2.5, over: 1.95, under: 1.9 }
          }
        ],
        trueProbabilities: [{ fixtureId: "f1", home: 0.5, draw: 0.25, away: 0.25, over25: 0.55 }]
      },
      overrides: [
        {
          page: "stats",
          rowKey: "Ashford United",
          field: "points",
          displayed: "—",
          kind: "partial"
        }
      ]
    };
    const input = {
      ...baseResults(),
      trials: [v2Trial()],
      oracles: { "clean-extraction": oracle },
      environment: {
        ...(baseResults().environment as Record<string, unknown>),
        modelConfig: { temperature: null, temperatureSource: "provider-default" },
        chromeVersion: "140.0.7339.16",
        pricesPinnedAt: "2026-07-14"
      }
    };
    const parsed = BenchmarkResultsSchema.safeParse(input);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.oracles).toEqual({ "clean-extraction": oracle });
    expect(parsed.data.environment.modelConfig).toEqual({
      temperature: null,
      temperatureSource: "provider-default"
    });
    expect(parsed.data.environment.chromeVersion).toBe("140.0.7339.16");
    expect(parsed.data.environment.pricesPinnedAt).toBe("2026-07-14");
  });

  it("accepts an explicit recordVersion 1 (it means the same as absent) and rejects any other version", () => {
    const explicitV1 = TrialResultSchema.safeParse({ ...v1Trial(), recordVersion: 1 });
    expect(explicitV1.success).toBe(true);
    if (explicitV1.success) expect(explicitV1.data.recordVersion).toBe(1);
    expect(TrialResultSchema.safeParse({ ...v1Trial(), recordVersion: 3 }).success).toBe(false);
    expect(TrialResultSchema.safeParse({ ...v1Trial(), recordVersion: 0 }).success).toBe(false);
  });

  it("rejects a canonical block that omits a page (null is the only way to say 'no rows')", () => {
    const trial = v2Trial() as { canonical: Record<string, unknown> };
    expect(
      TrialResultSchema.safeParse({
        ...trial,
        canonical: { ...trial.canonical, odds: undefined }
      }).success
    ).toBe(false);
    // ...but an explicit null everywhere is valid (no payload, no dataset).
    expect(
      TrialResultSchema.safeParse({
        ...trial,
        canonical: {
          raw: { stats: null, odds: null },
          stats: null,
          odds: null,
          failures: [],
          warnings: []
        },
        accuracy: null
      }).success
    ).toBe(true);
  });

  it("rejects a canonical block that omits the dataset's failures/warnings (validationSuccess would not be recomputable)", () => {
    const trial = v2Trial() as { canonical: Record<string, unknown> };
    expect(
      TrialResultSchema.safeParse({
        ...trial,
        canonical: { ...trial.canonical, failures: undefined, warnings: undefined }
      }).success
    ).toBe(false);
  });

  it("rejects a canonical block that omits the raw payloads (nothing downstream would be re-derivable)", () => {
    const trial = v2Trial() as { canonical: Record<string, unknown> };
    expect(
      TrialResultSchema.safeParse({ ...trial, canonical: { ...trial.canonical, raw: undefined } })
        .success
    ).toBe(false);
    // A page that produced no payload says so with null — never by omission.
    expect(
      TrialResultSchema.safeParse({
        ...trial,
        canonical: { ...trial.canonical, raw: { stats: null } }
      }).success
    ).toBe(false);
  });

  it("accepts raw rows the extraction schema would REJECT — validating them here would make extractionSuccess un-recomputable", () => {
    const trial = v2Trial() as { canonical: Record<string, unknown> };
    const parsed = TrialResultSchema.safeParse({
      ...trial,
      canonical: {
        ...trial.canonical,
        // `played` as text: exactly what checkStatsSchema exists to catch. The
        // RECORD must carry it so the verifier can catch it.
        raw: { stats: { rows: [{ team: "Ashford United", played: "twelve" }] }, odds: null }
      }
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.canonical!.raw.stats).toEqual({
      rows: [{ team: "Ashford United", played: "twelve" }]
    });
  });
});
