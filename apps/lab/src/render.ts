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
  delayedScript,
  hiddenTabScript,
  modalScript,
  paginationScript
} from "./scripts";
import type { LabState } from "./state";
import { renderStyle } from "./styles";

const EM_DASH = "—";
const PAGE_SIZE = 5;
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
}): string {
  const { skin, copy, next, error } = opts;
  const errorHtml = error ? `<div${skin.classAttr("error")}>${esc(error)}</div>` : "";
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
    `<button type="submit"${skin.idAttr("login-submit")}${skin.classAttr("login-submit", "btn", "btn-primary")}>` +
    `${esc(copy.loginButton)}</button>` +
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

function headerRow(columns: ColKey[]): string {
  const cols = columns.map((c) => `<th>${c}</th>`).join("");
  return `<tr><th>#</th><th>Team</th>${cols}</tr>`;
}

function renderRow(cells: string[], skin: Skin): string {
  const tds = cells.map((c) => `<td${skin.classAttr("cell")}>${c}</td>`).join("");
  return `<tr>${tds}</tr>`;
}

function tableEl(skin: Skin, columns: ColKey[], rowsHtml: string, pageSize?: number): string {
  const sizeAttr = pageSize !== undefined ? ` data-page-size="${pageSize}"` : "";
  return (
    `<div${skin.classAttr("table-wrap")}>` +
    `<table${skin.idAttr("standings")}${skin.classAttr("stats-table")}${sizeAttr}>` +
    `<thead>${headerRow(columns)}</thead>` +
    `<tbody${skin.classAttr("tbody-rows")}>${rowsHtml}</tbody>` +
    `</table></div>`
  );
}

function teamCard(
  team: TeamSeasonStats,
  rank: number,
  overrides: readonly DisplayOverride[],
  skin: Skin
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
    .map(([label, field]) => `<dt>${label}</dt><dd>${esc(displayedStatsCell(team, field, overrides))}</dd>`)
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
  if (state.hasChaos("layoutVariant")) {
    const cards = state.truth.teams.map((t, i) => teamCard(t, i + 1, state.overrides, skin)).join("");
    return { html: `<section${skin.classAttr("team-grid")}>${cards}</section>`, scripts: [] };
  }

  if (state.hasChaos("pagination")) {
    const shown = rows.slice(0, PAGE_SIZE).map((r) => renderRow(r, skin)).join("");
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    const json = JSON.stringify(rows).replace(/</g, "\\u003c");
    const dataScript =
      `<script type="application/json"${skin.idAttr("table-data")}${skin.classAttr("table-data")}>${json}</script>`;
    const pager =
      `<div${skin.classAttr("pager")}>` +
      `<button type="button"${skin.idAttr("prev-page")}${skin.classAttr("prev-page", "btn")}>${esc(copy.prevButton)}</button>` +
      `<span${skin.idAttr("page-indicator")}${skin.classAttr("page-indicator")}>Page 1 of ${pages}</span>` +
      `<button type="button"${skin.idAttr("next-page")}${skin.classAttr("next-page", "btn")}>${esc(copy.nextButton)}</button>` +
      `</div>`;
    const html = `<div${skin.classAttr("panel")}>${tableEl(skin, columns, shown, PAGE_SIZE)}${pager}</div>${dataScript}`;
    return { html, scripts: [paginationScript(skin)] };
  }

  if (state.hasChaos("delayedRender")) {
    const delayMs = rngInt(createRng(hashSeed(`delay:${state.seed}`)), 1500, 4000);
    const allRows = rows.map((r) => renderRow(r, skin)).join("");
    const shimmer = Array.from({ length: 6 }, () => `<div${skin.classAttr("shimmer-row")}></div>`).join("");
    const skeleton =
      `<div${skin.idAttr("skeleton")}${skin.classAttr("skeleton")} data-delay-ms="${delayMs}">${shimmer}</div>`;
    const template =
      `<template${skin.idAttr("table-template")}${skin.classAttr("table-template")}>${tableEl(skin, columns, allRows)}</template>`;
    return { html: `<div${skin.classAttr("panel")}>${skeleton}${template}</div>`, scripts: [delayedScript(skin)] };
  }

  const allRows = rows.map((r) => renderRow(r, skin)).join("");
  return { html: `<div${skin.classAttr("panel")}>${tableEl(skin, columns, allRows)}</div>`, scripts: [] };
}

/** Wrap a chosen stats view so the real table hides behind a non-default tab. */
function wrapHiddenTab(inner: View, state: LabState, skin: Skin, copy: Copy): View {
  const top3 = state.truth.teams
    .slice(0, 3)
    .map((t, i) => `<li><span>${i + 1}. ${esc(t.name)}</span><span>${t.points} pts</span></li>`)
    .join("");
  const tabs =
    `<div${skin.classAttr("tabs")}>` +
    `<button type="button"${skin.idAttr("tab-overview")}${skin.classAttr("tab-overview", "tab-button", "tab-active")}>Overview</button>` +
    `<button type="button"${skin.idAttr("tab-table")}${skin.classAttr("tab-table", "tab-button")}>${esc(copy.fullTableTab)}</button>` +
    `</div>`;
  const overview =
    `<section${skin.idAttr("panel-overview")}${skin.classAttr("panel-overview", "panel")}>` +
    `<p${skin.classAttr("subtle")}>Season summary. Open the ${esc(copy.fullTableTab)} tab for the full standings.</p>` +
    `<ol${skin.classAttr("top3")}>${top3}</ol></section>`;
  const tablePanel =
    `<section${skin.idAttr("panel-table")}${skin.classAttr("panel-table")} hidden>${inner.html}</section>`;
  return { html: tabs + overview + tablePanel, scripts: [...inner.scripts, hiddenTabScript(skin)] };
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

const ODDS_FIELDS = [
  ["1", "homeOdds"],
  ["X", "drawOdds"],
  ["2", "awayOdds"],
  ["Over 2.5", "overOdds"],
  ["Under 2.5", "underOdds"]
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

function oddsTableEl(state: LabState, skin: Skin, american: boolean): string {
  const rows = state.truth.markets.map((m) => oddsRow(m, state.overrides, skin, american)).join("");
  return (
    `<div${skin.classAttr("table-wrap")}>` +
    `<table${skin.idAttr("odds-table")}${skin.classAttr("odds-table")}>` +
    `<thead><tr><th>Kickoff</th><th>Match</th><th>1</th><th>X</th><th>2</th><th>Over 2.5</th><th>Under 2.5</th></tr></thead>` +
    `<tbody${skin.classAttr("tbody-rows")}>${rows}</tbody></table></div>`
  );
}

function oddsCards(state: LabState, skin: Skin, american: boolean): string {
  const cards = state.truth.markets
    .map((m) => {
      const dl = ODDS_FIELDS.map(
        ([label, field]) => `<dt>${label}</dt><dd>${esc(displayedOddsCell(m, field, state.overrides, american))}</dd>`
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
  if (state.hasChaos("layoutVariant")) {
    return { html: oddsCards(state, skin, american), scripts: [] };
  }
  if (state.hasChaos("delayedRender")) {
    const delayMs = rngInt(createRng(hashSeed(`delay:${state.seed}`)), 1500, 4000);
    const shimmer = Array.from({ length: 6 }, () => `<div${skin.classAttr("shimmer-row")}></div>`).join("");
    const skeleton =
      `<div${skin.idAttr("skeleton")}${skin.classAttr("skeleton")} data-delay-ms="${delayMs}">${shimmer}</div>`;
    const template =
      `<template${skin.idAttr("table-template")}${skin.classAttr("table-template")}>${oddsTableEl(state, skin, american)}</template>`;
    return { html: `<div${skin.classAttr("panel")}>${skeleton}${template}</div>`, scripts: [delayedScript(skin)] };
  }
  return { html: `<div${skin.classAttr("panel")}>${oddsTableEl(state, skin, american)}</div>`, scripts: [] };
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
