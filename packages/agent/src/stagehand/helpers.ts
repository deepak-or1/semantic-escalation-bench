import type { ExtractedStatsRow } from "@ssda/shared";

/**
 * Pure, browser-free helpers for the Stagehand engine. Kept separate from
 * engine.ts so they can be unit-tested without launching a browser or an LLM.
 */

/**
 * Parse a "Page X of Y" indicator out of a page's visible text. Returns null
 * when the text has no pagination indicator (the common, single-page case).
 */
export function parsePageInfo(text: string): { current: number; total: number } | null {
  const match = text.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
  if (!match) return null;
  const [, currentRaw, totalRaw] = match;
  if (!currentRaw || !totalRaw) return null;
  const current = Number.parseInt(currentRaw, 10);
  const total = Number.parseInt(totalRaw, 10);
  if (!Number.isFinite(current) || !Number.isFinite(total)) return null;
  return { current, total };
}

/** Dedupe key for a team row: whitespace-collapsed, trimmed, lowercased. */
export function statsRowKey(team: string): string {
  return team.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Merge stats rows across paginated views, keeping the FIRST occurrence of each
 * team (by name). Rows with an empty name are never deduped — they are kept so
 * core's normalizer can flag them rather than have this layer silently drop
 * evidence of a broken page.
 */
export function mergeStatsRows(
  existing: readonly ExtractedStatsRow[],
  incoming: readonly ExtractedStatsRow[]
): ExtractedStatsRow[] {
  const seen = new Set<string>();
  for (const row of existing) {
    const key = statsRowKey(row.team);
    if (key) seen.add(key);
  }
  const merged: ExtractedStatsRow[] = [...existing];
  for (const row of incoming) {
    const key = statsRowKey(row.team);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(row);
  }
  return merged;
}
