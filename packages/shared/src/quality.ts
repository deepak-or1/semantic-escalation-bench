import type { NormalizedDataset } from "./schemas/domain";

export interface QualityAssessment {
  ok: boolean;
  failures: string[];
  warnings: string[];
}

const MAX_PLAUSIBLE_PLAYED = 60;
const MAX_PLAUSIBLE_GOALS = 250;

/**
 * Domain-layer validation, shared by both engines and the benchmark scorer.
 * Failures are hard problems that make the dataset untrustworthy (the
 * schema-violation scenario expects exactly this to fire). Warnings are soft
 * gaps the model downgrades confidence for but can work around.
 */
export function assessDataset(dataset: NormalizedDataset): QualityAssessment {
  const failures: string[] = [...dataset.failures];
  const warnings: string[] = [...dataset.warnings];

  if (dataset.teams.length < 2) {
    failures.push(
      `too few teams extracted (${dataset.teams.length}); expected a league table`
    );
  }

  for (const team of dataset.teams) {
    if (team.played > MAX_PLAUSIBLE_PLAYED) {
      failures.push(`${team.name}: implausible played count ${team.played}`);
    }
    if (
      team.wins !== undefined &&
      team.draws !== undefined &&
      team.losses !== undefined &&
      team.wins + team.draws + team.losses !== team.played
    ) {
      failures.push(
        `${team.name}: W+D+L (${team.wins}+${team.draws}+${team.losses}) != played (${team.played})`
      );
    }
    if (team.goalsFor !== null && team.goalsFor > MAX_PLAUSIBLE_GOALS) {
      failures.push(`${team.name}: implausible goalsFor ${team.goalsFor}`);
    }
    if (team.goalsAgainst !== null && team.goalsAgainst > MAX_PLAUSIBLE_GOALS) {
      failures.push(`${team.name}: implausible goalsAgainst ${team.goalsAgainst}`);
    }
    if (team.goalsFor === null || team.goalsAgainst === null) {
      warnings.push(`${team.name}: missing ${team.missingFields.join(", ") || "fields"}`);
    }
  }

  if (dataset.markets.length > 0) {
    const cells = dataset.markets.length * 5; // H/D/A + over/under
    const present = dataset.markets.reduce((acc, m) => {
      let n = 0;
      if (m.oneXTwo) n += 3;
      if (m.totals) n += 2;
      return acc + n;
    }, 0);
    const missingRatio = 1 - present / cells;
    if (missingRatio > 0.3) {
      failures.push(
        `${Math.round(missingRatio * 100)}% of odds cells unusable — odds data untrustworthy`
      );
    }
  }

  const teamNames = new Set(dataset.teams.map((t) => t.name.toLowerCase().trim()));
  for (const market of dataset.markets) {
    for (const side of [market.homeTeam, market.awayTeam]) {
      if (!teamNames.has(side.toLowerCase().trim())) {
        warnings.push(`odds row references unknown team "${side}"`);
      }
    }
  }

  const deduped = (xs: string[]) => [...new Set(xs)];
  return {
    ok: failures.length === 0,
    failures: deduped(failures),
    warnings: deduped(warnings)
  };
}
