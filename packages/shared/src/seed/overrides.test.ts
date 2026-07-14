import { describe, expect, it } from "vitest";
import type { DisplayOverride } from "../schemas/domain";
import {
  computeDisplayOverrides,
  displayedOddsCell,
  displayedStatsCell,
  generateGroundTruth
} from "./generate";

describe("computeDisplayOverrides", () => {
  it("returns [] for empty chaos", () => {
    const gt = generateGroundTruth(1101);
    expect(computeDisplayOverrides(gt, [], 1101)).toEqual([]);
  });

  it("produces 3 partial stats overrides + 1 odds override for partialData (seed 1113)", () => {
    const gt = generateGroundTruth(1113);
    const overrides = computeDisplayOverrides(gt, ["partialData"], 1113);

    const stats = overrides.filter((o) => o.page === "stats");
    const odds = overrides.filter((o) => o.page === "odds");
    expect(stats).toHaveLength(3);
    expect(odds).toHaveLength(1);

    for (const o of stats) {
      expect(o.field).toBe("goalsAgainst");
      expect(o.displayed).toBe("—");
      expect(o.kind).toBe("partial");
    }
    expect(odds[0]!.field).toBe("underOdds");
    expect(odds[0]!.displayed).toBe("—");
    expect(odds[0]!.kind).toBe("partial");
  });

  it("produces the expected corrupt overrides for corruptData (seed 1116)", () => {
    const gt = generateGroundTruth(1116);
    const overrides = computeDisplayOverrides(gt, ["corruptData"], 1116);

    const stats = overrides.filter((o) => o.page === "stats");
    const odds = overrides.filter((o) => o.page === "odds");

    const winsOv = stats.find((o) => o.field === "wins");
    expect(winsOv).toBeDefined();
    const winsTeam = gt.teams.find((t) => t.name === winsOv!.rowKey);
    expect(winsTeam).toBeDefined();
    expect(winsOv!.displayed).toBe(String(winsTeam!.played + 8));
    expect(winsOv!.kind).toBe("corrupt");

    const playedOv = stats.find((o) => o.field === "played");
    expect(playedOv?.displayed).toBe("-3");

    const goalsForOv = stats.find((o) => o.field === "goalsFor");
    expect(goalsForOv?.displayed).toBe("N/A");

    // Exactly two odds overrides, both on the same row.
    expect(odds).toHaveLength(2);
    expect(new Set(odds.map((o) => o.rowKey)).size).toBe(1);
  });
});

describe("displayedStatsCell", () => {
  const gt = generateGroundTruth(1116);
  const overrides = computeDisplayOverrides(gt, ["corruptData"], 1116);

  it("returns the override when one is present", () => {
    const winsOv = overrides.find((o) => o.field === "wins")!;
    const team = gt.teams.find((t) => t.name === winsOv.rowKey)!;
    expect(displayedStatsCell(team, "wins", overrides)).toBe(winsOv.displayed);
  });

  it("returns String(team[field]) when there is no override", () => {
    const team = gt.teams[0]!;
    expect(displayedStatsCell(team, "points", [])).toBe(String(team.points));
    expect(displayedStatsCell(team, "name", [])).toBe(team.name);
  });
});

describe("displayedOddsCell", () => {
  const gt = generateGroundTruth(1101);
  const market = gt.markets[0]!;

  it("formats decimal odds with toFixed(2)", () => {
    expect(displayedOddsCell(market, "homeOdds", [], false)).toBe(
      market.oneXTwo.home.toFixed(2)
    );
    expect(displayedOddsCell(market, "underOdds", [], false)).toBe(
      market.totals.under.toFixed(2)
    );
  });

  it("formats american odds with a leading sign", () => {
    expect(displayedOddsCell(market, "homeOdds", [], true)).toMatch(/^[+-]/);
    expect(displayedOddsCell(market, "awayOdds", [], true)).toMatch(/^[+-]/);
  });

  it("respects overrides regardless of format", () => {
    const override: DisplayOverride = {
      page: "odds",
      rowKey: `${market.homeTeam}|${market.awayTeam}`,
      field: "homeOdds",
      displayed: "n/a",
      kind: "corrupt"
    };
    expect(displayedOddsCell(market, "homeOdds", [override], false)).toBe("n/a");
    expect(displayedOddsCell(market, "homeOdds", [override], true)).toBe("n/a");
  });
});
