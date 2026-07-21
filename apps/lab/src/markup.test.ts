import { hashSeed } from "@ssda/shared";
import { describe, expect, it } from "vitest";
import { createSkin } from "./markup";

/**
 * classDriftLevel machinery (PROTOCOL_2A §3 F1). All at fixed seeds, no browser:
 * the nested per-token rename (level k ⊆ level k+1) and the level-4 ≡ Phase-1
 * `classDrift` byte-identity are asserted directly on the skin's output.
 */

// A representative slice of the class bases the app actually emits.
const TOKENS = [
  "page", "site-header", "brand", "nav", "nav-link", "signout", "main", "panel",
  "panel-heading", "note", "subtle", "table-wrap", "stats-table", "tbody-rows",
  "cell", "chip", "chip-w", "chip-d", "chip-l", "form-cell", "team-grid",
  "team-card", "rank-badge", "odds-table", "odds-list", "odds-card", "match",
  "tabs", "tab-button", "tab-active", "tab-overview", "tab-table", "top3",
  "pager", "page-indicator", "btn", "btn-primary", "prev-page", "next-page",
  "skeleton", "shimmer-row", "table-template", "table-data", "login-card",
  "field", "error", "consent-card", "manage-settings", "footer", "login-form",
  "login-submit", "accept-cookies"
];

const SEED = 2201;

function driftedSet(seed: number, level: number): Set<string> {
  const skin = createSkin(seed, level);
  return new Set(TOKENS.filter((t) => skin.cls(t) !== t));
}

const isSubset = (a: Set<string>, b: Set<string>): boolean => [...a].every((x) => b.has(x));

describe("createSkin classDriftLevel (§3 F1)", () => {
  it("level 0 renames nothing and keeps ids", () => {
    const skin = createSkin(SEED, 0);
    expect(driftedSet(SEED, 0).size).toBe(0);
    expect(skin.cls("stats-table")).toBe("stats-table");
    expect(skin.idAttr("standings")).toBe(' id="standings"');
  });

  it("the renamed set is nested across levels: level1 ⊂ level2 ⊂ level3(=all)", () => {
    const d1 = driftedSet(SEED, 1);
    const d2 = driftedSet(SEED, 2);
    const d3 = driftedSet(SEED, 3);
    // Nested: each level's renamed set contains the previous level's.
    expect(isSubset(d1, d2)).toBe(true);
    expect(isSubset(d2, d3)).toBe(true);
    // Strictly growing (a meaningful 25% → 50% → 100% progression).
    expect(d1.size).toBeGreaterThan(0);
    expect(d1.size).toBeLessThan(d2.size);
    expect(d2.size).toBeLessThan(d3.size);
    expect(d3.size).toBe(TOKENS.length); // level 3 renames every token
  });

  it("levels 1–3 keep ids; only level 4 removes them", () => {
    expect(createSkin(SEED, 1).idAttr("standings")).toBe(' id="standings"');
    expect(createSkin(SEED, 2).idAttr("standings")).toBe(' id="standings"');
    expect(createSkin(SEED, 3).idAttr("standings")).toBe(' id="standings"');
    expect(createSkin(SEED, 4).idAttr("standings")).toBe("");
  });

  it("level 4 ≡ Phase-1 `classDrift` byte-identically (same suffix formula, ids gone)", () => {
    const skin = createSkin(SEED, 4);
    for (const token of TOKENS) {
      // The exact Phase-1 binary-drift formula.
      const expected = `${token}-x${hashSeed(`cls:${SEED}:${token}`).toString(36).slice(0, 6)}`;
      expect(skin.cls(token)).toBe(expected);
    }
    expect(skin.classAttr("stats-table", "cell")).toBe(
      ` class="${skin.cls("stats-table")} ${skin.cls("cell")}"`
    );
    expect(skin.idAttr("standings")).toBe("");
  });

  it("levels 3 and 4 emit identical class tokens (they differ only on ids)", () => {
    const s3 = createSkin(SEED, 3);
    const s4 = createSkin(SEED, 4);
    for (const token of TOKENS) expect(s3.cls(token)).toBe(s4.cls(token));
  });
});
