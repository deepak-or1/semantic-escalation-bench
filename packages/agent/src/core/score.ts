import type {
  AccuracyReport,
  DisplayOverride,
  GroundTruth,
  NormalizedMarket,
  NormalizedTeamStats
} from "@ssda/shared";
import { canonicalName } from "./normalize";

/**
 * Extraction accuracy against the lab's seeded ground truth. Override-aware:
 * "partial" cells are correct when extracted as missing; "corrupt" cells (and
 * the odds groups they belong to) are excluded from scoring — the
 * schema-violation scenario is judged on validation behaviour, not accuracy.
 */

const ODDS_TOLERANCE = 0.02; // absorbs American-odds rounding on the page

const STATS_FIELDS = ["played", "goalsFor", "goalsAgainst", "points"] as const;

function overridesFor(
  overrides: readonly DisplayOverride[],
  page: "stats" | "odds",
  rowKey: string
): Map<string, DisplayOverride> {
  const map = new Map<string, DisplayOverride>();
  for (const o of overrides) {
    if (o.page === page && o.rowKey === rowKey) map.set(o.field, o);
  }
  return map;
}

export function scoreStats(
  teams: readonly NormalizedTeamStats[],
  truth: GroundTruth,
  overrides: readonly DisplayOverride[]
): AccuracyReport {
  const byName = new Map(teams.map((t) => [canonicalName(t.name).toLowerCase(), t]));
  let matchedRows = 0;
  let fieldChecks = 0;
  let fieldMatches = 0;

  for (const truthTeam of truth.teams) {
    const extracted = byName.get(truthTeam.name.toLowerCase());
    const rowOverrides = overridesFor(overrides, "stats", truthTeam.name);
    if (!extracted) continue;
    matchedRows += 1;

    for (const field of STATS_FIELDS) {
      const override = rowOverrides.get(field);
      if (override?.kind === "corrupt") continue; // excluded from accuracy
      const truthValue = truthTeam[field];
      const extractedValue = extracted[field as keyof NormalizedTeamStats] as
        | number
        | null
        | undefined;
      fieldChecks += 1;
      if (override?.kind === "partial") {
        if (extractedValue === null || extractedValue === undefined) fieldMatches += 1;
      } else if (extractedValue === truthValue) {
        fieldMatches += 1;
      }
    }
  }

  const expectedRows = truth.teams.length;
  const rowCoverage = expectedRows === 0 ? 0 : matchedRows / expectedRows;
  const fieldAccuracy = fieldChecks === 0 ? 0 : fieldMatches / fieldChecks;
  return {
    expectedRows,
    matchedRows,
    fieldChecks,
    fieldMatches,
    rowCoverage,
    fieldAccuracy,
    score: rowCoverage * fieldAccuracy
  };
}

const ONE_X_TWO_CELLS = ["homeOdds", "drawOdds", "awayOdds"] as const;
const TOTALS_CELLS = ["overOdds", "underOdds"] as const;

export function scoreOdds(
  markets: readonly NormalizedMarket[],
  truth: GroundTruth,
  overrides: readonly DisplayOverride[]
): AccuracyReport {
  const byFixture = new Map(
    markets.map((m) => [
      `${canonicalName(m.homeTeam).toLowerCase()}|${canonicalName(m.awayTeam).toLowerCase()}`,
      m
    ])
  );
  let matchedRows = 0;
  let fieldChecks = 0;
  let fieldMatches = 0;

  const close = (a: number | undefined, b: number): boolean =>
    a !== undefined && Math.abs(a - b) <= ODDS_TOLERANCE;

  for (const truthMarket of truth.markets) {
    const rowKey = `${truthMarket.homeTeam}|${truthMarket.awayTeam}`;
    const extracted = byFixture.get(
      `${truthMarket.homeTeam.toLowerCase()}|${truthMarket.awayTeam.toLowerCase()}`
    );
    const rowOverrides = overridesFor(overrides, "odds", rowKey);
    if (!extracted) continue;
    matchedRows += 1;

    // A group (1X2 trio / totals pair) containing any overridden cell is
    // skipped whole: normalization drops incomplete groups by design, so
    // grading the surviving cells would punish correct behaviour.
    const oneXTwoTouched = ONE_X_TWO_CELLS.some((c) => rowOverrides.has(c));
    if (!oneXTwoTouched) {
      const truthOdds = truthMarket.oneXTwo;
      const cells: Array<[number | undefined, number]> = [
        [extracted.oneXTwo?.home, truthOdds.home],
        [extracted.oneXTwo?.draw, truthOdds.draw],
        [extracted.oneXTwo?.away, truthOdds.away]
      ];
      for (const [got, want] of cells) {
        fieldChecks += 1;
        if (close(got, want)) fieldMatches += 1;
      }
    }
    const totalsTouched = TOTALS_CELLS.some((c) => rowOverrides.has(c));
    if (!totalsTouched) {
      const cells: Array<[number | undefined, number]> = [
        [extracted.totals?.over, truthMarket.totals.over],
        [extracted.totals?.under, truthMarket.totals.under]
      ];
      for (const [got, want] of cells) {
        fieldChecks += 1;
        if (close(got, want)) fieldMatches += 1;
      }
    }
  }

  const expectedRows = truth.markets.length;
  const rowCoverage = expectedRows === 0 ? 0 : matchedRows / expectedRows;
  const fieldAccuracy = fieldChecks === 0 ? 0 : fieldMatches / fieldChecks;
  return {
    expectedRows,
    matchedRows,
    fieldChecks,
    fieldMatches,
    rowCoverage,
    fieldAccuracy,
    score: rowCoverage * fieldAccuracy
  };
}

export function overallAccuracy(
  stats?: AccuracyReport,
  odds?: AccuracyReport
): number | undefined {
  const scores = [stats?.score, odds?.score].filter(
    (s): s is number => typeof s === "number"
  );
  if (scores.length === 0) return undefined;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}
