import { describe, expect, it } from "vitest";
import { forecastMatch } from "./forecast";
import type { TeamStrength } from "./strengths";

function strength(name: string, over: Partial<TeamStrength> = {}): TeamStrength {
  return { name, attack: 1, defend: 1, formFactor: 1, notes: [], ...over };
}

describe("forecastMatch", () => {
  it("produces coherent probability groups", () => {
    const f = forecastMatch(
      strength("Home", { attack: 1.3, defend: 0.9 }),
      strength("Away", { attack: 1.1, defend: 1.2 })
    );
    expect(f.probs.home + f.probs.draw + f.probs.away).toBeCloseTo(1, 9);
    expect(f.probs.over25 + f.probs.under25).toBeCloseTo(1, 9);
  });

  it("is symmetric when there is no home/away asymmetry", () => {
    const both = { attack: 1.2, defend: 0.9 };
    const f = forecastMatch(
      strength("Home", both),
      strength("Away", both),
      { homeAdvantage: 1, awayFactor: 1, formWeight: 0 }
    );
    expect(f.lambdaHome).toBeCloseTo(f.lambdaAway, 12);
    expect(f.probs.home).toBeCloseTo(f.probs.away, 9);
  });

  it("raising home advantage raises the home win probability", () => {
    const home = strength("Home", { attack: 1.1, defend: 1.0 });
    const away = strength("Away", { attack: 1.1, defend: 1.0 });
    const low = forecastMatch(home, away, { homeAdvantage: 1.0, awayFactor: 1.0 });
    const high = forecastMatch(home, away, { homeAdvantage: 1.4, awayFactor: 1.0 });
    expect(high.probs.home).toBeGreaterThan(low.probs.home);
  });

  it("agrees with an independent brute-force score matrix for lambda 1.7/1.1", () => {
    // Craft strengths so lambdaHome=1.7, lambdaAway=1.1 exactly with unit params.
    const home = strength("H", { attack: 1.7, defend: 1 });
    const away = strength("A", { attack: 1.1, defend: 1 });
    const params = { leagueAvgGoals: 1, homeAdvantage: 1, awayFactor: 1, maxGoals: 10 };
    const f = forecastMatch(home, away, params);
    expect(f.lambdaHome).toBeCloseTo(1.7, 12);
    expect(f.lambdaAway).toBeCloseTo(1.1, 12);

    const fact = (k: number): number => {
      let r = 1;
      for (let i = 2; i <= k; i++) r *= i;
      return r;
    };
    const pmf = (lambda: number, k: number): number =>
      (Math.exp(-lambda) * Math.pow(lambda, k)) / fact(k);

    const lh = 1.7;
    const la = 1.1;
    let bh = 0;
    let bd = 0;
    let ba = 0;
    let bu = 0;
    let total = 0;
    for (let h = 0; h <= 10; h++) {
      for (let a = 0; a <= 10; a++) {
        const p = pmf(lh, h) * pmf(la, a);
        total += p;
        if (h > a) bh += p;
        else if (h === a) bd += p;
        else ba += p;
        if (h + a <= 2) bu += p;
      }
    }
    expect(f.probs.home).toBeCloseTo(bh / total, 9);
    expect(f.probs.draw).toBeCloseTo(bd / total, 9);
    expect(f.probs.away).toBeCloseTo(ba / total, 9);
    expect(f.probs.over25).toBeCloseTo(1 - bu / total, 9);
  });
});
