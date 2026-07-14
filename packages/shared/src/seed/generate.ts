import type { ChaosFlag } from "../chaos";
import { decimalToAmerican, formatAmerican } from "../odds";
import {
  createRng,
  hashSeed,
  poissonSample,
  rngDistinctIndices,
  rngFloat,
  rngInt,
  type Rng
} from "../rng";
import type {
  DisplayOverride,
  Fixture,
  FixtureMarket,
  GroundTruth,
  TeamSeasonStats,
  TrueProbability
} from "../schemas/domain";

/**
 * Deterministic fake-league generator. Fictional teams, a simulated
 * double round-robin season, one upcoming round of fixtures, and bookmaker
 * odds derived from the generator's TRUE scoring rates with seeded noise and
 * a realistic margin — so a well-calibrated model can genuinely find "value"
 * where the noise made odds generous, and accuracy can be scored against
 * exact ground truth.
 */

const TEAM_NAMES = [
  "Ashford Rovers",
  "Bexley Town",
  "Calder United",
  "Dunmore City",
  "Eastvale Athletic",
  "Farrow Wanderers",
  "Gillside FC",
  "Harwick Albion",
  "Ironbridge FC",
  "Juniper Vale",
  "Kestrel Park",
  "Lowton Harriers"
] as const;

export const LEAGUE_NAME = "Northern Premier Division";
export const LEAGUE_SEASON = "2025/26";
const LEAGUE_AVG_GOALS = 1.32; // per team per game
const HOME_ADVANTAGE = 1.14; // multiplier on the home side's lambda
const AWAY_FACTOR = 0.9; // multiplier on the away side's lambda
const MAX_GOALS = 10;
const ONE_X_TWO_MARGIN = 0.05;
const TOTALS_MARGIN = 0.045;
const BASE_KICKOFF_MS = Date.parse("2026-07-11T12:00:00.000Z");

interface TeamRates {
  name: string;
  attack: number;
  defend: number;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function lambdas(home: TeamRates, away: TeamRates): { home: number; away: number } {
  return {
    home: LEAGUE_AVG_GOALS * home.attack * away.defend * HOME_ADVANTAGE,
    away: LEAGUE_AVG_GOALS * away.attack * home.defend * AWAY_FACTOR
  };
}

function poissonPmf(lambda: number, k: number): number {
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/**
 * Independent-Poisson score matrix probabilities. The model package
 * re-implements this independently; a test cross-checks the two agree.
 */
function matchProbabilities(lambdaHome: number, lambdaAway: number): {
  home: number;
  draw: number;
  away: number;
  over25: number;
} {
  let home = 0;
  let draw = 0;
  let away = 0;
  let under25 = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    const ph = poissonPmf(lambdaHome, h);
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = ph * poissonPmf(lambdaAway, a);
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
      if (h + a <= 2) under25 += p;
    }
  }
  const total = home + draw + away;
  return {
    home: home / total,
    draw: draw / total,
    away: away / total,
    over25: 1 - under25 / total
  };
}

/** Round-robin schedule via the circle method. Returns rounds of [home, away] index pairs. */
function circleSchedule(n: number): Array<Array<readonly [number, number]>> {
  const teams = Array.from({ length: n }, (_, i) => i);
  const rounds: Array<Array<readonly [number, number]>> = [];
  const rest = teams.slice(1);
  for (let r = 0; r < n - 1; r++) {
    const pairs: Array<readonly [number, number]> = [];
    const lineup = [teams[0] as number, ...rest];
    for (let i = 0; i < n / 2; i++) {
      const a = lineup[i] as number;
      const b = lineup[n - 1 - i] as number;
      // Alternate home/away by round parity so home counts stay balanced.
      pairs.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    rest.unshift(rest.pop() as number);
  }
  return rounds;
}

/** Noisy bookmaker odds from fair probabilities, with a fixed overround. */
function toOdds(probs: number[], margin: number, rng: Rng): number[] {
  const noisy = probs.map((p) => p * (1 + rngFloat(rng, -0.06, 0.06)));
  const total = noisy.reduce((acc, p) => acc + p, 0);
  return noisy.map((p) => {
    const implied = (p / total) * (1 + margin);
    const decimal = Math.round((1 / implied) * 100) / 100;
    return Math.min(Math.max(decimal, 1.01), 51);
  });
}

export function generateGroundTruth(seed: number): GroundTruth {
  const rng = createRng(hashSeed(`league:${seed}`));
  const rates: TeamRates[] = TEAM_NAMES.map((name) => ({
    name,
    attack: rngFloat(rng, 0.78, 1.32),
    defend: rngFloat(rng, 0.78, 1.32)
  }));

  const single = circleSchedule(TEAM_NAMES.length);
  const doubleRoundRobin = [
    ...single,
    ...single.map((round) => round.map(([h, a]) => [a, h] as const))
  ];

  const table = rates.map(() => ({
    played: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    points: 0,
    results: [] as string[]
  }));

  for (const round of doubleRoundRobin) {
    for (const [hIdx, aIdx] of round) {
      const { home, away } = lambdas(rates[hIdx] as TeamRates, rates[aIdx] as TeamRates);
      const gh = poissonSample(rng, home);
      const ga = poissonSample(rng, away);
      const h = table[hIdx];
      const a = table[aIdx];
      if (!h || !a) throw new Error("generateGroundTruth: bad schedule index");
      h.played += 1;
      a.played += 1;
      h.goalsFor += gh;
      h.goalsAgainst += ga;
      a.goalsFor += ga;
      a.goalsAgainst += gh;
      if (gh > ga) {
        h.wins += 1;
        h.points += 3;
        a.losses += 1;
        h.results.push("W");
        a.results.push("L");
      } else if (gh < ga) {
        a.wins += 1;
        a.points += 3;
        h.losses += 1;
        h.results.push("L");
        a.results.push("W");
      } else {
        h.draws += 1;
        a.draws += 1;
        h.points += 1;
        a.points += 1;
        h.results.push("D");
        a.results.push("D");
      }
    }
  }

  const teams: TeamSeasonStats[] = rates
    .map((r, i) => {
      const t = table[i];
      if (!t) throw new Error("generateGroundTruth: missing table row");
      return {
        id: slug(r.name),
        name: r.name,
        played: t.played,
        wins: t.wins,
        draws: t.draws,
        losses: t.losses,
        goalsFor: t.goalsFor,
        goalsAgainst: t.goalsAgainst,
        points: t.points,
        form: t.results.slice(-5).join("")
      };
    })
    .sort((x, y) => {
      const gdX = x.goalsFor - x.goalsAgainst;
      const gdY = y.goalsFor - y.goalsAgainst;
      return (
        y.points - x.points ||
        gdY - gdX ||
        y.goalsFor - x.goalsFor ||
        x.name.localeCompare(y.name)
      );
    });

  // One upcoming round of fixtures (every team plays once).
  const nextRound = single[seed % single.length];
  if (!nextRound) throw new Error("generateGroundTruth: no round");
  const fixtures: Fixture[] = nextRound.map(([hIdx, aIdx], i) => {
    const home = TEAM_NAMES[hIdx] as string;
    const away = TEAM_NAMES[aIdx] as string;
    return {
      id: `${slug(home)}-vs-${slug(away)}`,
      homeTeam: home,
      awayTeam: away,
      kickoff: new Date(BASE_KICKOFF_MS + i * 90 * 60 * 1000).toISOString()
    };
  });

  const markets: FixtureMarket[] = [];
  const trueProbabilities: TrueProbability[] = [];
  for (const fixture of fixtures) {
    const home = rates.find((r) => r.name === fixture.homeTeam);
    const away = rates.find((r) => r.name === fixture.awayTeam);
    if (!home || !away) throw new Error("generateGroundTruth: unknown fixture team");
    const lam = lambdas(home, away);
    const probs = matchProbabilities(lam.home, lam.away);
    const [h, d, a] = toOdds([probs.home, probs.draw, probs.away], ONE_X_TWO_MARGIN, rng);
    const [over, under] = toOdds([probs.over25, 1 - probs.over25], TOTALS_MARGIN, rng);
    markets.push({
      fixtureId: fixture.id,
      homeTeam: fixture.homeTeam,
      awayTeam: fixture.awayTeam,
      kickoff: fixture.kickoff,
      oneXTwo: { home: h as number, draw: d as number, away: a as number },
      totals: { line: 2.5, over: over as number, under: under as number }
    });
    trueProbabilities.push({ fixtureId: fixture.id, ...probs });
  }

  return {
    seed,
    league: {
      name: LEAGUE_NAME,
      season: LEAGUE_SEASON,
      avgGoalsPerTeamPerGame: LEAGUE_AVG_GOALS,
      trueHomeAdvantage: HOME_ADVANTAGE
    },
    teams,
    fixtures,
    markets,
    trueProbabilities
  };
}

/**
 * Cells the lab must display differently from ground truth for the
 * partialData / corruptData chaos flags. Deterministic per seed. The lab
 * renders `displayed` verbatim; the benchmark scorer treats `partial` cells
 * as expected-null and excludes `corrupt` cells from accuracy.
 */
export function computeDisplayOverrides(
  truth: GroundTruth,
  chaos: readonly ChaosFlag[],
  seed: number
): DisplayOverride[] {
  const overrides: DisplayOverride[] = [];

  if (chaos.includes("partialData")) {
    const rng = createRng(hashSeed(`partial:${seed}`));
    for (const idx of rngDistinctIndices(rng, truth.teams.length, 3)) {
      const team = truth.teams[idx];
      if (!team) continue;
      overrides.push({
        page: "stats",
        rowKey: team.name,
        field: "goalsAgainst",
        displayed: "—",
        kind: "partial"
      });
    }
    const market = truth.markets[rngInt(rng, 0, truth.markets.length - 1)];
    if (market) {
      overrides.push({
        page: "odds",
        rowKey: `${market.homeTeam}|${market.awayTeam}`,
        field: "underOdds",
        displayed: "—",
        kind: "partial"
      });
    }
  }

  if (chaos.includes("corruptData")) {
    const rng = createRng(hashSeed(`corrupt:${seed}`));
    const [i0, i1, i2] = rngDistinctIndices(rng, truth.teams.length, 3);
    const t0 = truth.teams[i0 as number];
    const t1 = truth.teams[i1 as number];
    const t2 = truth.teams[i2 as number];
    if (t0) {
      // W+D+L no longer adds up to played — an honest extractor preserves it,
      // and the domain consistency check must catch it.
      overrides.push({
        page: "stats",
        rowKey: t0.name,
        field: "wins",
        displayed: String(t0.played + 8),
        kind: "corrupt"
      });
    }
    if (t1) {
      overrides.push({
        page: "stats",
        rowKey: t1.name,
        field: "played",
        displayed: "-3",
        kind: "corrupt"
      });
    }
    if (t2) {
      overrides.push({
        page: "stats",
        rowKey: t2.name,
        field: "goalsFor",
        displayed: "N/A",
        kind: "corrupt"
      });
    }
    const market = truth.markets[rngInt(rng, 0, truth.markets.length - 1)];
    if (market) {
      const rowKey = `${market.homeTeam}|${market.awayTeam}`;
      overrides.push(
        { page: "odds", rowKey, field: "homeOdds", displayed: "n/a", kind: "corrupt" },
        { page: "odds", rowKey, field: "drawOdds", displayed: "0.62", kind: "corrupt" }
      );
    }
  }

  return overrides;
}

/** What the lab should print in a stats cell, override-aware. */
export function displayedStatsCell(
  team: TeamSeasonStats,
  field: "played" | "wins" | "draws" | "losses" | "goalsFor" | "goalsAgainst" | "points" | "form" | "name",
  overrides: readonly DisplayOverride[]
): string {
  const hit = overrides.find(
    (o) => o.page === "stats" && o.rowKey === team.name && o.field === field
  );
  if (hit) return hit.displayed;
  const value = field === "name" ? team.name : team[field];
  return String(value);
}

/** What the lab should print in an odds cell, override- and format-aware. */
export function displayedOddsCell(
  market: FixtureMarket,
  field: "homeOdds" | "drawOdds" | "awayOdds" | "overOdds" | "underOdds",
  overrides: readonly DisplayOverride[],
  american: boolean
): string {
  const rowKey = `${market.homeTeam}|${market.awayTeam}`;
  const hit = overrides.find(
    (o) => o.page === "odds" && o.rowKey === rowKey && o.field === field
  );
  if (hit) return hit.displayed;
  const decimal = {
    homeOdds: market.oneXTwo.home,
    drawOdds: market.oneXTwo.draw,
    awayOdds: market.oneXTwo.away,
    overOdds: market.totals.over,
    underOdds: market.totals.under
  }[field];
  return american ? formatAmerican(decimalToAmerican(decimal)) : decimal.toFixed(2);
}
