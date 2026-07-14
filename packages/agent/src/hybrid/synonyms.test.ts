import { describe, expect, it } from "vitest";
import {
  headerMatchesSynonym,
  mapOddsHeaders,
  mapStatsHeaders,
  matchOddsField,
  matchStatField
} from "./synonyms";

describe("headerMatchesSynonym rules", () => {
  it("is case-insensitive and whitespace-trimmed", () => {
    expect(headerMatchesSynonym("  Team ", "team")).toBe(true);
    expect(headerMatchesSynonym("PTS", "pts")).toBe(true);
  });

  it("single-letter synonyms match ONLY single-letter headers", () => {
    expect(headerMatchesSynonym("P", "p")).toBe(true);
    expect(headerMatchesSynonym("Pts", "p")).toBe(false); // never a multi-char header
    expect(headerMatchesSynonym("GP", "p")).toBe(false);
    expect(headerMatchesSynonym("D", "d")).toBe(true);
    expect(headerMatchesSynonym("GD", "d")).toBe(false);
  });

  it("multi-word synonyms require a whole-header match", () => {
    expect(headerMatchesSynonym("Goals For", "goals for")).toBe(true);
    expect(headerMatchesSynonym("goals   for", "goals for")).toBe(true);
    expect(headerMatchesSynonym("Goals", "goals for")).toBe(false);
  });

  it("single-word synonyms match the whole header or one token (Over 2.5 -> over)", () => {
    expect(headerMatchesSynonym("Over 2.5", "over")).toBe(true);
    expect(headerMatchesSynonym("Under 2.5", "under")).toBe(true);
    expect(headerMatchesSynonym("GF", "gf")).toBe(true);
    // exact-token, not substring soup:
    expect(headerMatchesSynonym("Turnover", "over")).toBe(false);
  });
});

describe("matchStatField on the lab's stat headers", () => {
  const cases: Array<[string, ReturnType<typeof matchStatField>]> = [
    ["Team", "team"],
    ["P", "played"],
    ["W", "wins"],
    ["D", "draws"],
    ["L", "losses"],
    ["GF", "goalsFor"],
    ["GA", "goalsAgainst"],
    ["Pts", "points"],
    ["Form", "form"],
    ["#", null], // rank column — ignored
    ["GD", null] // goal-difference column — ignored
  ];
  it.each(cases)("%s -> %s", (header, field) => {
    expect(matchStatField(header)).toBe(field);
  });
});

describe("matchOddsField on the lab's odds headers", () => {
  const cases: Array<[string, ReturnType<typeof matchOddsField>]> = [
    ["Match", "match"],
    ["1", "home"],
    ["X", "draw"],
    ["2", "away"],
    ["Over 2.5", "over"],
    ["Under 2.5", "under"],
    ["Kickoff", null] // not part of the graded odds vocabulary
  ];
  it.each(cases)("%s -> %s", (header, field) => {
    expect(matchOddsField(header)).toBe(field);
  });
});

describe("header mapper on SHUFFLED headers", () => {
  it("maps stat fields to their real column index regardless of order", () => {
    // A deliberately permuted header row (as columnShuffle produces), with the
    // ignored "#"/"GD" columns interleaved.
    const headers = ["#", "Team", "GF", "P", "Form", "W", "GD", "D", "GA", "L", "Pts"];
    const map = mapStatsHeaders(headers);
    expect(map.get("team")).toBe(1);
    expect(map.get("goalsFor")).toBe(2);
    expect(map.get("played")).toBe(3);
    expect(map.get("form")).toBe(4);
    expect(map.get("wins")).toBe(5);
    expect(map.get("draws")).toBe(7);
    expect(map.get("goalsAgainst")).toBe(8);
    expect(map.get("losses")).toBe(9);
    expect(map.get("points")).toBe(10);
    // "#" and "GD" claim no field.
    expect([...map.values()]).not.toContain(0);
    expect([...map.values()]).not.toContain(6);
  });

  it("maps every odds column by header name", () => {
    const map = mapOddsHeaders(["Kickoff", "Match", "1", "X", "2", "Over 2.5", "Under 2.5"]);
    expect(map.get("match")).toBe(1);
    expect(map.get("home")).toBe(2);
    expect(map.get("draw")).toBe(3);
    expect(map.get("away")).toBe(4);
    expect(map.get("over")).toBe(5);
    expect(map.get("under")).toBe(6);
    expect(map.has("match")).toBe(true);
  });
});
