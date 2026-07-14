import { clamp, resolveParams, type ModelParams } from "./params";
import { poissonPmf } from "./poisson";
import type { TeamStrength } from "./strengths";

export interface MatchForecast {
  homeTeam: string;
  awayTeam: string;
  lambdaHome: number;
  lambdaAway: number;
  probs: { home: number; draw: number; away: number; over25: number; under25: number };
}

const LAMBDA_MIN = 0.1;
const LAMBDA_MAX = 6;

/**
 * Independent-Poisson score matrix. `leagueAvgGoals` in `params` is the base
 * scoring rate the caller chooses — buildWatchlist passes the observed average
 * rather than the default so lambdas are anchored to the actual season.
 */
export function forecastMatch(
  home: TeamStrength,
  away: TeamStrength,
  params?: Partial<ModelParams>
): MatchForecast {
  const p = resolveParams(params);
  const lambdaHome = clamp(
    p.leagueAvgGoals * home.attack * home.formFactor * away.defend * p.homeAdvantage,
    LAMBDA_MIN,
    LAMBDA_MAX
  );
  const lambdaAway = clamp(
    p.leagueAvgGoals * away.attack * away.formFactor * home.defend * p.awayFactor,
    LAMBDA_MIN,
    LAMBDA_MAX
  );

  const homePmf = Array.from({ length: p.maxGoals + 1 }, (_, k) => poissonPmf(lambdaHome, k));
  const awayPmf = Array.from({ length: p.maxGoals + 1 }, (_, k) => poissonPmf(lambdaAway, k));

  let home_ = 0;
  let draw = 0;
  let away_ = 0;
  let under = 0;
  let total = 0;
  for (let h = 0; h <= p.maxGoals; h++) {
    const ph = homePmf[h] as number;
    for (let a = 0; a <= p.maxGoals; a++) {
      const prob = ph * (awayPmf[a] as number);
      total += prob;
      if (h > a) home_ += prob;
      else if (h === a) draw += prob;
      else away_ += prob;
      if (h + a <= 2) under += prob;
    }
  }

  const under25 = under / total;
  return {
    homeTeam: home.name,
    awayTeam: away.name,
    lambdaHome,
    lambdaAway,
    probs: {
      home: home_ / total,
      draw: draw / total,
      away: away_ / total,
      over25: 1 - under25,
      under25
    }
  };
}
