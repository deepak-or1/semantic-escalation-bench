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

  it("levels 1–3 keep ids present (drifting a nested fraction); only level 4 removes them", () => {
    // Ids SURVIVE at levels 1–3 — present but progressively drifted (id half of §3
    // F1) — so an id-keyed selector misses on the drifted fraction rather than the
    // whole page never having ids until level 4. Level 4 strips every id.
    for (const level of [1, 2, 3]) {
      expect(createSkin(SEED, level).idAttr("standings")).toMatch(/^ id="standings(-x[0-9a-z]{1,6})?"$/);
    }
    // At level 3 every id token is renamed, so the emitted id is no longer canonical.
    expect(createSkin(SEED, 3).idName("standings")).not.toBe("standings");
    expect(createSkin(SEED, 3).idAttr("standings")).not.toBe(' id="standings"');
    // Level 4 removes ids entirely.
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

/**
 * Id-drift axis (PROTOCOL_2A §3 F1, id half). Levels 1–3 rename a nested seeded
 * 25%/50%/100% of id tokens (kept, just drifted) so id-keyed selectors (`#standings`)
 * miss on the drifted fraction; level 4 removes ids entirely. Independent of the
 * class decision (own salts). All at fixed seeds, no browser.
 */

// Every canonical id base the lab emits (idAttr calls + the three renderControl
// id bases). This is the FULL id inventory, a superset of the selector-hook subset.
const ID_TOKENS = [
  "login-form", "username", "password", "login-submit", "consent-form",
  "accept-cookies", "standings", "table-data", "prev-page", "page-indicator",
  "skeleton", "table-template", "tab-overview", "panel-overview", "panel-table",
  "odds-table", "newsletter-modal", "modal-close", "next-page", "tab-table"
];

function driftedIdSet(seed: number, level: number): Set<string> {
  const skin = createSkin(seed, level);
  return new Set(ID_TOKENS.filter((t) => skin.idName(t) !== t));
}

describe("createSkin id drift (§3 F1, id half)", () => {
  it("level 0 renames no id and emits every id byte-identically to the base", () => {
    const skin = createSkin(SEED, 0);
    expect(driftedIdSet(SEED, 0).size).toBe(0);
    for (const base of ID_TOKENS) {
      expect(skin.idName(base)).toBe(base);
      expect(skin.idAttr(base)).toBe(` id="${base}"`);
    }
  });

  it("the renamed-id set is nested across levels for seeds {7,1108,2201,2250,2299}", () => {
    const isSub = (a: Set<string>, b: Set<string>): boolean => [...a].every((x) => b.has(x));
    for (const seed of [7, 1108, 2201, 2250, 2299]) {
      const d1 = driftedIdSet(seed, 1);
      const d2 = driftedIdSet(seed, 2);
      const d3 = driftedIdSet(seed, 3);
      expect(isSub(d1, d2)).toBe(true); // L1 ⊆ L2
      expect(isSub(d2, d3)).toBe(true); // L2 ⊆ L3
      expect(d3.size).toBe(ID_TOKENS.length); // L3 renames EVERY id token
    }
  });

  it("id-drift decision is independent of class-drift (own salts)", () => {
    // Over the shared token names, the renamed-id set at L1 is not identical to the
    // renamed-class set at L1 — the two axes use distinct salts, so they diverge.
    const skin = createSkin(SEED, 1);
    const shared = ID_TOKENS.filter((t) => TOKENS.includes(t));
    const classSet = new Set(shared.filter((t) => skin.cls(t) !== t));
    const idSet = new Set(shared.filter((t) => skin.idName(t) !== t));
    const sameMembership = shared.every((t) => classSet.has(t) === idSet.has(t));
    expect(sameMembership).toBe(false);
  });

  it("renamed ids use the mirror suffix formula under the distinct `id:` salt", () => {
    const skin = createSkin(SEED, 3); // L3 renames every id
    for (const base of ID_TOKENS) {
      const expected = `${base}-x${hashSeed(`id:${SEED}:${base}`).toString(36).slice(0, 6)}`;
      expect(skin.idName(base)).toBe(expected);
      expect(skin.idAttr(base)).toBe(` id="${expected}"`);
    }
  });

  it("level 4 removes every id (superset break of the L1⊆L2⊆L3 nesting)", () => {
    const skin = createSkin(SEED, 4);
    for (const base of ID_TOKENS) expect(skin.idAttr(base)).toBe("");
  });

  it("mean renamed-id fraction over seeds 1..200 is ~0.25 at L1 and ~0.50 at L2", () => {
    const meanFraction = (level: number): number => {
      let total = 0;
      let drifted = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const skin = createSkin(seed, level);
        for (const base of ID_TOKENS) {
          total += 1;
          if (skin.idName(base) !== base) drifted += 1;
        }
      }
      return drifted / total;
    };
    expect(meanFraction(1)).toBeGreaterThanOrEqual(0.25 - 0.06);
    expect(meanFraction(1)).toBeLessThanOrEqual(0.25 + 0.06);
    expect(meanFraction(2)).toBeGreaterThanOrEqual(0.5 - 0.06);
    expect(meanFraction(2)).toBeLessThanOrEqual(0.5 + 0.06);
  });
});
