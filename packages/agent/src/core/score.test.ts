import {
  computeDisplayOverrides,
  decimalToAmerican,
  formatAmerican,
  generateGroundTruth,
  type ExtractedOddsRow,
  type ExtractedStatsRow,
  type FixtureMarket,
  type TeamSeasonStats
} from "@ssda/shared";
import { describe, expect, it } from "vitest";
import { normalizeOdds, normalizeStats } from "./normalize";
import { overallAccuracy, scoreOdds, scoreStats } from "./score";

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

function decimalOddsRow(m: FixtureMarket): ExtractedOddsRow {
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

function americanOddsRow(m: FixtureMarket): ExtractedOddsRow {
  const a = (d: number): string => formatAmerican(decimalToAmerican(d));
  return {
    homeTeam: m.homeTeam,
    awayTeam: m.awayTeam,
    kickoff: m.kickoff,
    homeOdds: a(m.oneXTwo.home),
    drawOdds: a(m.oneXTwo.draw),
    awayOdds: a(m.oneXTwo.away),
    totalsLine: String(m.totals.line),
    overOdds: a(m.totals.over),
    underOdds: a(m.totals.under)
  };
}

describe("scoreStats / scoreOdds round-trips", () => {
  const truth = generateGroundTruth(1101);

  it("scores a perfect decimal extraction as exactly 1", () => {
    const stats = normalizeStats(truth.teams.map(statsRowFromTruth));
    const odds = normalizeOdds(truth.markets.map(decimalOddsRow));

    const statsReport = scoreStats(stats.teams, truth, []);
    const oddsReport = scoreOdds(odds.markets, truth, []);

    expect(statsReport.score).toBe(1);
    expect(statsReport.matchedRows).toBe(statsReport.expectedRows);
    expect(oddsReport.score).toBe(1);
    expect(oddsReport.matchedRows).toBe(oddsReport.expectedRows);
  });

  it("scores an American extraction as 1 within the 0.02 tolerance", () => {
    const odds = normalizeOdds(truth.markets.map(americanOddsRow));
    expect(odds.markets[0]!.sourceFormat).toBe("american");
    const oddsReport = scoreOdds(odds.markets, truth, []);
    expect(oddsReport.score).toBe(1);
  });
});

describe("scoreStats with partialData overrides (seed 1113)", () => {
  const truth = generateGroundTruth(1113);
  const overrides = computeDisplayOverrides(truth, ["partialData"], 1113);
  const nulledTeams = new Set(
    overrides.filter((o) => o.page === "stats" && o.field === "goalsAgainst").map((o) => o.rowKey)
  );

  it("scores 1 when overridden goalsAgainst cells are extracted as null", () => {
    const rows = truth.teams.map((t) => {
      const row = statsRowFromTruth(t);
      if (nulledTeams.has(t.name)) row.goalsAgainst = null;
      return row;
    });
    const stats = normalizeStats(rows);
    const report = scoreStats(stats.teams, truth, overrides);
    expect(report.score).toBe(1);
    expect(report.fieldMatches).toBe(report.fieldChecks);
  });

  it("drops fieldMatches when the same cells report real numbers", () => {
    // Faithful-but-wrong: the page shows a dash, extraction reports the value.
    const stats = normalizeStats(truth.teams.map(statsRowFromTruth));
    const report = scoreStats(stats.teams, truth, overrides);
    expect(report.fieldMatches).toBeLessThan(report.fieldChecks);
    expect(report.score).toBeLessThan(1);
    // Exactly the three overridden cells are penalised.
    expect(report.fieldChecks - report.fieldMatches).toBe(nulledTeams.size);
  });
});

describe("scoreStats with corruptData overrides (seed 1116)", () => {
  const truth = generateGroundTruth(1116);
  const overrides = computeDisplayOverrides(truth, ["corruptData"], 1116);

  it("excludes corrupt cells so fieldChecks is below 4 per team", () => {
    const stats = normalizeStats(truth.teams.map(statsRowFromTruth));
    const report = scoreStats(stats.teams, truth, overrides);
    expect(report.matchedRows).toBe(12);
    // 4 scored fields * 12 teams = 48; played + goalsFor corrupt cells excluded.
    expect(report.fieldChecks).toBeLessThan(4 * truth.teams.length);
    expect(report.fieldChecks).toBe(46);
  });
});

describe("row coverage and overallAccuracy", () => {
  const truth = generateGroundTruth(1101);

  it("reports 11/12 row coverage when one team is missing", () => {
    const rows = truth.teams.slice(0, 11).map(statsRowFromTruth);
    const stats = normalizeStats(rows);
    const report = scoreStats(stats.teams, truth, []);
    expect(report.matchedRows).toBe(11);
    expect(report.expectedRows).toBe(12);
    expect(report.rowCoverage).toBeCloseTo(11 / 12, 10);
  });

  it("averages both reports and is undefined when neither is present", () => {
    const stats = normalizeStats(truth.teams.map(statsRowFromTruth));
    const odds = normalizeOdds(truth.markets.map(decimalOddsRow));
    const statsReport = scoreStats(stats.teams, truth, []);
    const oddsReport = scoreOdds(odds.markets, truth, []);

    expect(overallAccuracy(statsReport, oddsReport)).toBe(1);
    expect(overallAccuracy(statsReport, undefined)).toBe(statsReport.score);
    expect(overallAccuracy(undefined, undefined)).toBeUndefined();
  });
});

describe("entity-completeness guards (Wave E 8e)", () => {
  const truth = generateGroundTruth(1101);

  it("clean extraction reports zero duplicate and zero unexpected rows", () => {
    const stats = normalizeStats(truth.teams.map(statsRowFromTruth));
    const statsReport = scoreStats(stats.teams, truth, []);
    expect(statsReport.duplicateRows).toBe(0);
    expect(statsReport.unexpectedRows).toBe(0);

    const odds = normalizeOdds(truth.markets.map(decimalOddsRow));
    const oddsReport = scoreOdds(odds.markets, truth, []);
    expect(oddsReport.duplicateRows).toBe(0);
    expect(oddsReport.unexpectedRows).toBe(0);
  });

  it("counts a duplicated team row (same key extracted twice)", () => {
    const rows = truth.teams.map(statsRowFromTruth);
    rows.push(statsRowFromTruth(truth.teams[0]!)); // the same team, twice
    const stats = normalizeStats(rows);
    const report = scoreStats(stats.teams, truth, []);
    expect(report.duplicateRows).toBe(1);
    expect(report.unexpectedRows).toBe(0);
  });

  it("counts a ghost 13th team absent from ground truth", () => {
    const rows = truth.teams.map(statsRowFromTruth);
    const ghost = statsRowFromTruth(truth.teams[0]!);
    ghost.team = "Phantom Wanderers FC"; // a team the page never contained
    rows.push(ghost);
    const stats = normalizeStats(rows);
    const report = scoreStats(stats.teams, truth, []);
    expect(report.unexpectedRows).toBe(1);
    expect(report.duplicateRows).toBe(0);
  });

  it("counts a ghost fixture on the odds board", () => {
    const rows = truth.markets.map(decimalOddsRow);
    const ghost = decimalOddsRow(truth.markets[0]!);
    ghost.homeTeam = "Phantom Wanderers FC"; // a fixture never listed
    rows.push(ghost);
    const odds = normalizeOdds(rows);
    const report = scoreOdds(odds.markets, truth, []);
    expect(report.unexpectedRows).toBe(1);
  });
});
