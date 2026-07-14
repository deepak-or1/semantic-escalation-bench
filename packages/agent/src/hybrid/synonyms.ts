/**
 * General football-stats vocabulary for mapping table columns by HEADER NAME
 * rather than by fixed position. This is the hybrid engine's structure-aware
 * core: as long as a table labels its columns with a word from this dictionary,
 * a column shuffle or a copy tweak cannot make the engine read the wrong field.
 *
 * The vocabulary is fixed GENERAL football terminology — deliberately chosen
 * before looking at any lab copy variant. It is NOT tuned to make scenarios
 * pass: a header the dictionary does not cover is an honest coverage gap to
 * report, never a reason to widen the dictionary.
 *
 * Matching (see `headerMatchesSynonym`): case-insensitive, whitespace-trimmed,
 * exact-token — a synonym matches the whole header or one of its whitespace
 * tokens, never a substring. Single-letter synonyms match ONLY single-letter
 * headers, so "p" maps "P" but never "Pts".
 */

export type StatField =
  | "team"
  | "played"
  | "wins"
  | "draws"
  | "losses"
  | "goalsFor"
  | "goalsAgainst"
  | "points"
  | "form";

export const STAT_SYNONYMS: Record<StatField, readonly string[]> = {
  team: ["team", "club", "side"],
  played: ["played", "p", "pld", "games", "gp", "matches"],
  wins: ["won", "w", "wins"],
  draws: ["drawn", "d", "draws", "ties"],
  losses: ["lost", "l", "losses", "defeats"],
  goalsFor: ["gf", "goals for", "scored", "for", "f"],
  goalsAgainst: ["ga", "goals against", "conceded", "against", "a"],
  points: ["points", "pts"],
  form: ["form", "last 5", "recent", "streak"]
} as const;

/** Priority order when a header could plausibly map to two fields. */
const STAT_ORDER: readonly StatField[] = [
  "team",
  "played",
  "wins",
  "draws",
  "losses",
  "goalsFor",
  "goalsAgainst",
  "points",
  "form"
];

export type OddsField = "match" | "home" | "draw" | "away" | "over" | "under";

export const ODDS_SYNONYMS: Record<OddsField, readonly string[]> = {
  match: ["match", "fixture", "game", "event"],
  home: ["home", "1"],
  draw: ["draw", "x"],
  away: ["away", "2"],
  // "over ~2.5" / "under ~2.5": the word carries the meaning; the header
  // "Over 2.5" tokenises to ["over", "2.5"] and matches on "over".
  over: ["over"],
  under: ["under"]
} as const;

const ODDS_ORDER: readonly OddsField[] = [
  "match",
  "home",
  "draw",
  "away",
  "over",
  "under"
];

/** Lowercase, trim, and collapse internal whitespace to single spaces. */
export function normalizeHeader(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Does `header` match `synonym`? Exact-token, case-insensitive, trimmed:
 * - single-letter synonym → the WHOLE header must be that single letter
 *   (so "p" maps "P" but never "Pts" or "GP");
 * - multi-word synonym ("goals for") → the whole header must equal it;
 * - single-word synonym → the whole header equals it, or one of its
 *   whitespace tokens does ("over" maps "Over 2.5").
 */
export function headerMatchesSynonym(header: string, synonym: string): boolean {
  const h = normalizeHeader(header);
  const s = normalizeHeader(synonym);
  if (h.length === 0 || s.length === 0) return false;
  if (s.length === 1) return h === s;
  if (s.includes(" ")) return h === s;
  return h === s || h.split(" ").includes(s);
}

function matchField<F extends string>(
  header: string,
  dict: Record<F, readonly string[]>,
  order: readonly F[]
): F | null {
  for (const field of order) {
    if (dict[field].some((syn) => headerMatchesSynonym(header, syn))) return field;
  }
  return null;
}

/** Which stats field this header names, or null when unrecognised (e.g. "#", "GD"). */
export function matchStatField(header: string): StatField | null {
  return matchField(header, STAT_SYNONYMS, STAT_ORDER);
}

/** Which odds field this header names, or null. */
export function matchOddsField(header: string): OddsField | null {
  return matchField(header, ODDS_SYNONYMS, ODDS_ORDER);
}

/**
 * Map a header row to column indices by field, keeping the FIRST column that
 * claims each field. Unrecognised headers are simply omitted (they are ignored
 * downstream), so extra columns like "#" and "GD" never corrupt a row.
 */
export function mapStatsHeaders(headers: readonly string[]): Map<StatField, number> {
  const map = new Map<StatField, number>();
  headers.forEach((header, index) => {
    const field = matchStatField(header);
    if (field && !map.has(field)) map.set(field, index);
  });
  return map;
}

export function mapOddsHeaders(headers: readonly string[]): Map<OddsField, number> {
  const map = new Map<OddsField, number>();
  headers.forEach((header, index) => {
    const field = matchOddsField(header);
    if (field && !map.has(field)) map.set(field, index);
  });
  return map;
}
