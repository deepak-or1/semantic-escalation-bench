import {
  createRng,
  displayedOddsCell,
  displayedStatsCell,
  hashSeed,
  rngInt,
  rngShuffle,
  type DisplayOverride,
  type FixtureMarket,
  type TeamSeasonStats
} from "@ssda/shared";
import type { Copy } from "./copy";
import { at, esc, type Skin } from "./markup";
import {
  decoyStateFrom,
  headerVocab,
  renderControl,
  resolveDelayRange,
  resolveLayout,
  resolvePagination,
  wrapInDivs,
  type DecoyState,
  type HeaderVocab
} from "./params";
import {
  delayedScript,
  hiddenTabScript,
  modalScript,
  paginationScript
} from "./scripts";
import type { LabState } from "./state";
import { renderStyle } from "./styles";

const EM_DASH = "—";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
] as const;

// ── Shared layout ─────────────────────────────────────────────

interface LayoutOptions {
  skin: Skin;
  copy: Copy;
  authed: boolean;
  mainHtml: string;
  scripts?: string[];
}

function renderLayout({ skin, copy, authed, mainHtml, scripts = [] }: LayoutOptions): string {
  const signOut = authed
    ? `<form method="post" action="/logout"${skin.classAttr("signout")}>` +
      `<button type="submit"${skin.classAttr("btn")}>Sign out</button></form>`
    : "";
  const nav =
    `<nav${skin.classAttr("nav")}>` +
    `<a${skin.classAttr("nav-link")} href="/stats">Standings</a>` +
    `<a${skin.classAttr("nav-link")} href="/odds">Odds</a>` +
    signOut +
    `</nav>`;
  return (
    `<!doctype html><html lang="en"><head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(copy.siteName)}</title>` +
    renderStyle(skin) +
    `</head><body>` +
    `<div${skin.classAttr("page")}>` +
    `<header${skin.classAttr("site-header")}>` +
    `<a${skin.classAttr("brand")} href="/stats"><span>&#9670;</span> ${esc(copy.siteName)}</a>` +
    nav +
    `</header>` +
    `<main${skin.classAttr("main")}>${mainHtml}</main>` +
    `<footer${skin.classAttr("footer")}>Synthetic data for a local browser-automation lab. ` +
    `Read-only analytics demo &mdash; no real odds, no wagering.</footer>` +
    `</div>` +
    scripts.join("") +
    `</body></html>`
  );
}

// ── Login ─────────────────────────────────────────────────────

export function renderLoginPage(opts: {
  skin: Skin;
  copy: Copy;
  next: string;
  error?: string;
  decoy?: DecoyState;
}): string {
  const { skin, copy, next, error } = opts;
  const decoy = opts.decoy ?? { level: 0, copy: {}, placement: "after" };
  const errorHtml = error ? `<div${skin.classAttr("error")}>${esc(error)}</div>` : "";
  // login-submit is decoy control 3 (§3 F2). The functional submit keeps type=submit
  // (real behaviour); the decoy is type=button (can never submit) — no JS needed.
  const submit = renderControl({
    control: "login-submit",
    seed: skin.seed,
    skin,
    decoy,
    type: "submit",
    bases: ["login-submit", "btn", "btn-primary"],
    text: copy.loginButton
  });
  const main =
    `<div${skin.classAttr("login-card")}><section${skin.classAttr("panel")}>` +
    `<h1>${esc(copy.loginHeading)}</h1>` +
    `<p${skin.classAttr("subtle")}>Sign in to view standings and odds.</p>` +
    errorHtml +
    `<form method="post" action="/login"${skin.idAttr("login-form")}${skin.classAttr("login-form")}>` +
    `<input type="hidden" name="next" value="${esc(next)}">` +
    `<label${skin.classAttr("field")}><span>Username</span>` +
    `<input${skin.idAttr("username")} name="username" autocomplete="username" placeholder="analyst"></label>` +
    `<label${skin.classAttr("field")}><span>Password</span>` +
    `<input${skin.idAttr("password")} name="password" type="password" autocomplete="current-password"></label>` +
    submit.html +
    `</form></section></div>`;
  return renderLayout({ skin, copy, authed: false, mainHtml: main });
}

// ── Consent wall (cookieBanner) ───────────────────────────────

export function renderConsentPage(opts: { skin: Skin; copy: Copy; next: string }): string {
  const { skin, copy, next } = opts;
  const main =
    `<div${skin.classAttr("consent-card")}><section${skin.classAttr("panel")}>` +
    `<h1>Before you continue</h1>` +
    `<p>We use cookies to remember your preferences and measure traffic on this ` +
    `synthetic demo. Accept to view the standings and odds.</p>` +
    `<form method="post" action="/consent"${skin.idAttr("consent-form")}${skin.classAttr("consent-form", "consent-actions")}>` +
    `<input type="hidden" name="next" value="${esc(next)}">` +
    `<button type="submit"${skin.idAttr("accept-cookies")}${skin.classAttr("accept-cookies", "btn", "btn-primary")}>` +
    `${esc(copy.acceptCookies)}</button>` +
    `<a href="#"${skin.classAttr("manage-settings")}>Manage settings</a>` +
    `</form></section></div>`;
  return renderLayout({ skin, copy, authed: true, mainHtml: main });
}

// ── Stats cells ───────────────────────────────────────────────

type ColKey = "P" | "W" | "D" | "L" | "GF" | "GA" | "GD" | "Pts" | "Form";
const STAT_COLUMNS: ColKey[] = ["P", "W", "D", "L", "GF", "GA", "GD", "Pts", "Form"];

type StatField = "played" | "wins" | "draws" | "losses" | "goalsFor" | "goalsAgainst" | "points";
const COL_FIELD: Record<"P" | "W" | "D" | "L" | "GF" | "GA" | "Pts", StatField> = {
  P: "played",
  W: "wins",
  D: "draws",
  L: "losses",
  GF: "goalsFor",
  GA: "goalsAgainst",
  Pts: "points"
};

const INTEGER = /^-?\d+$/;

function formChips(form: string, skin: Skin): string {
  const chips = [...form]
    .map((ch) => {
      const variant = ch === "W" ? "chip-w" : ch === "D" ? "chip-d" : "chip-l";
      return `<span${skin.classAttr("chip", variant)}>${esc(ch)}</span>`;
    })
    .join("");
  return `<span${skin.classAttr("form-cell")}>${chips}</span>`;
}

function statCell(
  col: ColKey,
  team: TeamSeasonStats,
  overrides: readonly DisplayOverride[],
  skin: Skin
): string {
  if (col === "Form") {
    return formChips(displayedStatsCell(team, "form", overrides), skin);
  }
  if (col === "GD") {
    // Goal difference is derived from the DISPLAYED goals strings, so it
    // degrades to an em-dash whenever a corrupt/partial cell isn't an integer.
    const gf = displayedStatsCell(team, "goalsFor", overrides);
    const ga = displayedStatsCell(team, "goalsAgainst", overrides);
    if (INTEGER.test(gf) && INTEGER.test(ga)) {
      return esc(String(Number.parseInt(gf, 10) - Number.parseInt(ga, 10)));
    }
    return EM_DASH;
  }
  return esc(displayedStatsCell(team, COL_FIELD[col], overrides));
}

function orderedColumns(state: LabState): ColKey[] {
  // Explicit permutation (§3 Stratum K) wins; validated exact at config time.
  if (state.params.columnOrder !== undefined) return state.params.columnOrder as ColKey[];
  if (!state.hasChaos("columnShuffle")) return STAT_COLUMNS;
  return rngShuffle(createRng(hashSeed(`cols:${state.seed}`)), STAT_COLUMNS);
}

/** Each row as an array of already-processed, already-ordered cell strings. */
function buildRows(state: LabState, skin: Skin, columns: ColKey[]): string[][] {
  return state.truth.teams.map((team, i) => [
    String(i + 1),
    esc(team.name),
    ...columns.map((col) => statCell(col, team, state.overrides, skin))
  ]);
}

function headerRow(columns: ColKey[], hv: HeaderVocab): string {
  // headerVocab (§3 Stratum K) renames HEADER labels only; column keys double as
  // their canonical header text. Truth (team names, cell values) is never touched.
  const cols = columns.map((c) => `<th>${esc(hv(c, c))}</th>`).join("");
  return `<tr><th>#</th><th>${esc(hv("team", "Team"))}</th>${cols}</tr>`;
}

function renderRow(cells: string[], skin: Skin): string {
  const tds = cells.map((c) => `<td${skin.classAttr("cell")}>${c}</td>`).join("");
  return `<tr>${tds}</tr>`;
}

function tableEl(
  skin: Skin,
  columns: ColKey[],
  rowsHtml: string,
  hv: HeaderVocab,
  pageSize?: number
): string {
  const sizeAttr = pageSize !== undefined ? ` data-page-size="${pageSize}"` : "";
  return (
    `<div${skin.classAttr("table-wrap")}>` +
    `<table${skin.idAttr("standings")}${skin.classAttr("stats-table")}${sizeAttr}>` +
    `<thead>${headerRow(columns, hv)}</thead>` +
    `<tbody${skin.classAttr("tbody-rows")}>${rowsHtml}</tbody>` +
    `</table></div>`
  );
}

function teamCard(
  team: TeamSeasonStats,
  rank: number,
  overrides: readonly DisplayOverride[],
  skin: Skin,
  hv: HeaderVocab
): string {
  const pairs = (
    [
      ["P", "played"],
      ["W", "wins"],
      ["D", "draws"],
      ["L", "losses"],
      ["GF", "goalsFor"],
      ["GA", "goalsAgainst"],
      ["Pts", "points"]
    ] as const
  )
    .map(
      ([label, field]) =>
        `<dt>${esc(hv(label, label))}</dt><dd>${esc(displayedStatsCell(team, field, overrides))}</dd>`
    )
    .join("");
  return (
    `<article${skin.classAttr("team-card")}>` +
    `<h3><span${skin.classAttr("rank-badge")}>${rank}</span>${esc(team.name)}</h3>` +
    `<dl>${pairs}</dl>` +
    formChips(displayedStatsCell(team, "form", overrides), skin) +
    `</article>`
  );
}

interface View {
  html: string;
  scripts: string[];
}

/** Pick the stats presentation. Precedence: layout > pagination > delayed > default. */
function statsView(state: LabState, skin: Skin, copy: Copy, columns: ColKey[], rows: string[][]): View {
  const hv = headerVocab(state.params);
  const decoy = decoyStateFrom(state.params);
  const layout = resolveLayout(state.hasChaos("layoutVariant"), state.params);

  if (layout === "cards") {
    const cards = state.truth.teams.map((t, i) => teamCard(t, i + 1, state.overrides, skin, hv)).join("");
    return { html: `<section${skin.classAttr("team-grid")}>${cards}</section>`, scripts: [] };
  }

  if (layout === "wrapped") {
    // Still a real <table>, just nested in 2–3 non-semantic seed-drifted divs.
    const allRows = rows.map((r) => renderRow(r, skin)).join("");
    const table = tableEl(skin, columns, allRows, hv);
    return { html: `<div${skin.classAttr("panel")}>${wrapInDivs(state.seed, table)}</div>`, scripts: [] };
  }

  const paging = resolvePagination(state.hasChaos("pagination"), state.params);
  if (paging.active) {
    const shown = rows.slice(0, paging.size).map((r) => renderRow(r, skin)).join("");
    const pages = Math.max(1, Math.ceil(rows.length / paging.size));
    const json = JSON.stringify(rows).replace(/</g, "\\u003c");
    const dataScript =
      `<script type="application/json"${skin.idAttr("table-data")}${skin.classAttr("table-data")} data-page-size="${paging.size}">${json}</script>`;
    const next = renderControl({
      control: "next-page",
      seed: state.seed,
      skin,
      decoy,
      type: "button",
      bases: ["next-page", "btn"],
      text: copy.nextButton
    });
    const pager =
      `<div${skin.classAttr("pager")}>` +
      `<button type="button"${skin.idAttr("prev-page")}${skin.classAttr("prev-page", "btn")}>${esc(copy.prevButton)}</button>` +
      `<span${skin.idAttr("page-indicator")}${skin.classAttr("page-indicator")}>Page 1 of ${pages}</span>` +
      next.html +
      `</div>`;
    const html = `<div${skin.classAttr("panel")}>${tableEl(skin, columns, shown, hv, paging.size)}${pager}</div>${dataScript}`;
    return { html, scripts: [paginationScript(skin, next.sel)] };
  }

  if (state.hasChaos("delayedRender")) {
    const [dmin, dmax] = resolveDelayRange(state.params);
    const delayMs = rngInt(createRng(hashSeed(`delay:${state.seed}`)), dmin, dmax);
    const allRows = rows.map((r) => renderRow(r, skin)).join("");
    const shimmer = Array.from({ length: 6 }, () => `<div${skin.classAttr("shimmer-row")}></div>`).join("");
    const skeleton =
      `<div${skin.idAttr("skeleton")}${skin.classAttr("skeleton")} data-delay-ms="${delayMs}">${shimmer}</div>`;
    const template =
      `<template${skin.idAttr("table-template")}${skin.classAttr("table-template")}>${tableEl(skin, columns, allRows, hv)}</template>`;
    return { html: `<div${skin.classAttr("panel")}>${skeleton}${template}</div>`, scripts: [delayedScript(skin)] };
  }

  const allRows = rows.map((r) => renderRow(r, skin)).join("");
  return { html: `<div${skin.classAttr("panel")}>${tableEl(skin, columns, allRows, hv)}</div>`, scripts: [] };
}

/** Wrap a chosen stats view so the real table hides behind a non-default tab. */
function wrapHiddenTab(inner: View, state: LabState, skin: Skin, copy: Copy): View {
  const decoy = decoyStateFrom(state.params);
  const top3 = state.truth.teams
    .slice(0, 3)
    .map((t, i) => `<li><span>${i + 1}. ${esc(t.name)}</span><span>${t.points} pts</span></li>`)
    .join("");
  // The reveal tab is decoy control 2 (§3 F2): its canonical id "tab-table" moves
  // to an inert decoy, and the real tab keeps its click handler via a drifted class.
  const reveal = renderControl({
    control: "reveal-table",
    seed: state.seed,
    skin,
    decoy,
    type: "button",
    bases: ["tab-table", "tab-button"],
    text: copy.fullTableTab
  });
  const tabs =
    `<div${skin.classAttr("tabs")}>` +
    `<button type="button"${skin.idAttr("tab-overview")}${skin.classAttr("tab-overview", "tab-button", "tab-active")}>Overview</button>` +
    reveal.html +
    `</div>`;
  const overview =
    `<section${skin.idAttr("panel-overview")}${skin.classAttr("panel-overview", "panel")}>` +
    `<p${skin.classAttr("subtle")}>Season summary. Open the ${esc(copy.fullTableTab)} tab for the full standings.</p>` +
    `<ol${skin.classAttr("top3")}>${top3}</ol></section>`;
  const tablePanel =
    `<section${skin.idAttr("panel-table")}${skin.classAttr("panel-table")} hidden>${inner.html}</section>`;
  return { html: tabs + overview + tablePanel, scripts: [...inner.scripts, hiddenTabScript(skin, reveal.sel)] };
}

export function renderStatsPage(opts: { state: LabState; skin: Skin; copy: Copy }): string {
  const { state, skin, copy } = opts;
  const columns = orderedColumns(state);
  const rows = buildRows(state, skin, columns);
  let view = statsView(state, skin, copy, columns, rows);
  if (state.hasChaos("hiddenTab")) view = wrapHiddenTab(view, state, skin, copy);

  const scripts = [...view.scripts];
  if (state.hasChaos("modal")) scripts.push(modalScript(skin));

  const heading =
    `<div${skin.classAttr("panel-heading")}><h1>${esc(copy.statsHeading)}</h1>` +
    `<span${skin.classAttr("subtle")}>${esc(state.truth.league.name)} &middot; ${esc(state.truth.league.season)}</span></div>`;
  return renderLayout({ skin, copy, authed: true, mainHtml: heading + view.html, scripts });
}

// ── Odds ──────────────────────────────────────────────────────

// [canonical header label, ground-truth field, headerVocab key].
const ODDS_FIELDS = [
  ["1", "homeOdds", "home"],
  ["X", "drawOdds", "draw"],
  ["2", "awayOdds", "away"],
  ["Over 2.5", "overOdds", "over"],
  ["Under 2.5", "underOdds", "under"]
] as const;

function formatKickoff(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at(DAYS, d.getUTCDay())} ${d.getUTCDate()} ${at(MONTHS, d.getUTCMonth())}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function oddsRow(
  market: FixtureMarket,
  overrides: readonly DisplayOverride[],
  skin: Skin,
  american: boolean
): string {
  const cells = [
    esc(formatKickoff(market.kickoff)),
    `<span${skin.classAttr("match")}>${esc(market.homeTeam)} vs ${esc(market.awayTeam)}</span>`,
    ...ODDS_FIELDS.map(([, field]) => esc(displayedOddsCell(market, field, overrides, american)))
  ];
  const tds = cells.map((c) => `<td${skin.classAttr("cell")}>${c}</td>`).join("");
  return `<tr>${tds}</tr>`;
}

function oddsHeaderRow(hv: HeaderVocab): string {
  // Kickoff has no vocab key; Match + the 5 odds columns rename via headerVocab.
  const cols = ODDS_FIELDS.map(([label, , key]) => `<th>${esc(hv(key, label))}</th>`).join("");
  return `<tr><th>Kickoff</th><th>${esc(hv("match", "Match"))}</th>${cols}</tr>`;
}

function oddsTableEl(state: LabState, skin: Skin, american: boolean, hv: HeaderVocab): string {
  const rows = state.truth.markets.map((m) => oddsRow(m, state.overrides, skin, american)).join("");
  return (
    `<div${skin.classAttr("table-wrap")}>` +
    `<table${skin.idAttr("odds-table")}${skin.classAttr("odds-table")}>` +
    `<thead>${oddsHeaderRow(hv)}</thead>` +
    `<tbody${skin.classAttr("tbody-rows")}>${rows}</tbody></table></div>`
  );
}

function oddsCards(state: LabState, skin: Skin, american: boolean, hv: HeaderVocab): string {
  const cards = state.truth.markets
    .map((m) => {
      const dl = ODDS_FIELDS.map(
        ([label, field, key]) =>
          `<dt>${esc(hv(key, label))}</dt><dd>${esc(displayedOddsCell(m, field, state.overrides, american))}</dd>`
      ).join("");
      return (
        `<article${skin.classAttr("odds-card")}>` +
        `<div${skin.classAttr("subtle")}>${esc(formatKickoff(m.kickoff))}</div>` +
        `<div${skin.classAttr("match")}>${esc(m.homeTeam)} vs ${esc(m.awayTeam)}</div>` +
        `<dl>${dl}</dl></article>`
      );
    })
    .join("");
  return `<section${skin.classAttr("odds-list")}>${cards}</section>`;
}

function oddsView(state: LabState, skin: Skin, american: boolean): View {
  const hv = headerVocab(state.params);
  const layout = resolveLayout(state.hasChaos("layoutVariant"), state.params);

  if (layout === "cards") {
    return { html: oddsCards(state, skin, american, hv), scripts: [] };
  }
  if (layout === "wrapped") {
    const table = oddsTableEl(state, skin, american, hv);
    return { html: `<div${skin.classAttr("panel")}>${wrapInDivs(state.seed, table)}</div>`, scripts: [] };
  }
  if (state.hasChaos("delayedRender")) {
    const [dmin, dmax] = resolveDelayRange(state.params);
    const delayMs = rngInt(createRng(hashSeed(`delay:${state.seed}`)), dmin, dmax);
    const shimmer = Array.from({ length: 6 }, () => `<div${skin.classAttr("shimmer-row")}></div>`).join("");
    const skeleton =
      `<div${skin.idAttr("skeleton")}${skin.classAttr("skeleton")} data-delay-ms="${delayMs}">${shimmer}</div>`;
    const template =
      `<template${skin.idAttr("table-template")}${skin.classAttr("table-template")}>${oddsTableEl(state, skin, american, hv)}</template>`;
    return { html: `<div${skin.classAttr("panel")}>${skeleton}${template}</div>`, scripts: [delayedScript(skin)] };
  }
  return { html: `<div${skin.classAttr("panel")}>${oddsTableEl(state, skin, american, hv)}</div>`, scripts: [] };
}

export function renderOddsPage(opts: { state: LabState; skin: Skin; copy: Copy }): string {
  const { state, skin, copy } = opts;
  const american = state.hasChaos("oddsFormatAmerican");
  const view = oddsView(state, skin, american);
  const scripts = [...view.scripts];
  if (state.hasChaos("modal")) scripts.push(modalScript(skin));

  const note = american ? `<span${skin.classAttr("note")}>American odds</span>` : "";
  const heading = `<div${skin.classAttr("panel-heading")}><h1>${esc(copy.oddsHeading)}</h1>${note}</div>`;
  return renderLayout({ skin, copy, authed: true, mainHtml: heading + view.html, scripts });
}
