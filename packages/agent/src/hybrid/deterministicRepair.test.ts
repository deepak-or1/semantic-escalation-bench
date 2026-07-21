import { describe, expect, it } from "vitest";
import {
  cardsToTable,
  pairValueParses,
  pickRevealCandidates,
  readOddsCards,
  readStatsCards,
  selectCardBlocks,
  selectLoginSubmit,
  type BlockCandidate,
  type RawCard,
  type RevealDescriptor
} from "./deterministicRepair";

/**
 * Pure-function coverage for the B2 deterministic ladder's SELECTION rules and card
 * reader (§2, revision 5). The DOM traversal rungs (relocateControl /
 * revealTableDeterministic / readCardBlocks) are exercised end-to-end against a real
 * browser in tests/integration/hybrid-deterministic.test.ts; here we pin the pure
 * rules those rungs delegate to.
 */

describe("cardsToTable", () => {
  it("folds card blocks into a header-aligned table with the identity as the first column", () => {
    const cards: RawCard[] = [
      { identity: "Arsenal", pairs: [{ label: "P", value: "10" }, { label: "W", value: "7" }, { label: "Pts", value: "23" }] },
      { identity: "Chelsea", pairs: [{ label: "P", value: "10" }, { label: "W", value: "6" }, { label: "Pts", value: "20" }] }
    ];
    const table = cardsToTable(cards, "team");
    expect(table.headers).toEqual(["team", "P", "W", "Pts"]);
    expect(table.rows).toEqual([
      ["Arsenal", "10", "7", "23"],
      ["Chelsea", "10", "6", "20"]
    ]);
  });

  it("aligns each block's values to the header labels regardless of pair order", () => {
    const cards: RawCard[] = [
      { identity: "A", pairs: [{ label: "P", value: "10" }, { label: "W", value: "7" }] },
      { identity: "B", pairs: [{ label: "W", value: "6" }, { label: "P", value: "9" }] }
    ];
    const table = cardsToTable(cards, "team");
    expect(table.headers).toEqual(["team", "P", "W"]);
    expect(table.rows).toEqual([
      ["A", "10", "7"],
      ["B", "9", "6"]
    ]);
  });

  it("returns an empty table for no cards", () => {
    expect(cardsToTable([], "team")).toEqual({ headers: [], rows: [] });
  });
});

describe("readStatsCards (identity from the block, other fields via STAT_SYNONYMS)", () => {
  const statCard = (
    identity: string, p: string, w: string, d: string, l: string, gf: string, ga: string, pts: string
  ): RawCard => ({
    identity,
    pairs: [
      { label: "P", value: p }, { label: "W", value: w }, { label: "D", value: d },
      { label: "L", value: l }, { label: "GF", value: gf }, { label: "GA", value: ga },
      { label: "Pts", value: pts }
    ]
  });

  it("takes the team name from the block identity (the card heading, per §2)", () => {
    const rows = readStatsCards([
      statCard("Arsenal", "10", "7", "2", "1", "40", "22", "23"),
      statCard("Chelsea", "10", "6", "3", "1", "31", "22", "21"),
      statCard("Spurs", "10", "5", "2", "3", "20", "20", "17"),
      statCard("Everton", "10", "4", "4", "2", "18", "15", "16")
    ]);
    expect(rows).not.toBeNull();
    expect(rows!).toHaveLength(4);
    expect(rows![0]).toMatchObject({
      team: "Arsenal",
      played: 10,
      wins: 7,
      goalsFor: 40,
      goalsAgainst: 22,
      points: 23
    });
  });

  it("returns null when fewer than 4 fields map (identity 'team' + <3 stat pairs)", () => {
    expect(
      readStatsCards([
        { identity: "X", pairs: [{ label: "P", value: "10" }, { label: "W", value: "7" }, { label: "XX", value: "1" }] }
      ])
    ).toBeNull();
  });
});

describe("readOddsCards (identity as the match, other fields via ODDS_SYNONYMS)", () => {
  it("splits a fixture-shaped identity into home/away teams", () => {
    const rows = readOddsCards([
      {
        identity: "Arsenal vs Chelsea",
        pairs: [{ label: "1", value: "1.90" }, { label: "X", value: "3.40" }, { label: "2", value: "4.10" }]
      }
    ]);
    expect(rows).not.toBeNull();
    expect(rows![0]).toMatchObject({
      homeTeam: "Arsenal",
      awayTeam: "Chelsea",
      homeOdds: "1.90",
      drawOdds: "3.40",
      awayOdds: "4.10"
    });
  });

  it("returns null with fewer than 3 odds value fields (even with an identity)", () => {
    expect(
      readOddsCards([
        { identity: "A vs B", pairs: [{ label: "1", value: "1.9" }, { label: "X", value: "3.4" }, { label: "ZZ", value: "1" }] }
      ])
    ).toBeNull();
  });

  it("documents the lab's odds-card boundary: a non-fixture identity (kickoff) yields a wrong match", () => {
    // The lab's oddsCards have no heading, so the identity is the first non-pair
    // text — the kickoff div — which does not split on ' vs '. B2 cannot recover
    // the real fixture: the deliberate §2 boundary that separates it from C.
    const rows = readOddsCards([
      {
        identity: "Sat 3 Feb, 15:00",
        pairs: [{ label: "1", value: "1.9" }, { label: "X", value: "3.4" }, { label: "2", value: "4.1" }]
      }
    ]);
    expect(rows).not.toBeNull();
    expect(rows![0]).toMatchObject({ homeTeam: "Sat 3 Feb, 15:00", awayTeam: "" });
  });
});

describe("pickRevealCandidates (§2 revision-5 reveal-table candidate rule)", () => {
  const desc = (over: Partial<RevealDescriptor> = {}): RevealDescriptor => ({
    roleTab: false,
    tag: "button",
    anchorNavigational: false,
    inStrip: true,
    visible: true,
    enabled: true,
    ...over
  });

  it("excludes a full-href nav anchor while keeping a role=tab and an in-strip button", () => {
    const descriptors = [
      desc({ tag: "a", anchorNavigational: true }), // <a href="/somewhere"> — site nav, excluded
      desc({ roleTab: true }), // role=tab — group 1
      desc({ tag: "button" }) // in-strip button — group 2
    ];
    expect(pickRevealCandidates(descriptors)).toEqual([1, 2]);
  });

  it("orders role=tab (group 1) before strip controls (group 2)", () => {
    expect(pickRevealCandidates([desc({ tag: "button" }), desc({ roleTab: true })])).toEqual([1, 0]);
  });

  it("includes an in-strip anchor whose href is absent or fragment-only", () => {
    expect(pickRevealCandidates([desc({ tag: "a", anchorNavigational: false })])).toEqual([0]);
  });

  it("excludes controls not inside a strip, and invisible/disabled ones", () => {
    expect(pickRevealCandidates([desc({ inStrip: false })])).toEqual([]);
    expect(pickRevealCandidates([desc({ visible: false })])).toEqual([]);
    expect(pickRevealCandidates([desc({ enabled: false })])).toEqual([]);
  });

  it("caps the candidate list at 5", () => {
    const many = Array.from({ length: 8 }, () => desc({ tag: "button" }));
    expect(pickRevealCandidates(many)).toHaveLength(5);
  });
});

describe("pairValueParses (§2 value-side parse via B's cell parsers)", () => {
  it("accepts integers and odds decimal/american values (parseIntCell / parseOddsValue)", () => {
    for (const v of ["10", "0", "-3", "1.90", "+120", "-145"]) expect(pairValueParses(v)).toBe(true);
  });
  it("rejects non-numeric text and unparseable cells", () => {
    for (const v of ["Arsenal", "—", "", "N/A", "vs "]) expect(pairValueParses(v)).toBe(false);
  });
});

describe("selectCardBlocks (§2 fallback value check + >=3-pair + >=4-block thresholds)", () => {
  const PARENT = 0;
  const blockSet = (
    n: number,
    pairs: { label: string; value: string; fromDl: boolean }[]
  ): BlockCandidate[] =>
    Array.from({ length: n }, (_, i) => ({ parentKey: PARENT, identity: `E${i}`, pairs }));

  it("keeps a fallback block set whose pair VALUES parse", () => {
    const blocks = blockSet(4, [
      { label: "Played", value: "10", fromDl: false },
      { label: "Won", value: "7", fromDl: false },
      { label: "Points", value: "23", fromDl: false }
    ]);
    expect(selectCardBlocks(blocks)).toHaveLength(4);
  });

  it("drops fallback pairs whose VALUE does not parse, so blocks fail the >=3-pair threshold", () => {
    // Non-numeric labels but non-parsing values → NOT label–value pairs (§2) → 0
    // valid pairs per block → below the >=3 threshold → no >=4 sibling group.
    const blocks = blockSet(4, [
      { label: "Foo", value: "Bar", fromDl: false },
      { label: "Baz", value: "Qux", fromDl: false },
      { label: "Alpha", value: "Beta", fromDl: false }
    ]);
    expect(selectCardBlocks(blocks)).toEqual([]);
  });

  it("counts dt/dd (fromDl) pairs unconditionally — the primary §2 definition skips the value check", () => {
    const blocks = blockSet(4, [
      { label: "a", value: "Bar", fromDl: true },
      { label: "b", value: "Qux", fromDl: true },
      { label: "c", value: "Zed", fromDl: true }
    ]);
    expect(selectCardBlocks(blocks)).toHaveLength(4);
  });

  it("requires at least 4 sibling blocks", () => {
    const blocks = blockSet(3, [
      { label: "Played", value: "10", fromDl: false },
      { label: "Won", value: "7", fromDl: false },
      { label: "Points", value: "23", fromDl: false }
    ]);
    expect(selectCardBlocks(blocks)).toEqual([]);
  });
});

describe("selectLoginSubmit (§2 revision-5 exactly-one fallback)", () => {
  it("prefers the first visible enabled [type=submit]", () => {
    expect(selectLoginSubmit(["s1"], ["b1", "b2"])).toBe("s1");
  });

  it("falls back to the ONLY visible enabled button when there is no submit", () => {
    expect(selectLoginSubmit([], ["b1"])).toBe("b1");
  });

  it("yields NO candidate when there is no submit and MORE THAN ONE visible enabled button", () => {
    expect(selectLoginSubmit([], ["b1", "b2"])).toBeNull();
  });

  it("yields no candidate for a form with no submit and no button", () => {
    expect(selectLoginSubmit([], [])).toBeNull();
  });
});
