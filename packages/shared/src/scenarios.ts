import {
  ScenarioSpecSchema,
  type ScenarioSpec,
  type ScenarioSpecInput
} from "./schemas/benchmark";

/**
 * The reliability benchmark catalog. Each scenario reconfigures the lab
 * (seed + chaos flags) and states what correct behaviour looks like.
 * Seeds are fixed so results are reproducible run to run.
 *
 * Written as schema inputs: the original core scenarios omit `group` and
 * resolve to "core" via the schema default; compound/survival scenarios set it.
 */
const RAW_SCENARIOS: ScenarioSpecInput[] = [
  {
    id: "clean-extraction",
    name: "Clean login + extraction",
    description: "No chaos. Fresh login, then extract stats and odds.",
    chaos: [],
    seed: 1101,
    session: "fresh",
    expected: "success"
  },
  {
    id: "session-reuse",
    name: "Existing session reuse",
    description:
      "The browser starts with a valid saved session; the agent should reach the data without seeing the login form.",
    chaos: [],
    seed: 1102,
    session: "reuse",
    expected: "success"
  },
  {
    id: "expired-session",
    name: "Expired session re-login",
    description:
      "A saved session is force-expired server-side; the agent must notice the redirect and log in again.",
    chaos: [],
    seed: 1103,
    session: "expired",
    expected: "success"
  },
  {
    id: "cookie-banner",
    name: "Cookie banner blocks table",
    description:
      "A consent banner overlays the page and intercepts clicks until accepted.",
    chaos: ["cookieBanner"],
    seed: 1104,
    session: "fresh",
    expected: "success"
  },
  {
    id: "modal-overlay",
    name: "Modal overlay blocks table",
    description:
      "A newsletter modal appears shortly after load and must be dismissed to reach the content.",
    chaos: ["modal"],
    seed: 1105,
    session: "fresh",
    expected: "success"
  },
  {
    id: "delayed-render",
    name: "Delayed table render",
    description:
      "Tables render client-side behind a skeleton after a seeded 1.5–4s delay.",
    chaos: ["delayedRender"],
    seed: 1106,
    session: "fresh",
    expected: "success"
  },
  {
    id: "network-slowdown",
    name: "Network slowdown",
    description: "Every response is delayed by a seeded 0.5–2.5s latency.",
    chaos: ["networkDelay"],
    seed: 1107,
    session: "fresh",
    expected: "success"
  },
  {
    id: "class-drift",
    name: "CSS class drift",
    description:
      "All CSS class names carry a seed-derived suffix; ids and data-testids are removed.",
    chaos: ["classDrift"],
    seed: 1108,
    session: "fresh",
    expected: "success"
  },
  {
    id: "column-shuffle",
    name: "Changed column order",
    description: "Stats table columns are deterministically permuted.",
    chaos: ["columnShuffle"],
    seed: 1109,
    session: "fresh",
    expected: "success"
  },
  {
    id: "layout-variant",
    name: "DOM layout change",
    description:
      "Stats render as a card grid instead of a table; odds switch to a stacked list.",
    chaos: ["layoutVariant"],
    seed: 1110,
    session: "fresh",
    expected: "success"
  },
  {
    id: "hidden-tab",
    name: "Hidden tab required",
    description:
      "Season stats live behind a non-default tab that must be clicked first.",
    chaos: ["hiddenTab"],
    seed: 1111,
    session: "fresh",
    expected: "success"
  },
  {
    id: "pagination",
    name: "Pagination required",
    description:
      "The stats table shows 5 rows per page; the rest require clicking Next.",
    chaos: ["pagination"],
    seed: 1112,
    session: "fresh",
    expected: "success"
  },
  {
    id: "partial-data",
    name: "Partial data missing",
    description:
      "A few cells render as em-dashes; extraction should degrade gracefully with explicit warnings, not fail.",
    chaos: ["partialData"],
    seed: 1113,
    session: "fresh",
    expected: "success-with-warnings"
  },
  {
    id: "copy-drift",
    name: "Page copy changes",
    description:
      "Headings, labels and button text are swapped for synonyms between runs.",
    chaos: ["copyDrift"],
    seed: 1114,
    session: "fresh",
    expected: "success"
  },
  {
    id: "odds-format-american",
    name: "Odds format variation",
    description:
      "Odds display as American moneyline (+120 / -145) instead of decimal and must be normalised.",
    chaos: ["oddsFormatAmerican"],
    seed: 1115,
    session: "fresh",
    expected: "success"
  },
  {
    id: "stale-session",
    name: "Stale session mid-flow",
    description:
      "The session is invalidated server-side after the first authenticated page view; the agent is bounced to login between the stats and odds pages and must recover.",
    chaos: ["staleSession"],
    seed: 1117,
    session: "fresh",
    expected: "success"
  },
  {
    id: "schema-violation",
    name: "Corrupt data → validation failure",
    description:
      "The page serves malformed values (negative played, inconsistent W/D/L, unparseable odds). Correct behaviour is a clean, categorised validation failure — not silently bad data.",
    chaos: ["corruptData"],
    seed: 1116,
    session: "fresh",
    expected: "validation-failure"
  },
  // ── Survival group ────────────────────────────────────────────────────────
  // One site, engines frozen as written, drift accumulating version to version.
  // Every version is still expected to succeed; an engine that fails v2 or v3
  // is the survival curve, not a judging special case.
  {
    id: "site-v1",
    name: "Site version 1 (launch)",
    description:
      "The stat site exactly as every engine's author first saw it: stable ids, one standings table, decimal odds. The clean baseline the survival curve starts from.",
    chaos: [],
    seed: 1118,
    session: "fresh",
    expected: "success",
    group: "survival"
  },
  {
    id: "site-v2",
    name: "Site version 2 (content refresh)",
    description:
      "A routine content pass: headings and button labels are reworded and the stats columns are reordered. No rebuild — but positional selectors now read the wrong column.",
    chaos: ["copyDrift", "columnShuffle"],
    seed: 1119,
    session: "fresh",
    expected: "success",
    group: "survival"
  },
  {
    id: "site-v3",
    name: "Site version 3 (redesign)",
    description:
      "A full front-end rebuild: hashed CSS classes, ids gone, copy reworded, and the standings move from a table to a card grid. Only structure-blind reading still gets through.",
    chaos: ["copyDrift", "classDrift", "layoutVariant"],
    seed: 1120,
    session: "fresh",
    expected: "success",
    group: "survival"
  },
  // ── Compound group ────────────────────────────────────────────────────────
  // A realistic Tuesday: several obstacles co-occur in a single run.
  {
    id: "compound-blocked-and-slow",
    name: "Blocked and slow",
    description:
      "A consent banner and a newsletter modal both block the page while the tables render late behind throttled responses — four obstacles stacked on one clean dataset.",
    chaos: ["cookieBanner", "modal", "delayedRender", "networkDelay"],
    seed: 1121,
    session: "fresh",
    expected: "success",
    group: "compound"
  },
  {
    id: "compound-session-churn",
    name: "Session churn",
    description:
      "The session drops between the stats and odds pages, the standings span three paginated views, and odds arrive as American moneyline: recover, page through, and normalise.",
    chaos: ["staleSession", "pagination", "oddsFormatAmerican"],
    seed: 1122,
    session: "fresh",
    expected: "success",
    group: "compound"
  },
  {
    id: "compound-messy-data-day",
    name: "Messy data day",
    description:
      "A newsletter modal over a slow page hiding partial data — several cells render as em-dashes. Correct behaviour is to dismiss, wait, and degrade with explicit warnings, not fail.",
    chaos: ["partialData", "networkDelay", "modal"],
    seed: 1123,
    session: "fresh",
    expected: "success-with-warnings",
    group: "compound"
  },
  {
    id: "compound-redesign-storm",
    name: "Redesign storm",
    description:
      "Everything a redesign throws at once: hashed classes with ids removed, reworded copy, and a card-grid layout. Only semantic reading gets through it unaided.",
    chaos: ["classDrift", "copyDrift", "layoutVariant"],
    seed: 1124,
    session: "fresh",
    expected: "success",
    group: "compound"
  }
];

/**
 * The public catalog: raw specs validated and `group`-defaulted once at module
 * load, so every consumer sees a concrete `group` on every scenario.
 */
export const SCENARIOS: ScenarioSpec[] = RAW_SCENARIOS.map((s) =>
  ScenarioSpecSchema.parse(s)
);

export function scenarioById(id: string): ScenarioSpec | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
