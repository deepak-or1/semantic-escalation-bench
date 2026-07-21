import { hashSeed } from "@ssda/shared";
import { at } from "./markup";

/** Per-key UI-copy override (PROTOCOL_2A §3, Stratum K `uiCopy`). */
export type UiCopyOverrides = Partial<Record<keyof typeof COPY_TABLE, string>>;

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

/**
 * Resolve the visible copy. `overrides` (Stratum K `uiCopy`) wins per key; absent
 * keys fall back to the copyDrift variant (or the default at variant 0). The §3
 * flag-XOR-param rule already forbids copyDrift + uiCopy together, so in practice
 * a run is either drifting OR overriding, never both — but the fallback is written
 * so any present override always takes precedence over whatever variant is active.
 */
export function getCopy(seed: number, driftOn: boolean, overrides?: UiCopyOverrides): Copy {
  const variant = driftOn ? hashSeed(`copy:${seed}`) % 3 : 0;
  const pick = (key: keyof typeof COPY_TABLE): string =>
    overrides?.[key] ?? at(COPY_TABLE[key], variant);
  return {
    siteName: pick("siteName"),
    statsHeading: pick("statsHeading"),
    oddsHeading: pick("oddsHeading"),
    loginHeading: pick("loginHeading"),
    loginButton: pick("loginButton"),
    fullTableTab: pick("fullTableTab"),
    nextButton: pick("nextButton"),
    prevButton: pick("prevButton"),
    acceptCookies: pick("acceptCookies")
  };
}
