import type { ExtractedOddsRow, ExtractedStatsRow } from "@ssda/shared";
import type { DomReadyPage } from "../core";
import {
  mapOddsHeaders,
  mapStatsHeaders,
  normalizeHeader,
  type OddsField,
  type StatField
} from "./synonyms";

/**
 * Deterministic, structure-aware extraction: read WHATEVER the page displays and
 * map columns by HEADER NAME through the synonym dictionary — never by fixed
 * position, never by id or class. Column shuffles and copy tweaks change where a
 * field sits or what the page is called, but not what a column is *labelled*, so
 * this reader stays correct where the positional baseline silently misreads.
 * A page that abandons the `<table>` shape entirely (a card grid) yields no
 * mappable table here — an honest boundary the engine reports, not papers over.
 */

/** One visible table, reduced to its header texts and body cell texts. */
export interface RawTable {
  headers: string[];
  rows: string[][];
}

const INTEGER = /^-?\d+$/;

/** Integer ONLY for an exact integer token; a dash / "N/A" / blank → null. */
export function parseIntCell(text: string | undefined): number | null {
  const t = (text ?? "").trim();
  return INTEGER.test(t) ? Number.parseInt(t, 10) : null;
}

/**
 * Read every VISIBLE table as {headers, rows} of already-trimmed displayed text.
 * The form cell's chip markup collapses to its plain letters (e.g. "WWDLW") just
 * as the baseline's island reader does, so both engines see identical strings.
 */
export function readVisibleTables(page: DomReadyPage): Promise<RawTable[]> {
  // The in-browser function uses ONLY anonymous inline arrows — no named function
  // expressions (`const cellText = …`), because bundlers wrap those with a
  // `__name(...)` keepNames helper that is undefined once the function is
  // serialised into the page, throwing a ReferenceError. See core/domReady.ts.
  return page.evaluate<RawTable[], undefined>(() => {
    const out: RawTable[] = [];
    for (const table of Array.from(document.querySelectorAll("table"))) {
      if (table.getClientRects().length === 0) continue;
      let headerCells = Array.from(table.querySelectorAll("thead th"));
      if (headerCells.length === 0) {
        const firstRow = table.querySelector("tr");
        headerCells = firstRow ? Array.from(firstRow.querySelectorAll("th")) : [];
      }
      const headers = headerCells.map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim());
      const body = table.querySelector("tbody") ?? table;
      const rows: string[][] = [];
      for (const tr of Array.from(body.querySelectorAll("tr"))) {
        const cells = Array.from(tr.querySelectorAll("td"));
        if (cells.length === 0) continue; // skip header-only rows
        rows.push(cells.map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim()));
      }
      out.push({ headers, rows });
    }
    return out;
  });
}

/** First table whose headers name ≥4 stats fields (the standings), else null. */
export function selectStatsTable(tables: readonly RawTable[]): RawTable | null {
  for (const table of tables) {
    if (mapStatsHeaders(table.headers).size >= 4) return table;
  }
  return null;
}

/**
 * First table matching the odds-board header shape: a fixture/match column plus
 * at least three of the odds-value columns (1/X/2/over/under), else null.
 */
export function selectOddsTable(tables: readonly RawTable[]): RawTable | null {
  const valueFields: OddsField[] = ["home", "draw", "away", "over", "under"];
  for (const table of tables) {
    const map = mapOddsHeaders(table.headers);
    const values = valueFields.filter((f) => map.has(f)).length;
    if (map.has("match") && values >= 3) return table;
  }
  return null;
}

/** Map a standings table to lenient extraction rows by header name. */
export function statsRowsFrom(table: RawTable): ExtractedStatsRow[] {
  const map = mapStatsHeaders(table.headers);
  const at = (cells: string[], field: StatField): string | undefined => {
    const index = map.get(field);
    return index === undefined ? undefined : cells[index];
  };
  const teamIndex = map.get("team");
  return table.rows.map((cells) => {
    const form = (at(cells, "form") ?? "").replace(/\s+/g, "");
    return {
      team: teamIndex === undefined ? "" : (cells[teamIndex] ?? "").trim(),
      played: parseIntCell(at(cells, "played")),
      wins: parseIntCell(at(cells, "wins")),
      draws: parseIntCell(at(cells, "draws")),
      losses: parseIntCell(at(cells, "losses")),
      goalsFor: parseIntCell(at(cells, "goalsFor")),
      goalsAgainst: parseIntCell(at(cells, "goalsAgainst")),
      points: parseIntCell(at(cells, "points")),
      form: form.length > 0 ? form : null
    };
  });
}

/** Map an odds table to lenient extraction rows by header name. */
export function oddsRowsFrom(table: RawTable): ExtractedOddsRow[] {
  const map = mapOddsHeaders(table.headers);
  // Kickoff is not part of the graded odds vocabulary; capture it literally when
  // present (it is nice-to-have for the demo, never used for accuracy).
  const kickoffIndex = table.headers.findIndex((h) => normalizeHeader(h) === "kickoff");
  const matchIndex = map.get("match");
  const cellOrNull = (cells: string[], field: OddsField): string | null => {
    const index = map.get(field);
    if (index === undefined) return null;
    const text = (cells[index] ?? "").trim();
    return text.length > 0 ? text : null;
  };
  return table.rows.map((cells) => {
    const matchText = matchIndex === undefined ? "" : (cells[matchIndex] ?? "").trim();
    const parts = matchText.split(" vs ");
    const [homeTeam, awayTeam] =
      parts.length === 2 ? [parts[0] ?? "", parts[1] ?? ""] : [matchText, ""];
    const kickoff =
      kickoffIndex >= 0 ? (cells[kickoffIndex] ?? "").trim() || null : null;
    return {
      kickoff,
      homeTeam,
      awayTeam,
      homeOdds: cellOrNull(cells, "home"),
      drawOdds: cellOrNull(cells, "draw"),
      awayOdds: cellOrNull(cells, "away"),
      overOdds: cellOrNull(cells, "over"),
      underOdds: cellOrNull(cells, "under"),
      totalsLine: "2.5"
    };
  });
}
