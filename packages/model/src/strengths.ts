import type { NormalizedTeamStats } from "@ssda/shared";
import { clamp, resolveParams, type ModelParams } from "./params";

/**
 * Attack/defend are ratios relative to the observed league scoring rate
 * (1.0 = league-average); formFactor nudges lambda by recent results.
 */
export interface TeamStrength {
  name: string;
  attack: number;
  defend: number;
  formFactor: number;
  notes: string[];
}

export interface StrengthDerivation {
  strengths: Map<string, TeamStrength>;
  leagueAvgObserved: number;
  notes: string[];
}

const RATIO_MIN = 0.25;
const RATIO_MAX = 4;
// Midpoint / span of the 3-1-0 points scale over five results (0..15, mean 7.5).
const FORM_MID = 7.5;
const FORM_SPAN = 15;

function formPoints(form: string): number {
  let points = 0;
  for (const ch of form) {
    if (ch === "W") points += 3;
    else if (ch === "D") points += 1;
  }
  return points;
}

/**
 * A team is usable (contributes to the observed league average) when it has
 * played at least one game and its goals-for was actually read off the page.
 */
export function deriveStrengths(
  teams: NormalizedTeamStats[],
  params?: Partial<ModelParams>
): StrengthDerivation {
  const resolved = resolveParams(params);
  const notes: string[] = [];

  const usable = teams.filter((t) => t.played > 0 && t.goalsFor !== null);
  if (usable.length < 2) {
    throw new Error(
      `deriveStrengths: need at least 2 usable teams (played > 0 with goals-for data), found ${usable.length}`
    );
  }

  const totalGoalsFor = usable.reduce((acc, t) => acc + (t.goalsFor ?? 0), 0);
  const totalPlayed = usable.reduce((acc, t) => acc + t.played, 0);
  let leagueAvgObserved = totalGoalsFor / totalPlayed;
  if (!(leagueAvgObserved > 0)) {
    leagueAvgObserved = resolved.leagueAvgGoals;
    notes.push(
      `observed league average was non-positive; fell back to leagueAvgGoals=${resolved.leagueAvgGoals}`
    );
  }

  const strengths = new Map<string, TeamStrength>();
  for (const team of teams) {
    const teamNotes: string[] = [];

    let attack: number;
    if (team.goalsFor === null || team.played <= 0) {
      attack = 1;
      teamNotes.push(`${team.name}: no goals-for data, using neutral attack prior (1.0)`);
    } else {
      attack = clamp(team.goalsFor / team.played / leagueAvgObserved, RATIO_MIN, RATIO_MAX);
    }

    let defend: number;
    if (team.goalsAgainst === null || team.played <= 0) {
      defend = 1;
      teamNotes.push(`${team.name}: no goals-against data, using neutral defend prior (1.0)`);
    } else {
      defend = clamp(team.goalsAgainst / team.played / leagueAvgObserved, RATIO_MIN, RATIO_MAX);
    }

    let formFactor = 1;
    if (team.form && team.form.length > 0) {
      formFactor = 1 + resolved.formWeight * ((formPoints(team.form) - FORM_MID) / FORM_SPAN);
    }

    strengths.set(team.name, { name: team.name, attack, defend, formFactor, notes: teamNotes });
  }

  return { strengths, leagueAvgObserved, notes };
}
