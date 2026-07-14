import { describe, expect, it } from "vitest";
import { GroundTruthSchema } from "../schemas/domain";
import { generateGroundTruth } from "./generate";

describe("generateGroundTruth determinism", () => {
  it("returns deep-equal results for the same seed", () => {
    expect(generateGroundTruth(7)).toEqual(generateGroundTruth(7));
  });

  it("parses against GroundTruthSchema for seeds 7 and 1101", () => {
    expect(GroundTruthSchema.safeParse(generateGroundTruth(7)).success).toBe(true);
    expect(GroundTruthSchema.safeParse(generateGroundTruth(1101)).success).toBe(true);
  });
});

describe("generateGroundTruth(1101) structure", () => {
  const gt = generateGroundTruth(1101);

  it("has 12 teams, each having played 22", () => {
    expect(gt.teams).toHaveLength(12);
    for (const team of gt.teams) {
      expect(team.played).toBe(22);
    }
  });

  it("keeps W+D+L == played and points == 3*wins + draws", () => {
    for (const team of gt.teams) {
      expect(team.wins + team.draws + team.losses).toBe(22);
      expect(team.points).toBe(3 * team.wins + team.draws);
    }
  });

  it("has total goalsFor equal to total goalsAgainst", () => {
    const totalFor = gt.teams.reduce((a, t) => a + t.goalsFor, 0);
    const totalAgainst = gt.teams.reduce((a, t) => a + t.goalsAgainst, 0);
    expect(totalFor).toBe(totalAgainst);
  });

  it("sorts teams by points desc, GD desc, GF desc, name asc", () => {
    for (let i = 1; i < gt.teams.length; i++) {
      const prev = gt.teams[i - 1]!;
      const cur = gt.teams[i]!;
      const prevKey = [
        -prev.points,
        -(prev.goalsFor - prev.goalsAgainst),
        -prev.goalsFor
      ];
      const curKey = [-cur.points, -(cur.goalsFor - cur.goalsAgainst), -cur.goalsFor];
      // Lexicographic non-decreasing on the descending keys, name breaks ties.
      const cmp =
        prevKey[0]! - curKey[0]! ||
        prevKey[1]! - curKey[1]! ||
        prevKey[2]! - curKey[2]! ||
        prev.name.localeCompare(cur.name);
      expect(cmp).toBeLessThanOrEqual(0);
    }
  });

  it("has 6 fixtures where every team appears exactly once", () => {
    expect(gt.fixtures).toHaveLength(6);
    const appearances = gt.fixtures.flatMap((f) => [f.homeTeam, f.awayTeam]);
    expect(appearances).toHaveLength(12);
    expect(new Set(appearances).size).toBe(12);
  });

  it("keeps all odds within [1.01, 51]", () => {
    for (const m of gt.markets) {
      const odds = [
        m.oneXTwo.home,
        m.oneXTwo.draw,
        m.oneXTwo.away,
        m.totals.over,
        m.totals.under
      ];
      for (const o of odds) {
        expect(o).toBeGreaterThanOrEqual(1.01);
        expect(o).toBeLessThanOrEqual(51);
      }
    }
  });

  it("keeps each market's 1X2 implied sum within [1.02, 1.10]", () => {
    for (const m of gt.markets) {
      const impliedSum = 1 / m.oneXTwo.home + 1 / m.oneXTwo.draw + 1 / m.oneXTwo.away;
      expect(impliedSum).toBeGreaterThanOrEqual(1.02);
      expect(impliedSum).toBeLessThanOrEqual(1.1);
    }
  });

  it("has trueProbabilities that sum to 1 and over25 in (0,1)", () => {
    for (const tp of gt.trueProbabilities) {
      expect(tp.home + tp.draw + tp.away).toBeCloseTo(1, 6);
      expect(tp.over25).toBeGreaterThan(0);
      expect(tp.over25).toBeLessThan(1);
    }
  });
});
