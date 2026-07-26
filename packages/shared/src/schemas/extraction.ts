import { z } from "zod";

/**
 * Extraction-layer schemas: intentionally shape-lenient. They validate what an
 * extractor faithfully read off the page (including nonsense the page really
 * displays, like a negative "played" count). Semantic rules live in the
 * domain layer (`assessDataset`), so corrupt pages fail OUR validation
 * deterministically instead of being silently "fixed" mid-extraction.
 */

export const ExtractedStatsRowSchema = z.object({
  team: z.string(),
  played: z.number().int().nullable(),
  wins: z.number().int().nullable().optional(),
  draws: z.number().int().nullable().optional(),
  losses: z.number().int().nullable().optional(),
  goalsFor: z.number().int().nullable(),
  goalsAgainst: z.number().int().nullable(),
  points: z.number().int().nullable().optional(),
  form: z.string().nullable().optional()
});
export type ExtractedStatsRow = z.infer<typeof ExtractedStatsRowSchema>;

export const ExtractedStatsPageSchema = z.object({
  rows: z.array(ExtractedStatsRowSchema)
});
export type ExtractedStatsPage = z.infer<typeof ExtractedStatsPageSchema>;

/** Odds cells stay raw strings — the page may show "1.85", "+120" or "—". */
export const ExtractedOddsRowSchema = z.object({
  homeTeam: z.string(),
  awayTeam: z.string(),
  kickoff: z.string().nullable().optional(),
  homeOdds: z.string().nullable(),
  drawOdds: z.string().nullable(),
  awayOdds: z.string().nullable(),
  totalsLine: z.string().nullable().optional(),
  overOdds: z.string().nullable().optional(),
  underOdds: z.string().nullable().optional()
});
export type ExtractedOddsRow = z.infer<typeof ExtractedOddsRowSchema>;

export const ExtractedOddsPageSchema = z.object({
  rows: z.array(ExtractedOddsRowSchema)
});
export type ExtractedOddsPage = z.infer<typeof ExtractedOddsPageSchema>;

/**
 * NOTE (record version 2): a page's pre-normalization payload is recorded
 * VERBATIM as `unknown` — see `TrialResult.canonical.raw`. The record layer
 * imposes no shape on it at all, deliberately, so there is no schema here to
 * describe it: any validation would make the extraction checks pass by
 * construction, and any reshaping would change what an honestly malformed
 * payload's schema-error detail recomputes to.
 */
