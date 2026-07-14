import { describe, expect, it } from "vitest";
import {
  CONSENT_ACCEPT_INSTRUCTION,
  FROZEN_INSTRUCTIONS,
  ODDS_INSTRUCTION,
  REVEAL_STANDINGS_INSTRUCTION,
  STATS_INSTRUCTION
} from "./instructions";
import {
  ODDS_INSTRUCTION as STAGEHAND_ODDS_INSTRUCTION,
  STATS_INSTRUCTION as STAGEHAND_STATS_INSTRUCTION
} from "./stagehand/engine";

// The stable key set of the frozen instruction registry. Pinned here so adding,
// dropping, or renaming a fixed instruction string is a deliberate edit that
// updates this list (and, by design, moves environment.promptsHash).
const EXPECTED_KEYS = [
  "consent-accept",
  "hybrid-repair-dismiss-modal",
  "hybrid-repair-login-submit",
  "hybrid-repair-next-page",
  "hybrid-repair-password",
  "hybrid-repair-username",
  "odds-extraction",
  "reveal-standings-table",
  "stagehand-dismiss-modal",
  "stagehand-login-password",
  "stagehand-login-submit",
  "stagehand-login-username",
  "stagehand-next-page",
  "stagehand-reveal-table-click",
  "stats-extraction"
];

describe("FROZEN_INSTRUCTIONS", () => {
  it("has exactly the expected keys", () => {
    expect(Object.keys(FROZEN_INSTRUCTIONS).slice().sort()).toEqual(EXPECTED_KEYS);
    expect(Object.keys(FROZEN_INSTRUCTIONS)).toHaveLength(15);
  });

  it("maps every key to a nonempty string", () => {
    for (const [key, value] of Object.entries(FROZEN_INSTRUCTIONS)) {
      expect(typeof value, key).toBe("string");
      expect(value.trim().length, key).toBeGreaterThan(0);
    }
  });

  it("has no duplicate values — cross-engine shared strings are single constants", () => {
    // The two literals both engines send (consent-accept, reveal-standings-table)
    // are represented ONCE, by a single shared constant referenced from both call
    // sites, so the registry deliberately holds no duplicate values.
    const values = Object.values(FROZEN_INSTRUCTIONS);
    expect(new Set(values).size).toBe(values.length);

    // Assert the intentional shares explicitly: each shared literal appears in the
    // registry exactly once, under its shared key.
    expect(FROZEN_INSTRUCTIONS["consent-accept"]).toBe(CONSENT_ACCEPT_INSTRUCTION);
    expect(FROZEN_INSTRUCTIONS["reveal-standings-table"]).toBe(REVEAL_STANDINGS_INSTRUCTION);
    expect(values.filter((v) => v === CONSENT_ACCEPT_INSTRUCTION)).toHaveLength(1);
    expect(values.filter((v) => v === REVEAL_STANDINGS_INSTRUCTION)).toHaveLength(1);
  });

  it("includes STATS/ODDS extraction prompts by identity with the stagehand re-exports", () => {
    // Same binding all the way through: registry === instructions module ===
    // stagehand/engine re-export. No copies that could silently drift.
    expect(FROZEN_INSTRUCTIONS["stats-extraction"]).toBe(STATS_INSTRUCTION);
    expect(FROZEN_INSTRUCTIONS["odds-extraction"]).toBe(ODDS_INSTRUCTION);
    expect(STATS_INSTRUCTION).toBe(STAGEHAND_STATS_INSTRUCTION);
    expect(ODDS_INSTRUCTION).toBe(STAGEHAND_ODDS_INSTRUCTION);
  });
});
