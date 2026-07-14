import { z } from "zod";

/**
 * Canonical domain schemas. GroundTruth is what the lab seeds and serves;
 * Normalized* is the common internal shape both extraction engines produce.
 */

export const TeamSeasonStatsSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  played: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  draws: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  goalsFor: z.number().int().nonnegative(),
  goalsAgainst: z.number().int().nonnegative(),
  points: z.number().int().nonnegative(),
  /** Last five results, oldest first, e.g. "WWDLW". */
  form: z.string().regex(/^[WDL]{0,5}$/)
});
export type TeamSeasonStats = z.infer<typeof TeamSeasonStatsSchema>;

export const FixtureSchema = z.object({
  id: z.string().min(1),
  homeTeam: z.string().min(1),
  awayTeam: z.string().min(1),
  /** ISO 8601 */
  kickoff: z.string().min(1)
});
export type Fixture = z.infer<typeof FixtureSchema>;

export const OneXTwoSchema = z.object({
  home: z.number().gt(1),
  draw: z.number().gt(1),
  away: z.number().gt(1)
});
export type OneXTwo = z.infer<typeof OneXTwoSchema>;

export const TotalsSchema = z.object({
  line: z.number().positive(),
  over: z.number().gt(1),
  under: z.number().gt(1)
});
export type Totals = z.infer<typeof TotalsSchema>;

export const FixtureMarketSchema = z.object({
  fixtureId: z.string().min(1),
  homeTeam: z.string().min(1),
  awayTeam: z.string().min(1),
  kickoff: z.string().min(1),
  /** Decimal odds — canonical format regardless of what the page displays. */
  oneXTwo: OneXTwoSchema,
  totals: TotalsSchema
});
export type FixtureMarket = z.infer<typeof FixtureMarketSchema>;

export const LeagueMetaSchema = z.object({
  name: z.string().min(1),
  season: z.string().min(1),
  avgGoalsPerTeamPerGame: z.number().positive(),
  trueHomeAdvantage: z.number().positive()
});
export type LeagueMeta = z.infer<typeof LeagueMetaSchema>;

export const TrueProbabilitySchema = z.object({
  fixtureId: z.string().min(1),
  home: z.number().min(0).max(1),
  draw: z.number().min(0).max(1),
  away: z.number().min(0).max(1),
  over25: z.number().min(0).max(1)
});
export type TrueProbability = z.infer<typeof TrueProbabilitySchema>;

export const GroundTruthSchema = z.object({
  seed: z.number().int(),
  league: LeagueMetaSchema,
  /** Sorted as displayed: points desc, goal difference desc, goals for desc. */
  teams: z.array(TeamSeasonStatsSchema),
  fixtures: z.array(FixtureSchema),
  markets: z.array(FixtureMarketSchema),
  /** Probabilities from the generator's true rates — for docs/model checks. */
  trueProbabilities: z.array(TrueProbabilitySchema)
});
export type GroundTruth = z.infer<typeof GroundTruthSchema>;

/**
 * A cell the lab displays differently from ground truth (partialData /
 * corruptData chaos). The benchmark scorer uses these to know which cells to
 * expect as null and which to exclude from accuracy scoring.
 */
export const DisplayOverrideSchema = z.object({
  page: z.enum(["stats", "odds"]),
  /** Team name for stats rows; `${homeTeam}|${awayTeam}` for odds rows. */
  rowKey: z.string().min(1),
  field: z.string().min(1),
  /** Exactly what the lab renders in that cell. */
  displayed: z.string(),
  kind: z.enum(["partial", "corrupt"])
});
export type DisplayOverride = z.infer<typeof DisplayOverrideSchema>;

// ── Normalized (post-extraction) shapes ─────────────────────────────────

export const NormalizedTeamStatsSchema = z.object({
  name: z.string().min(1),
  played: z.number().int().positive(),
  goalsFor: z.number().int().nonnegative().nullable(),
  goalsAgainst: z.number().int().nonnegative().nullable(),
  wins: z.number().int().nonnegative().optional(),
  draws: z.number().int().nonnegative().optional(),
  losses: z.number().int().nonnegative().optional(),
  points: z.number().int().nonnegative().optional(),
  form: z
    .string()
    .regex(/^[WDL]*$/)
    .optional(),
  /** Field names that were present on the page but unreadable/missing. */
  missingFields: z.array(z.string())
});
export type NormalizedTeamStats = z.infer<typeof NormalizedTeamStatsSchema>;

export const NormalizedMarketSchema = z.object({
  homeTeam: z.string().min(1),
  awayTeam: z.string().min(1),
  kickoff: z.string().optional(),
  oneXTwo: OneXTwoSchema.optional(),
  totals: TotalsSchema.optional(),
  sourceFormat: z.enum(["decimal", "american", "mixed"])
});
export type NormalizedMarket = z.infer<typeof NormalizedMarketSchema>;

export const NormalizedDatasetSchema = z.object({
  teams: z.array(NormalizedTeamStatsSchema),
  markets: z.array(NormalizedMarketSchema),
  /** Soft problems: missing cells, unmatched teams, dropped odds cells. */
  warnings: z.array(z.string()),
  /** Hard problems: rows/values that violate the domain rules. */
  failures: z.array(z.string()),
  meta: z.object({
    engine: z.enum(["stagehand", "baseline", "hybrid"]),
    source: z.string(),
    extractedAt: z.string(),
    seed: z.number().int().optional()
  })
});
export type NormalizedDataset = z.infer<typeof NormalizedDatasetSchema>;
