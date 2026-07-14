import { describe, expect, it } from "vitest";
import type { ExtractedStatsRow } from "@ssda/shared";
import { mergeStatsRows, parsePageInfo, statsRowKey } from "./helpers";

const row = (team: string, played: number | null = 10): ExtractedStatsRow => ({
  team,
  played,
  goalsFor: 0,
  goalsAgainst: 0
});

describe("parsePageInfo", () => {
  it("parses a 'Page X of Y' indicator embedded in page text", () => {
    expect(parsePageInfo("Standings\nPage 2 of 3\nNext")).toEqual({ current: 2, total: 3 });
  });

  it("matches regardless of surrounding whitespace runs", () => {
    expect(parsePageInfo("Page   10   of   12")).toEqual({ current: 10, total: 12 });
  });

  it("returns null when there is no indicator (single-page case)", () => {
    expect(parsePageInfo("League Standings\nAshford Rovers 30 pts")).toBeNull();
  });

  it("returns null on empty text", () => {
    expect(parsePageInfo("")).toBeNull();
  });
});

describe("statsRowKey", () => {
  it("collapses whitespace, trims and lowercases", () => {
    expect(statsRowKey("  Ashford   Rovers  ")).toBe("ashford rovers");
  });
});

describe("mergeStatsRows", () => {
  it("appends rows for teams not seen yet", () => {
    const merged = mergeStatsRows([row("Ashford Rovers")], [row("Bexley Town")]);
    expect(merged.map((r) => r.team)).toEqual(["Ashford Rovers", "Bexley Town"]);
  });

  it("keeps the FIRST occurrence when a team repeats across pages", () => {
    const first = row("Ashford Rovers", 10);
    const dupe = row("ashford   rovers", 99); // same team, different casing/spacing
    const merged = mergeStatsRows([first], [dupe, row("Bexley Town")]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(first);
    expect(merged[0]?.played).toBe(10);
    expect(merged[1]?.team).toBe("Bexley Town");
  });

  it("dedupes within the incoming batch too", () => {
    const merged = mergeStatsRows([], [row("Calder United"), row("Calder United", 5)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.played).toBe(10);
  });

  it("never dedupes empty-named rows (leaves them for core to flag)", () => {
    const merged = mergeStatsRows([row("")], [row("")]);
    expect(merged).toHaveLength(2);
  });

  it("does not mutate the input arrays", () => {
    const existing = [row("Ashford Rovers")];
    mergeStatsRows(existing, [row("Bexley Town")]);
    expect(existing).toHaveLength(1);
  });
});
