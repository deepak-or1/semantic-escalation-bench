import { describe, expect, it } from "vitest";
import { dedupeByTeam, parseIntCell, toOddsRow, toStatsRow, totalPagesFrom } from "./mapping";

describe("parseIntCell", () => {
  it("parses plain and negative integers", () => {
    expect(parseIntCell("22")).toBe(22);
    expect(parseIntCell(" -3 ")).toBe(-3);
  });
  it("returns null for dashes, N/A, blanks and decimals — never guesses", () => {
    expect(parseIntCell("—")).toBeNull();
    expect(parseIntCell("N/A")).toBeNull();
    expect(parseIntCell("")).toBeNull();
    expect(parseIntCell(undefined)).toBeNull();
    expect(parseIntCell("0.62")).toBeNull();
  });
});

describe("toStatsRow (fixed column indices)", () => {
  const cells = ["1", "Lowton Harriers", "22", "13", "4", "5", "41", "28", "13", "43", "WLLDW"];

  it("maps the default column order by td index", () => {
    expect(toStatsRow(cells)).toEqual({
      team: "Lowton Harriers",
      played: 22,
      wins: 13,
      draws: 4,
      losses: 5,
      goalsFor: 41,
      goalsAgainst: 28,
      points: 43,
      form: "WLLDW"
    });
  });

  it("faithfully preserves corrupt/partial cells (null, negative)", () => {
    const corrupt = ["1", "Team", "-3", "30", "4", "5", "N/A", "28", "-2", "43", ""];
    const row = toStatsRow(corrupt);
    expect(row.played).toBe(-3);
    expect(row.goalsFor).toBeNull();
    expect(row.form).toBeNull();
  });
});

describe("toOddsRow (fixed column indices)", () => {
  it("splits the match cell and passes odds strings through verbatim", () => {
    const cells = ["Sat 11 Jul, 12:00", "Kestrel Park vs Ashford Rovers", "2.20", "3.81", "3.00", "2.00", "1.84"];
    expect(toOddsRow(cells)).toEqual({
      kickoff: "Sat 11 Jul, 12:00",
      homeTeam: "Kestrel Park",
      awayTeam: "Ashford Rovers",
      homeOdds: "2.20",
      drawOdds: "3.81",
      awayOdds: "3.00",
      overOdds: "2.00",
      underOdds: "1.84",
      totalsLine: "2.5"
    });
  });

  it("passes American moneyline through unchanged and nulls empty cells", () => {
    const cells = ["Sat", "A vs B", "+120", "-145", "", "-110", "—"];
    const row = toOddsRow(cells);
    expect(row.homeOdds).toBe("+120");
    expect(row.awayOdds).toBeNull();
    expect(row.underOdds).toBe("—");
  });

  it("keeps the full text as home team when the split does not yield two parts", () => {
    const row = toOddsRow(["Sat", "TBD", "2.0", "3.0", "4.0", "2.0", "1.8"]);
    expect(row.homeTeam).toBe("TBD");
    expect(row.awayTeam).toBe("");
  });
});

describe("dedupeByTeam / totalPagesFrom", () => {
  it("keeps the first occurrence of each team", () => {
    const rows = [
      toStatsRow(["1", "A", "1", "1", "0", "0", "1", "0", "1", "3", "W"]),
      toStatsRow(["2", "A", "9", "9", "0", "0", "9", "0", "9", "9", "L"]),
      toStatsRow(["3", "B", "1", "0", "1", "0", "0", "0", "0", "1", "D"])
    ];
    const out = dedupeByTeam(rows);
    expect(out.map((r) => r.team)).toEqual(["A", "B"]);
    expect(out[0]?.wins).toBe(1);
  });

  it("reads N from a 'Page X of N' indicator", () => {
    expect(totalPagesFrom("Page 1 of 3")).toBe(3);
    expect(totalPagesFrom("Page 2 of 2")).toBe(2);
    expect(totalPagesFrom(null)).toBe(1);
    expect(totalPagesFrom("no pager here")).toBe(1);
  });
});
