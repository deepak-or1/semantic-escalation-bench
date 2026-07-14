import {
  generateGroundTruth,
  type ExtractedOddsRow,
  type ExtractedStatsRow,
  type TeamSeasonStats
} from "@ssda/shared";
import { describe, expect, it } from "vitest";
import { normalizeOdds, normalizeStats } from "./normalize";

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

/** A single valid stats row, overridable field-by-field. */
function statsRow(over: Partial<ExtractedStatsRow> = {}): ExtractedStatsRow {
  return {
    team: "Ashford Rovers",
    played: 22,
    wins: 10,
    draws: 6,
    losses: 6,
    goalsFor: 30,
    goalsAgainst: 25,
    points: 36,
    form: "WWDLW",
    ...over
  };
}

/** A single odds row; home/draw/away default to a valid decimal trio. */
function oddsRow(over: Partial<ExtractedOddsRow> = {}): ExtractedOddsRow {
  return {
    homeTeam: "Ashford Rovers",
    awayTeam: "Bexley Town",
    homeOdds: "1.85",
    drawOdds: "3.40",
    awayOdds: "4.20",
    ...over
  };
}

describe("normalizeStats", () => {
  it("maps clean ground-truth rows with no warnings or failures", () => {
    const truth = generateGroundTruth(1101);
    const rows = truth.teams.map(statsRowFromTruth);
    const result = normalizeStats(rows);
    expect(result.teams).toHaveLength(12);
    expect(result.warnings).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it("keeps a row with goalsFor null but records a missing field and warning", () => {
    const result = normalizeStats([statsRow({ goalsFor: null })]);
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0]!.goalsFor).toBeNull();
    expect(result.teams[0]!.missingFields).toContain("goalsFor");
    expect(result.failures).toEqual([]);
    expect(result.warnings.some((w) => w.includes("goalsFor"))).toBe(true);
  });

  it("drops a row whose played is null and records a failure", () => {
    const result = normalizeStats([statsRow({ played: null })]);
    expect(result.teams).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(/played is missing\/unreadable/);
  });

  it("drops a played -3 row with a failure naming the team", () => {
    const result = normalizeStats([statsRow({ team: "Calder United", played: -3 })]);
    expect(result.teams).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("Calder United");
    expect(result.failures[0]).toContain("played");
  });

  it("fails a row with an empty team name", () => {
    const result = normalizeStats([statsRow({ team: "" })]);
    expect(result.teams).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(/empty team name/);
  });

  it("sanitizes form 'wWdLx' to 'WWDL'", () => {
    const result = normalizeStats([statsRow({ form: "wWdLx" })]);
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0]!.form).toBe("WWDL");
  });
});

describe("normalizeOdds", () => {
  it("normalizes a decimal trio plus totals with sourceFormat 'decimal'", () => {
    const result = normalizeOdds([
      oddsRow({ overOdds: "1.90", underOdds: "1.95", totalsLine: "2.5" })
    ]);
    expect(result.markets).toHaveLength(1);
    const m = result.markets[0]!;
    expect(m.sourceFormat).toBe("decimal");
    expect(m.oneXTwo).toEqual({ home: 1.85, draw: 3.4, away: 4.2 });
    expect(m.totals).toEqual({ line: 2.5, over: 1.9, under: 1.95 });
    expect(result.warnings).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it("converts American cells and tags sourceFormat 'american'", () => {
    const result = normalizeOdds([
      oddsRow({ homeOdds: "+154", drawOdds: "+240", awayOdds: "-120" })
    ]);
    const m = result.markets[0]!;
    expect(m.sourceFormat).toBe("american");
    // +154 -> 1 + 154/100 = 2.54
    expect(m.oneXTwo!.home).toBeCloseTo(2.54, 5);
    // -120 -> 1 + 100/120
    expect(m.oneXTwo!.away).toBeCloseTo(1 + 100 / 120, 5);
  });

  it("tags a mixed-format trio as 'mixed'", () => {
    const result = normalizeOdds([
      oddsRow({ homeOdds: "1.85", drawOdds: "+240", awayOdds: "4.20" })
    ]);
    const m = result.markets[0]!;
    expect(m.oneXTwo).toBeDefined();
    expect(m.sourceFormat).toBe("mixed");
  });

  it("drops an incomplete 1X2 trio when drawOdds is an em-dash", () => {
    const result = normalizeOdds([
      oddsRow({ drawOdds: "—", overOdds: "1.90", underOdds: "1.95" })
    ]);
    const m = result.markets[0]!;
    expect(m.oneXTwo).toBeUndefined();
    expect(m.totals).toBeDefined();
    expect(result.warnings.some((w) => w.includes("incomplete 1X2 trio dropped"))).toBe(true);
  });

  it("drops totals when overOdds is present but underOdds is null", () => {
    const result = normalizeOdds([oddsRow({ overOdds: "1.90", underOdds: null })]);
    const m = result.markets[0]!;
    expect(m.totals).toBeUndefined();
    expect(m.oneXTwo).toBeDefined();
    expect(result.warnings.some((w) => w.includes("incomplete totals pair dropped"))).toBe(true);
  });

  it("warns about unusable cells like 'abc' and '0.62'", () => {
    const result = normalizeOdds([
      oddsRow({ homeTeam: "A", awayTeam: "B", homeOdds: "abc", overOdds: "1.90", underOdds: "1.95" }),
      oddsRow({ homeTeam: "C", awayTeam: "D", homeOdds: "0.62", overOdds: "1.90", underOdds: "1.95" })
    ]);
    expect(result.warnings.some((w) => w.includes('"abc"'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('"0.62"'))).toBe(true);
  });

  it("fails a row with both team names empty", () => {
    const result = normalizeOdds([oddsRow({ homeTeam: "", awayTeam: "" })]);
    expect(result.markets).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(/missing team name/);
  });

  it("parses the totals line from '2.5', 'O/U 2.5' and a missing value to 2.5", () => {
    const result = normalizeOdds([
      oddsRow({ homeTeam: "A", awayTeam: "B", overOdds: "1.90", underOdds: "1.95", totalsLine: "2.5" }),
      oddsRow({ homeTeam: "C", awayTeam: "D", overOdds: "1.90", underOdds: "1.95", totalsLine: "O/U 2.5" }),
      oddsRow({ homeTeam: "E", awayTeam: "F", overOdds: "1.90", underOdds: "1.95" })
    ]);
    expect(result.markets).toHaveLength(3);
    for (const m of result.markets) {
      expect(m.totals!.line).toBe(2.5);
    }
  });
});
