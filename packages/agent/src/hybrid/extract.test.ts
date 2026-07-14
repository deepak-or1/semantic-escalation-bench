import { describe, expect, it } from "vitest";
import {
  oddsRowsFrom,
  parseIntCell,
  selectOddsTable,
  selectStatsTable,
  statsRowsFrom,
  type RawTable
} from "./extract";

describe("parseIntCell", () => {
  it("parses exact integer tokens only, negatives included", () => {
    expect(parseIntCell("12")).toBe(12);
    expect(parseIntCell("-3")).toBe(-3);
    expect(parseIntCell(" 7 ")).toBe(7);
  });
  it("returns null for dashes, blanks and non-integers", () => {
    expect(parseIntCell("—")).toBeNull();
    expect(parseIntCell("")).toBeNull();
    expect(parseIntCell("N/A")).toBeNull();
    expect(parseIntCell("2.5")).toBeNull();
    expect(parseIntCell(undefined)).toBeNull();
  });
});

describe("statsRowsFrom maps columns by header on shuffled tables", () => {
  it("reads the right field from each column and ignores # and GD", () => {
    // Columns permuted relative to the default order; "#" and "GD" present.
    const table: RawTable = {
      headers: ["#", "Team", "GF", "P", "Form", "W", "GD", "D", "GA", "L", "Pts"],
      rows: [
        ["1", "Arsenal", "40", "10", "WWDLW", "7", "18", "2", "22", "1", "23"],
        ["2", "Chelsea", "31", "10", "DLWWW", "6", "9", "3", "22", "1", "21"]
      ]
    };
    const rows = statsRowsFrom(table);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      team: "Arsenal",
      played: 10,
      wins: 7,
      draws: 2,
      losses: 1,
      goalsFor: 40,
      goalsAgainst: 22,
      points: 23,
      form: "WWDLW"
    });
    expect(rows[1]).toMatchObject({ team: "Chelsea", goalsFor: 31, goalsAgainst: 22, points: 21 });
  });

  it("faithfully reads corrupt/partial cells as-is (null for em-dash)", () => {
    const table: RawTable = {
      headers: ["#", "Team", "P", "W", "D", "L", "GF", "GA", "GD", "Pts", "Form"],
      rows: [["1", "Spurs", "10", "5", "2", "3", "—", "12", "—", "17", "WLWDW"]]
    };
    const [row] = statsRowsFrom(table);
    expect(row?.goalsFor).toBeNull();
    expect(row?.goalsAgainst).toBe(12);
  });
});

describe("oddsRowsFrom", () => {
  it("splits the match and maps odds columns by header", () => {
    const table: RawTable = {
      headers: ["Kickoff", "Match", "1", "X", "2", "Over 2.5", "Under 2.5"],
      rows: [["Sat 3 Feb, 15:00", "Arsenal vs Chelsea", "1.85", "3.60", "4.20", "1.95", "1.90"]]
    };
    const [row] = oddsRowsFrom(table);
    expect(row).toMatchObject({
      homeTeam: "Arsenal",
      awayTeam: "Chelsea",
      homeOdds: "1.85",
      drawOdds: "3.60",
      awayOdds: "4.20",
      overOdds: "1.95",
      underOdds: "1.90",
      totalsLine: "2.5"
    });
    expect(row?.kickoff).toBe("Sat 3 Feb, 15:00");
  });

  it("keeps American odds verbatim as strings", () => {
    const table: RawTable = {
      headers: ["Kickoff", "Match", "1", "X", "2", "Over 2.5", "Under 2.5"],
      rows: [["Sun 4 Feb, 14:00", "Spurs vs Everton", "-120", "+240", "+310", "-110", "-105"]]
    };
    const [row] = oddsRowsFrom(table);
    expect(row?.homeOdds).toBe("-120");
    expect(row?.awayOdds).toBe("+310");
  });
});

describe("table selection", () => {
  const stats: RawTable = {
    headers: ["#", "Team", "P", "W", "D", "L", "GF", "GA", "GD", "Pts", "Form"],
    rows: [["1", "Arsenal", "10", "7", "2", "1", "40", "22", "18", "23", "WWDLW"]]
  };
  const odds: RawTable = {
    headers: ["Kickoff", "Match", "1", "X", "2", "Over 2.5", "Under 2.5"],
    rows: [["Sat", "A vs B", "1.9", "3.4", "4.1", "1.9", "1.9"]]
  };

  it("selects the standings table (>=4 stat headers), never the odds table", () => {
    expect(selectStatsTable([odds, stats])).toBe(stats);
    expect(selectStatsTable([odds])).toBeNull();
  });

  it("selects the odds table (match + odds columns), never the stats table", () => {
    expect(selectOddsTable([stats, odds])).toBe(odds);
    expect(selectOddsTable([stats])).toBeNull();
  });

  it("returns null when there is no mappable table (a card grid)", () => {
    expect(selectStatsTable([])).toBeNull();
    expect(selectOddsTable([])).toBeNull();
  });
});
