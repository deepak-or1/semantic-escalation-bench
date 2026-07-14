import {
  generateGroundTruth,
  type NormalizedDataset,
  type NormalizedMarket,
  type NormalizedTeamStats
} from "@ssda/shared";
import { describe, expect, it } from "vitest";
import { buildWatchlist, datasetConfidence } from "./watchlist";

function datasetFromTruth(seed: number): NormalizedDataset {
  const truth = generateGroundTruth(seed);
  const teams: NormalizedTeamStats[] = truth.teams.map((t) => ({
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
  const markets: NormalizedMarket[] = truth.markets.map(
    (m): NormalizedMarket => ({
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      kickoff: m.kickoff,
      oneXTwo: m.oneXTwo,
      totals: m.totals,
      sourceFormat: "decimal"
    })
  );
  return {
    teams,
    markets,
    warnings: [],
    failures: [],
    meta: {
      engine: "baseline",
      source: "test",
      extractedAt: "2026-07-08T00:00:00.000Z",
      seed
    }
  };
}

describe("buildWatchlist (end-to-end on generated truth)", () => {
  const dataset = datasetFromTruth(1101);
  const now = "2026-07-08T00:00:00.000Z";
  const watchlist = buildWatchlist(dataset, { now });

  it("emits five selections per market", () => {
    expect(watchlist.allSelections).toHaveLength(dataset.markets.length * 5);
    expect(watchlist.allSelections).toHaveLength(30);
  });

  it("keeps every model probability strictly inside (0, 1)", () => {
    for (const s of watchlist.allSelections) {
      expect(s.modelProbability).toBeGreaterThan(0);
      expect(s.modelProbability).toBeLessThan(1);
    }
  });

  it("keeps edges small — the model tracks the generator's true rates", () => {
    for (const s of watchlist.allSelections) {
      expect(Math.abs(s.edge)).toBeLessThan(0.35);
    }
  });

  it("sorts both selection lists by expected value descending", () => {
    const sorted = (xs: { expectedValuePerUnit: number }[]) =>
      xs.every((s, i) => i === 0 || (xs[i - 1] as { expectedValuePerUnit: number }).expectedValuePerUnit >= s.expectedValuePerUnit);
    expect(sorted(watchlist.allSelections)).toBe(true);
    expect(sorted(watchlist.selections)).toBe(true);
    expect(watchlist.selections.every((s) => s.edge > 0.02)).toBe(true);
  });

  it("rates a full 12-team, 6-market dataset as high confidence", () => {
    expect(watchlist.datasetConfidence.label).toBe("high");
    expect(datasetConfidence(dataset).label).toBe("high");
  });

  it("always carries the fixed limitation caveats", () => {
    expect(watchlist.limitations).toHaveLength(6);
    expect(watchlist.limitations[5]).toMatch(/not betting advice/);
  });

  it("reports the observed average as the params actually used", () => {
    // deriveStrengths' observed average, not the 1.32 default fallback.
    expect(watchlist.paramsUsed.leagueAvgGoals).not.toBe(1.32);
    expect(watchlist.paramsUsed.homeAdvantage).toBe(1.14);
  });

  it("is deterministic when the timestamp is pinned", () => {
    const again = buildWatchlist(dataset, { now });
    expect(again).toEqual(watchlist);
  });
});

describe("buildWatchlist confidence downgrades", () => {
  function team(over: Partial<NormalizedTeamStats> & { name: string }): NormalizedTeamStats {
    return { played: 10, goalsFor: 12, goalsAgainst: 12, missingFields: [], ...over };
  }
  function market(homeTeam: string, awayTeam: string): NormalizedMarket {
    return {
      homeTeam,
      awayTeam,
      kickoff: "2026-07-11T12:00:00.000Z",
      oneXTwo: { home: 2.1, draw: 3.3, away: 3.6 },
      totals: { line: 2.5, over: 1.9, under: 1.95 },
      sourceFormat: "decimal"
    };
  }

  const dataset: NormalizedDataset = {
    teams: [
      team({ name: "Known1", goalsFor: 15, goalsAgainst: 10 }),
      team({ name: "Known2", goalsFor: 12, goalsAgainst: 14 }),
      team({ name: "Blank", goalsFor: null, goalsAgainst: 12, missingFields: ["goalsFor"] })
    ],
    markets: [market("Known1", "Known2"), market("Known1", "Blank")],
    warnings: [],
    failures: [],
    meta: { engine: "baseline", source: "test", extractedAt: "2026-07-08T00:00:00.000Z" }
  };

  const watchlist = buildWatchlist(dataset, { now: "2026-07-08T00:00:00.000Z" });

  it("treats a missing-data dataset as medium overall", () => {
    expect(watchlist.datasetConfidence.label).toBe("medium");
  });

  it("downgrades and annotates selections that touch the neutral-prior team", () => {
    const touched = watchlist.allSelections.filter(
      (s) => s.homeTeam === "Blank" || s.awayTeam === "Blank"
    );
    const untouched = watchlist.allSelections.filter(
      (s) => s.homeTeam !== "Blank" && s.awayTeam !== "Blank"
    );
    expect(touched).toHaveLength(5);
    expect(touched.every((s) => s.confidence === "low")).toBe(true);
    expect(touched.every((s) => s.notes.length > 0)).toBe(true);
    expect(untouched.every((s) => s.confidence === "medium")).toBe(true);
    expect(untouched.every((s) => s.notes.length === 0)).toBe(true);
  });
});
