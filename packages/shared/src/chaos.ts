import { z } from "zod";

/**
 * Chaos flags the lab understands. Each one simulates a specific way real
 * stat/odds pages break browser automation. The benchmark toggles these per
 * scenario via POST /__lab/config.
 */
export const CHAOS_FLAGS = [
  "cookieBanner",
  "modal",
  "delayedRender",
  "networkDelay",
  "classDrift",
  "columnShuffle",
  "layoutVariant",
  "hiddenTab",
  "pagination",
  "partialData",
  "copyDrift",
  "oddsFormatAmerican",
  "staleSession",
  "corruptData"
] as const;

export type ChaosFlag = (typeof CHAOS_FLAGS)[number];

export const ChaosFlagSchema = z.enum(CHAOS_FLAGS);

export const CHAOS_DESCRIPTIONS: Record<ChaosFlag, string> = {
  cookieBanner:
    "A consent banner overlays the page and intercepts clicks until accepted.",
  modal:
    "A newsletter modal appears ~800ms after load and blocks the content until dismissed.",
  delayedRender:
    "Tables render client-side behind a skeleton after a seeded 1.5–4s delay.",
  networkDelay: "Every HTTP response is delayed by a seeded 0.5–2.5s latency.",
  classDrift:
    "All CSS class names carry a seed-derived suffix; ids and data-testids are removed.",
  columnShuffle: "Stats table columns are deterministically permuted.",
  layoutVariant:
    "Stats render as a card grid instead of a table; odds switch to a stacked list.",
  hiddenTab:
    "Season stats live behind a non-default tab that must be clicked first.",
  pagination:
    "The stats table shows 5 rows per page; the rest require clicking Next.",
  partialData: "A few cells render as em-dashes (missing values).",
  copyDrift:
    "Headings, labels and button text are swapped for synonyms between runs.",
  oddsFormatAmerican:
    "Odds display as American moneyline (+120 / -145) instead of decimal.",
  staleSession:
    "The session is invalidated server-side after the first authenticated page view, once.",
  corruptData:
    "The page serves malformed values (negative played, inconsistent W/D/L, unparseable odds)."
};
