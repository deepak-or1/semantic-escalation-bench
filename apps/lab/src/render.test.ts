import { createRng, hashSeed, rngInt, type ChaosFlag, type ChaosParams } from "@ssda/shared";
import { describe, expect, it } from "vitest";
import { getCopy } from "./copy";
import { createSkin } from "./markup";
import { decoyStateFrom, resolveClassDriftLevel } from "./params";
import { renderLoginPage, renderOddsPage, renderStatsPage } from "./render";
import { LabState } from "./state";

/**
 * Renderer coverage for the Phase-2A axis machinery (PROTOCOL_2A §3). Fixed seeds,
 * no browser: every assertion is on the rendered HTML string. Each helper mirrors
 * the skin/copy resolution app.ts performs, so the output equals a live request.
 */

const SEED = 2201;

function labState(chaos: ChaosFlag[], params: ChaosParams): LabState {
  return new LabState(SEED, chaos, params);
}
function skinFor(state: LabState) {
  return createSkin(state.seed, resolveClassDriftLevel(state.hasChaos("classDrift"), state.params));
}
function copyFor(state: LabState) {
  return getCopy(state.seed, state.hasChaos("copyDrift"), state.params.uiCopy);
}
function renderStats(state: LabState): string {
  return renderStatsPage({ state, skin: skinFor(state), copy: copyFor(state) });
}
function renderOdds(state: LabState): string {
  return renderOddsPage({ state, skin: skinFor(state), copy: copyFor(state) });
}
function renderLogin(state: LabState): string {
  return renderLoginPage({
    skin: skinFor(state),
    copy: copyFor(state),
    next: "/stats",
    decoy: decoyStateFrom(state.params)
  });
}

const decoySuffix = hashSeed(`decoy:${SEED}`).toString(36).slice(0, 6);
const count = (haystack: string, needle: RegExp): number => (haystack.match(needle) ?? []).length;

// ── Decoy rebinding (§3 F2) ───────────────────────────────────

describe("decoy rebinding (§3 F2)", () => {
  it("rebinds next-page: inert decoy keeps the canonical id, functional keeps the hook and loses the id", () => {
    const html = renderStats(labState(["pagination", "hiddenTab"], { decoyLevel: 1 }));
    // Inert decoy carries the canonical id, default copy text, and no handler.
    expect(html).toContain(`<button type="button" id="next-page" class="next-page btn">Next</button>`);
    // Functional control: drifted class-only, no id — and it keeps its behaviour hook.
    expect(html).toContain(`<button type="button" class="next-page-d${decoySuffix} btn">Next</button>`);
    expect(html).toContain(`document.querySelector('.next-page-d${decoySuffix}')`);
    // The canonical id lives on exactly one element (the decoy).
    expect(count(html, /id="next-page"/g)).toBe(1);
  });

  it("rebinds reveal-table at level 2 (and still next-page): decoy id=tab-table, functional tab drifts", () => {
    const html = renderStats(labState(["pagination", "hiddenTab"], { decoyLevel: 2 }));
    expect(html).toContain(`<button type="button" id="tab-table" class="tab-table tab-button">Full table</button>`);
    expect(html).toContain(`<button type="button" class="tab-table-d${decoySuffix} tab-button">Full table</button>`);
    expect(html).toContain(`document.querySelector('.tab-table-d${decoySuffix}')`);
    // Level 2 rebinds the first two controls, so next-page is rebound as well.
    expect(count(html, /id="next-page"/g)).toBe(1);
    expect(count(html, /id="tab-table"/g)).toBe(1);
  });

  it("rebinds login-submit at level 3: decoy is type=button (inert), functional stays type=submit", () => {
    const html = renderLogin(labState(["pagination", "hiddenTab"], { decoyLevel: 3 }));
    // Decoy: canonical id, type=button so it can never submit the form.
    expect(html).toContain(`<button type="button" id="login-submit" class="login-submit btn btn-primary">Sign in</button>`);
    // Functional: real submit button, drifted class, no id.
    expect(html).toContain(`<button type="submit" class="login-submit-d${decoySuffix} btn btn-primary">Sign in</button>`);
    expect(count(html, /id="login-submit"/g)).toBe(1);
  });

  it("honours decoyPlacement before/after and a custom decoyCopy string", () => {
    const after = renderStats(
      labState(["pagination", "hiddenTab"], { decoyLevel: 1, decoyPlacement: "after", decoyCopy: { "next-page": "Older" } })
    );
    const before = renderStats(
      labState(["pagination", "hiddenTab"], { decoyLevel: 1, decoyPlacement: "before", decoyCopy: { "next-page": "Older" } })
    );
    // Custom decoy copy on the inert decoy; functional keeps the canonical "Next".
    expect(after).toContain(`id="next-page" class="next-page btn">Older</button>`);
    expect(after).toContain(`class="next-page-d${decoySuffix} btn">Next</button>`);
    // Placement controls document order relative to the functional control.
    const funcIdx = (h: string) => h.indexOf(`next-page-d${decoySuffix}`);
    const decoyIdx = (h: string) => h.indexOf(`id="next-page"`);
    expect(funcIdx(after)).toBeLessThan(decoyIdx(after)); // functional first ("after")
    expect(decoyIdx(before)).toBeLessThan(funcIdx(before)); // decoy first ("before")
  });

  it("does not rebind anything at decoyLevel 0 (functional keeps the canonical id, no decoy)", () => {
    const html = renderStats(labState(["pagination", "hiddenTab"], { decoyLevel: 0 }));
    expect(html).toContain(`<button type="button" id="next-page" class="next-page btn">Next</button>`);
    expect(html).not.toContain(`next-page-d${decoySuffix}`);
    expect(count(html, /id="next-page"/g)).toBe(1);
  });
});

// ── pageSize (§3 F3) ──────────────────────────────────────────

describe("pageSize (§3 F3)", () => {
  it("slices the server-rendered table to pageSize rows and stamps the data attribute", () => {
    const two = renderStats(labState([], { pageSize: 2 }));
    const three = renderStats(labState([], { pageSize: 3 }));
    // Server-rendered body rows begin `<tr><td` (the header begins `<tr><th`; the
    // client script's own literal "<tr>" is quoted and never matches). 12 teams
    // total, so the slice bites: exactly pageSize rows are rendered server-side.
    expect(count(two, /<tr><td/g)).toBe(2);
    expect(count(three, /<tr><td/g)).toBe(3);
    // Per-request page size is stamped for the client script to read.
    expect(two).toContain(`data-page-size="2"`);
    expect(two).toContain(`parseInt(el.getAttribute("data-page-size"), 10)`);
  });

  it("activates pagination on its own (parameterized form of the flag)", () => {
    const html = renderStats(labState([], { pageSize: 4 }));
    expect(html).toContain(`data-page-size="4"`);
    expect(html).toContain(`id="page-indicator"`);
  });
});

// ── headerVocab (§3 Stratum K) ────────────────────────────────

describe("headerVocab (§3 Stratum K)", () => {
  it("renders in the stats table header, leaving unmapped columns canonical", () => {
    const html = renderStats(labState([], { headerVocab: { team: "Club", Pts: "Points" } }));
    expect(html).toContain(`<th>Club</th>`);
    expect(html).toContain(`<th>Points</th>`);
    expect(html).toContain(`<th>P</th>`); // unmapped stays canonical
  });

  it("renders in the stats card dt labels (cards layout)", () => {
    const html = renderStats(labState([], { layoutCondition: "cards", headerVocab: { Pts: "Points" } }));
    expect(html).toContain(`<dt>Points</dt>`);
    expect(html).toContain(`<dt>W</dt>`);
  });

  it("renders in the odds table header and odds card labels", () => {
    const table = renderOdds(labState([], { headerVocab: { match: "Fixture", home: "H", over: "O2.5" } }));
    expect(table).toContain(`<th>Fixture</th>`);
    expect(table).toContain(`<th>H</th>`);
    expect(table).toContain(`<th>O2.5</th>`);
    expect(table).toContain(`<th>X</th>`); // unmapped odds column stays canonical
    const cards = renderOdds(labState(["layoutVariant"], { headerVocab: { home: "H" } }));
    expect(cards).toContain(`<dt>H</dt>`);
  });

  it("never touches ground-truth data (team names render unchanged)", () => {
    const html = renderStats(labState([], { headerVocab: { team: "Club" } }));
    expect(html).toContain("Juniper Vale"); // a real team name, from truth
  });
});

// ── columnOrder (§3 Stratum K) ────────────────────────────────

describe("columnOrder (§3 Stratum K)", () => {
  it("renders the stat columns in exactly the given permutation", () => {
    const order = ["Pts", "GD", "P", "W", "D", "L", "GF", "GA", "Form"] as const;
    const html = renderStats(labState([], { columnOrder: [...order] }));
    const expectedHeader = `<th>#</th><th>Team</th>` + order.map((c) => `<th>${c}</th>`).join("");
    expect(html).toContain(expectedHeader);
  });
});

// ── layoutCondition (§3 Stratum K) ────────────────────────────

describe("layoutCondition (§3 Stratum K)", () => {
  it("wrapped keeps a real <table> nested inside seed-drifted wrapper divs", () => {
    const html = renderStats(labState([], { layoutCondition: "wrapped" }));
    expect(html).toContain(`<div class="wrap-`); // non-semantic wrapper
    expect(html).toContain(`<table`); // still a real table
    expect(html).not.toContain(`class="team-grid"`); // not the card layout
    // The wrapper opens before the table it wraps.
    expect(html.indexOf(`<div class="wrap-`)).toBeLessThan(html.indexOf(`<table`));
    // Odds table is likewise wrapped.
    const odds = renderOdds(labState([], { layoutCondition: "wrapped" }));
    expect(odds).toContain(`<div class="wrap-`);
    expect(odds).toContain(`<table`);
  });

  it("cards is byte-identical to the existing layoutVariant rendering path", () => {
    const viaParam = renderStats(labState([], { layoutCondition: "cards" }));
    const viaFlag = renderStats(labState(["layoutVariant"], {}));
    expect(viaParam).toBe(viaFlag);
    const oddsParam = renderOdds(labState([], { layoutCondition: "cards" }));
    const oddsFlag = renderOdds(labState(["layoutVariant"], {}));
    expect(oddsParam).toBe(oddsFlag);
  });
});

// ── uiCopy (§3 Stratum K) ─────────────────────────────────────

describe("uiCopy (§3 Stratum K)", () => {
  it("overrides a single copy key while the others stay canonical", () => {
    const html = renderStats(labState([], { uiCopy: { statsHeading: "MY STANDINGS" } }));
    expect(html).toContain(`<h1>MY STANDINGS</h1>`);
    expect(html).toContain("NP Stats Hub"); // siteName untouched (default variant)
  });
});

// ── delayRangeMs (§3 Timing) ──────────────────────────────────

describe("delayRangeMs (§3 Timing)", () => {
  it("re-bounds the seeded draw: the stamped delay lands inside the override range", () => {
    const html = renderStats(labState(["delayedRender"], { delayRangeMs: [100, 200] }));
    const stamped = Number(/data-delay-ms="(\d+)"/.exec(html)?.[1]);
    expect(stamped).toBeGreaterThanOrEqual(100);
    expect(stamped).toBeLessThanOrEqual(200);
    // Same seeded draw as Phase-1 — only the bounds change. Recompute it exactly.
    const expected = rngInt(createRng(hashSeed(`delay:${SEED}`)), 100, 200);
    expect(stamped).toBe(expected);
  });
});
