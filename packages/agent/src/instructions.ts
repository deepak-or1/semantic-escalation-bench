/**
 * Single-source registry of EVERY fixed instruction string this repo sends to a
 * model (Wave F F1). Before this file the literals were scattered across the two
 * semantic engines, and runner.ts kept a hand-maintained "keep in sync" MIRROR
 * of the hybrid's repair prompts to feed the provenance `promptsHash` — a live
 * drift hazard. Now the literals live here exactly once, both engines import
 * them (so the strings are shared by REFERENCE, never copied), and the
 * provenance hash is computed over `FROZEN_INSTRUCTIONS` so it can never miss a
 * prompt or hash a stale copy.
 *
 * Two strings are genuinely shared across the two engines and are therefore a
 * single constant referenced from both call sites (documented at each constant):
 *   - CONSENT_ACCEPT_INSTRUCTION
 *   - REVEAL_STANDINGS_INSTRUCTION
 * The baseline engine is fully deterministic and contributes no instructions.
 */

// ── Extraction instructions (stagehand extract + hybrid extract-repair) ───────
// Column/label driven so they survive class drift, column shuffles and copy
// drift with no DOM coupling. The hybrid engine's key-gated extraction repair
// reuses these IDENTICAL constants so its LLM fallback matches stagehand's
// semantics exactly.
export const STATS_INSTRUCTION =
  "Extract every team row from the league standings shown on this page. " +
  "Map columns BY THEIR HEADER NAMES (the column order varies): P/Played -> played, " +
  "W -> wins, D -> draws, L -> losses, GF -> goalsFor, GA -> goalsAgainst, Pts -> points, " +
  "Form -> form (a string like WWDLW). Numbers must be integers exactly as displayed, " +
  "including negative numbers. If a cell shows a dash, N/A, or anything unreadable as a " +
  "number, use null. Include every visible team.";

export const ODDS_INSTRUCTION =
  "Extract every fixture row from the odds board. Each row has a match like " +
  "'Home Team vs Away Team' -> homeTeam/awayTeam, a kickoff time -> kickoff, and odds cells. " +
  "Copy each odds value VERBATIM as the page displays it, as a string: decimal like '2.20' or " +
  "American like '+154' or '-120'. The three main odds are homeOdds (1), drawOdds (X), " +
  "awayOdds (2); the totals columns are overOdds and underOdds with totalsLine '2.5'. " +
  "Use null for any cell showing a dash or no value.";

// ── Shared session-blocker instructions (identical literal used by BOTH engines) ─
/** Consent wall: stagehand acts it; the hybrid observes it during repair. */
export const CONSENT_ACCEPT_INSTRUCTION =
  "accept the cookie consent so the page content is shown";
/** Hidden standings table: stagehand observes it; the hybrid repairs from it. */
export const REVEAL_STANDINGS_INSTRUCTION =
  "find the tab or control that reveals the full season standings table";

// ── Stagehand engine inline act/observe instructions ──────────────────────────
export const STAGEHAND_LOGIN_USERNAME_INSTRUCTION =
  "type %username% into the username field";
export const STAGEHAND_LOGIN_PASSWORD_INSTRUCTION =
  "type %password% into the password field";
export const STAGEHAND_LOGIN_SUBMIT_INSTRUCTION =
  "click the sign-in/submit button of the login form";
export const STAGEHAND_DISMISS_MODAL_INSTRUCTION = "close the popup dialog";
export const STAGEHAND_REVEAL_TABLE_CLICK_INSTRUCTION =
  "click the tab that reveals the full season standings table";
export const STAGEHAND_NEXT_PAGE_INSTRUCTION = "go to the next page of the standings table";

// ── Hybrid engine key-gated repair instructions (observe re-discovery) ────────
export const HYBRID_REPAIR_USERNAME_INSTRUCTION =
  "find the username text field of the login form";
export const HYBRID_REPAIR_PASSWORD_INSTRUCTION = "find the password field of the login form";
export const HYBRID_REPAIR_LOGIN_SUBMIT_INSTRUCTION =
  "find the sign-in / submit button of the login form";
export const HYBRID_REPAIR_DISMISS_MODAL_INSTRUCTION =
  "close the popup dialog blocking the page";
export const HYBRID_REPAIR_NEXT_PAGE_INSTRUCTION =
  "find the control that advances to the next page of the standings table";

/**
 * The canonical, stable-keyed registry of every fixed instruction string sent to
 * a model. `runner.ts` hashes this (sorted by key) into `environment.promptsHash`
 * so the provenance hash pins the complete prompt surface: both engines'
 * extraction prompts plus the stagehand act/observe instructions and the hybrid's
 * repair instructions. Each constant appears exactly once; the two cross-engine
 * shared strings (consent-accept, reveal-standings-table) are single entries.
 */
export const FROZEN_INSTRUCTIONS: Record<string, string> = {
  "stats-extraction": STATS_INSTRUCTION,
  "odds-extraction": ODDS_INSTRUCTION,
  "consent-accept": CONSENT_ACCEPT_INSTRUCTION,
  "reveal-standings-table": REVEAL_STANDINGS_INSTRUCTION,
  "stagehand-login-username": STAGEHAND_LOGIN_USERNAME_INSTRUCTION,
  "stagehand-login-password": STAGEHAND_LOGIN_PASSWORD_INSTRUCTION,
  "stagehand-login-submit": STAGEHAND_LOGIN_SUBMIT_INSTRUCTION,
  "stagehand-dismiss-modal": STAGEHAND_DISMISS_MODAL_INSTRUCTION,
  "stagehand-reveal-table-click": STAGEHAND_REVEAL_TABLE_CLICK_INSTRUCTION,
  "stagehand-next-page": STAGEHAND_NEXT_PAGE_INSTRUCTION,
  "hybrid-repair-username": HYBRID_REPAIR_USERNAME_INSTRUCTION,
  "hybrid-repair-password": HYBRID_REPAIR_PASSWORD_INSTRUCTION,
  "hybrid-repair-login-submit": HYBRID_REPAIR_LOGIN_SUBMIT_INSTRUCTION,
  "hybrid-repair-dismiss-modal": HYBRID_REPAIR_DISMISS_MODAL_INSTRUCTION,
  "hybrid-repair-next-page": HYBRID_REPAIR_NEXT_PAGE_INSTRUCTION
};
