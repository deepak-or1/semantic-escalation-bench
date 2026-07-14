import type { ExtractedOddsRow, ExtractedStatsRow } from "@ssda/shared";

/*
 * ── THE BRITTLENESS CONTRACT (deliberate) ──────────────────────────────────
 * This engine is a period-accurate, pre-LLM selector scraper. It is genuinely
 * competent — it waits, retries, reuses sessions, paginates, opens tabs, clears
 * consent/modal overlays and recovers from a mid-flow re-login — but it is tuned
 * to the lab's DEFAULT DOM and addresses the page ONLY through hardcoded ids and
 * FIXED column positions. It never reads a header to map a column and never
 * falls back to a structural/text heuristic. That single assumption is its one
 * weakness, and it is intentional: it lets us measure, honestly, how a
 * competent-but-static scraper degrades under the same chaos an LLM agent is
 * asked to survive.
 *
 * Element hooks (default-DOM ids only):
 *   auth      #login-form #username #password #login-submit
 *   consent   #accept-cookies
 *   modal     #newsletter-modal #modal-close
 *   stats     #standings (tbody tr) · #tab-table · #table-data (row island) · pager: #next-page #page-indicator
 *   odds      #odds-table (tbody tr)
 *
 * Column positions are read by FIXED <td> index from the default order and are
 * NEVER remapped from the header text:
 *   stats  [#, Team, P, W, D, L, GF, GA, GD, Pts, Form] -> td 0..10
 *   odds   [Kickoff, Match, 1, X, 2, Over 2.5, Under 2.5] -> td 0..6
 *
 * Consequences (this IS the experiment): under classDrift the ids vanish and the
 * hooks match nothing; under columnShuffle the fixed indices silently point at
 * the wrong fields and core's domain validation catches the inconsistency; under
 * layoutVariant there is no <table> for #standings / #odds-table to match at all.
 */

export const SELECTORS = {
  loginForm: "#login-form",
  username: "#username",
  password: "#password",
  loginSubmit: "#login-submit",
  acceptCookies: "#accept-cookies",
  modal: "#newsletter-modal",
  modalClose: "#modal-close",
  statsRows: "#standings tbody tr",
  tabTable: "#tab-table",
  tableData: "#table-data",
  nextPage: "#next-page",
  pageIndicator: "#page-indicator",
  oddsRows: "#odds-table tbody tr"
} as const;

const INTEGER = /^-?\d+$/;

function cellText(cells: readonly string[], index: number): string {
  return (cells[index] ?? "").trim();
}

/**
 * Parse a cell to an integer ONLY when it is exactly an integer token; anything
 * else (an em-dash, "N/A", a blank, a stray letter) becomes null. We extract
 * what the page shows and never guess — a displayed "-3" is parsed as -3 and a
 * displayed "—" is null. All data-quality judgement lives in core.
 */
export function parseIntCell(text: string | undefined): number | null {
  const t = (text ?? "").trim();
  return INTEGER.test(t) ? Number.parseInt(t, 10) : null;
}

/** Map one stats <tr>'s cell texts to an ExtractedStatsRow by FIXED index. */
export function toStatsRow(cells: readonly string[]): ExtractedStatsRow {
  const form = cellText(cells, 10).replace(/\s+/g, "");
  return {
    team: cellText(cells, 1),
    played: parseIntCell(cells[2]),
    wins: parseIntCell(cells[3]),
    draws: parseIntCell(cells[4]),
    losses: parseIntCell(cells[5]),
    goalsFor: parseIntCell(cells[6]),
    goalsAgainst: parseIntCell(cells[7]),
    // cells[8] is GD (goal difference) — deliberately not part of the schema.
    points: parseIntCell(cells[9]),
    form: form.length > 0 ? form : null
  };
}

/** Map one odds <tr>'s cell texts to an ExtractedOddsRow by FIXED index. */
export function toOddsRow(cells: readonly string[]): ExtractedOddsRow {
  const oddsCell = (index: number): string | null => {
    const t = cellText(cells, index);
    return t.length > 0 ? t : null;
  };
  const match = cellText(cells, 1);
  const parts = match.split(" vs ");
  const [homeTeam, awayTeam] =
    parts.length === 2 ? [parts[0] ?? "", parts[1] ?? ""] : [match, ""];
  return {
    kickoff: cellText(cells, 0),
    homeTeam,
    awayTeam,
    homeOdds: oddsCell(2),
    drawOdds: oddsCell(3),
    awayOdds: oddsCell(4),
    overOdds: oddsCell(5),
    underOdds: oddsCell(6),
    totalsLine: "2.5"
  };
}

/** Concatenate row batches, keeping the FIRST occurrence of each team name. */
export function dedupeByTeam(rows: readonly ExtractedStatsRow[]): ExtractedStatsRow[] {
  const seen = new Set<string>();
  const out: ExtractedStatsRow[] = [];
  for (const row of rows) {
    const key = row.team.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** Total page count from a "Page X of N" indicator; 1 when absent/unparseable. */
export function totalPagesFrom(indicator: string | null): number {
  if (!indicator) return 1;
  const match = indicator.match(/Page\s+(\d+)\s+of\s+(\d+)/);
  if (!match) return 1;
  const n = Number.parseInt(match[2] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
