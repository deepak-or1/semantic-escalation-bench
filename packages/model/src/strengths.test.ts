import type { NormalizedTeamStats } from "@ssda/shared";
import { describe, expect, it } from "vitest";
import { deriveStrengths } from "./strengths";

function team(over: Partial<NormalizedTeamStats> & { name: string }): NormalizedTeamStats {
  return {
    played: 10,
    goalsFor: 10,
    goalsAgainst: 10,
    missingFields: [],
    ...over
  };
}

describe("deriveStrengths", () => {
  it("computes exact attack/defend ratios from a known table", () => {
    // Total GF = 80 over 40 games -> observed average 2.0 goals per team per game.
    const teams: NormalizedTeamStats[] = [
      team({ name: "A", played: 10, goalsFor: 30, goalsAgainst: 10 }),
      team({ name: "B", played: 10, goalsFor: 10, goalsAgainst: 30 }),
      team({ name: "C", played: 10, goalsFor: 20, goalsAgainst: 20 }),
      team({ name: "D", played: 10, goalsFor: 20, goalsAgainst: 20 })
    ];
    const { strengths, leagueAvgObserved } = deriveStrengths(teams);
    expect(leagueAvgObserved).toBe(2);

    const a = strengths.get("A")!;
    const b = strengths.get("B")!;
    const c = strengths.get("C")!;
    expect(a.attack).toBe(1.5);
    expect(a.defend).toBe(0.5);
    expect(b.attack).toBe(0.5);
    expect(b.defend).toBe(1.5);
    expect(c.attack).toBe(1);
    expect(c.defend).toBe(1);
  });

  it("clamps extreme ratios into [0.25, 4]", () => {
    // Observed avg = 220 goals / 50 games = 4.4. Runaway rate 20 -> attack
    // 4.5 (clamped to 4); runaway concedes nothing -> defend 0 (clamped to 0.25).
    const teams: NormalizedTeamStats[] = [
      team({ name: "Runaway", played: 10, goalsFor: 200, goalsAgainst: 0 }),
      team({ name: "Minnow1", played: 10, goalsFor: 5, goalsAgainst: 5 }),
      team({ name: "Minnow2", played: 10, goalsFor: 5, goalsAgainst: 5 }),
      team({ name: "Minnow3", played: 10, goalsFor: 5, goalsAgainst: 5 }),
      team({ name: "Minnow4", played: 10, goalsFor: 5, goalsAgainst: 5 })
    ];
    const { strengths, leagueAvgObserved } = deriveStrengths(teams);
    expect(leagueAvgObserved).toBeCloseTo(4.4, 12);
    const runaway = strengths.get("Runaway")!;
    expect(runaway.attack).toBe(4);
    expect(runaway.defend).toBe(0.25);
  });

  it("applies a neutral prior with a note when goals-for is missing", () => {
    const teams: NormalizedTeamStats[] = [
      team({ name: "Known1", goalsFor: 15, goalsAgainst: 10 }),
      team({ name: "Known2", goalsFor: 15, goalsAgainst: 20 }),
      team({ name: "Blank", goalsFor: null, goalsAgainst: 12, missingFields: ["goalsFor"] })
    ];
    const { strengths, leagueAvgObserved } = deriveStrengths(teams);
    // Blank must not skew the observed average (30 GF over 20 games = 1.5).
    expect(leagueAvgObserved).toBe(1.5);
    const blank = strengths.get("Blank")!;
    expect(blank.attack).toBe(1);
    expect(blank.notes.length).toBeGreaterThan(0);
    // goalsAgainst was present, so defend is still computed.
    expect(blank.defend).toBeCloseTo((12 / 10) / 1.5, 12);
  });

  it("derives a form factor above 1 for a strong recent run", () => {
    const teams: NormalizedTeamStats[] = [
      team({ name: "Hot", form: "WWWWW" }),
      team({ name: "Flat" })
    ];
    const { strengths } = deriveStrengths(teams);
    // 5 wins -> 15 points -> 1 + 0.25*((15-7.5)/15) = 1.125.
    expect(strengths.get("Hot")!.formFactor).toBeCloseTo(1.125, 12);
    // No form string -> neutral 1 with no note.
    expect(strengths.get("Flat")!.formFactor).toBe(1);
  });

  it("throws when fewer than 2 usable teams exist", () => {
    const teams: NormalizedTeamStats[] = [
      team({ name: "Only", goalsFor: 12 }),
      team({ name: "NoGoals", goalsFor: null, missingFields: ["goalsFor"] })
    ];
    expect(() => deriveStrengths(teams)).toThrow(/at least 2 usable teams/);
  });
});
