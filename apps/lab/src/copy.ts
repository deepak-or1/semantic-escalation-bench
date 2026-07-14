import { hashSeed } from "@ssda/shared";
import { at } from "./markup";

/**
 * copyDrift chaos rotates headings, labels and button text between three
 * synonym variants (index 0 is the default). Column headers never drift.
 */
const COPY_TABLE = {
  siteName: ["NP Stats Hub", "Northern Stats Desk", "NPD Analytics"],
  statsHeading: ["League Standings", "League Table", "Season Standings"],
  oddsHeading: ["Match Odds", "Fixture Prices", "Betting Board"],
  loginHeading: ["Sign in", "Log in", "Member access"],
  loginButton: ["Sign in", "Continue", "Access dashboard"],
  fullTableTab: ["Full table", "All teams", "Season stats"],
  nextButton: ["Next", "More", "Older"],
  prevButton: ["Prev", "Back", "Newer"],
  acceptCookies: ["Accept all", "Agree & continue", "Allow cookies"]
} as const;

export type Copy = { [K in keyof typeof COPY_TABLE]: string };

export function getCopy(seed: number, driftOn: boolean): Copy {
  const variant = driftOn ? hashSeed(`copy:${seed}`) % 3 : 0;
  return {
    siteName: at(COPY_TABLE.siteName, variant),
    statsHeading: at(COPY_TABLE.statsHeading, variant),
    oddsHeading: at(COPY_TABLE.oddsHeading, variant),
    loginHeading: at(COPY_TABLE.loginHeading, variant),
    loginButton: at(COPY_TABLE.loginButton, variant),
    fullTableTab: at(COPY_TABLE.fullTableTab, variant),
    nextButton: at(COPY_TABLE.nextButton, variant),
    prevButton: at(COPY_TABLE.prevButton, variant),
    acceptCookies: at(COPY_TABLE.acceptCookies, variant)
  };
}
