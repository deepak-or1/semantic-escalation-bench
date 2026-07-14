import { z } from "zod";

/**
 * Local, lenient zod mirror of @ssda/model's Watchlist shape (packages/model/
 * src/watchlist.ts + value.ts). Defined here rather than imported so the
 * dashboard depends only on @ssda/shared; the dashboard parses watchlist.json
 * defensively with safeParse and treats a mismatch as "no watchlist".
 */

const ConfidenceSchema = z.enum(["high", "medium", "low"]);

export const ValueSelectionSchema = z.object({
  fixture: z.string(),
  homeTeam: z.string(),
  awayTeam: z.string(),
  kickoff: z.string().optional(),
  market: z.string(),
  label: z.string(),
  decimalOdds: z.number(),
  modelProbability: z.number(),
  impliedRaw: z.number(),
  impliedNoVig: z.number(),
  edge: z.number(),
  expectedValuePerUnit: z.number(),
  confidence: ConfidenceSchema,
  notes: z.array(z.string()).default([])
});
export type ValueSelection = z.infer<typeof ValueSelectionSchema>;

export const WatchlistSchema = z.object({
  generatedAt: z.string(),
  paramsUsed: z.record(z.number()).optional(),
  datasetConfidence: z.object({
    label: ConfidenceSchema,
    reasons: z.array(z.string()).default([])
  }),
  selections: z.array(ValueSelectionSchema).default([]),
  allSelections: z.array(ValueSelectionSchema).default([]),
  limitations: z.array(z.string()).default([])
});
export type Watchlist = z.infer<typeof WatchlistSchema>;
