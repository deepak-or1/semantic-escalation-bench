import {
  ExtractedOddsPageSchema,
  ExtractedStatsPageSchema,
  NormalizedTeamStatsSchema,
  parseOddsValue,
  type EngineName,
  type ExtractedOddsRow,
  type ExtractedStatsRow,
  type NormalizedDataset,
  type NormalizedMarket,
  type NormalizedTeamStats,
  type OddsFormat
} from "@ssda/shared";

/**
 * Deterministic adapters from lenient extraction shapes to the canonical
 * dataset. All the "is this data usable" judgement lives here and in
 * assessDataset — never inside the extractors — so both engines are graded
 * by identical rules.
 */

export function canonicalName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

export interface SchemaCheck {
  ok: boolean;
  issues: string[];
}

export function checkStatsSchema(raw: unknown): SchemaCheck & { parsed?: ExtractedStatsRow[] } {
  const result = ExtractedStatsPageSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((i) => `stats ${i.path.join(".")}: ${i.message}`)
    };
  }
  return { ok: true, issues: [], parsed: result.data.rows };
}

export function checkOddsSchema(raw: unknown): SchemaCheck & { parsed?: ExtractedOddsRow[] } {
  const result = ExtractedOddsPageSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((i) => `odds ${i.path.join(".")}: ${i.message}`)
    };
  }
  return { ok: true, issues: [], parsed: result.data.rows };
}

export interface NormalizedStats {
  teams: NormalizedTeamStats[];
  warnings: string[];
  failures: string[];
}

export function normalizeStats(rows: ExtractedStatsRow[]): NormalizedStats {
  const teams: NormalizedTeamStats[] = [];
  const warnings: string[] = [];
  const failures: string[] = [];

  rows.forEach((row, index) => {
    const name = canonicalName(row.team);
    const label = name || `row ${index + 1}`;
    if (!name) {
      failures.push(`stats row ${index + 1}: empty team name`);
      return;
    }
    if (row.played === null) {
      failures.push(`${label}: played is missing/unreadable`);
      return;
    }
    const missingFields: string[] = [];
    if (row.goalsFor === null) missingFields.push("goalsFor");
    if (row.goalsAgainst === null) missingFields.push("goalsAgainst");

    const form =
      typeof row.form === "string"
        ? row.form.toUpperCase().replace(/[^WDL]/g, "")
        : undefined;

    const candidate = {
      name,
      played: row.played,
      goalsFor: row.goalsFor,
      goalsAgainst: row.goalsAgainst,
      ...(row.wins !== null && row.wins !== undefined ? { wins: row.wins } : {}),
      ...(row.draws !== null && row.draws !== undefined ? { draws: row.draws } : {}),
      ...(row.losses !== null && row.losses !== undefined ? { losses: row.losses } : {}),
      ...(row.points !== null && row.points !== undefined ? { points: row.points } : {}),
      ...(form ? { form } : {}),
      missingFields
    };
    const parsed = NormalizedTeamStatsSchema.safeParse(candidate);
    if (!parsed.success) {
      // Faithfully-extracted nonsense (negative played etc.) lands here — it
      // must surface as a hard failure, not silently disappear.
      failures.push(
        `${label}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`
      );
      return;
    }
    if (missingFields.length > 0) {
      warnings.push(`${label}: missing ${missingFields.join(", ")}`);
    }
    teams.push(parsed.data);
  });

  return { teams, warnings, failures };
}

export interface NormalizedOdds {
  markets: NormalizedMarket[];
  warnings: string[];
  failures: string[];
}

function parseCell(
  raw: string | null | undefined,
  cell: string,
  fixture: string,
  warnings: string[],
  formats: Set<OddsFormat>
): number | undefined {
  if (raw === null || raw === undefined || raw.trim() === "") {
    warnings.push(`${fixture}: ${cell} missing`);
    return undefined;
  }
  const parsed = parseOddsValue(raw);
  if (!parsed) {
    warnings.push(`${fixture}: ${cell} unusable ("${raw.trim()}")`);
    return undefined;
  }
  formats.add(parsed.format);
  return parsed.decimal;
}

export function normalizeOdds(rows: ExtractedOddsRow[]): NormalizedOdds {
  const markets: NormalizedMarket[] = [];
  const warnings: string[] = [];
  const failures: string[] = [];

  rows.forEach((row, index) => {
    const homeTeam = canonicalName(row.homeTeam);
    const awayTeam = canonicalName(row.awayTeam);
    if (!homeTeam || !awayTeam) {
      failures.push(`odds row ${index + 1}: missing team name(s)`);
      return;
    }
    const fixture = `${homeTeam} vs ${awayTeam}`;
    const formats = new Set<OddsFormat>();

    const home = parseCell(row.homeOdds, "homeOdds", fixture, warnings, formats);
    const draw = parseCell(row.drawOdds, "drawOdds", fixture, warnings, formats);
    const away = parseCell(row.awayOdds, "awayOdds", fixture, warnings, formats);
    const over = parseCell(row.overOdds, "overOdds", fixture, warnings, formats);
    const under = parseCell(row.underOdds, "underOdds", fixture, warnings, formats);

    const lineMatch = row.totalsLine?.match(/(\d+(?:\.\d+)?)/);
    const line = lineMatch ? Number.parseFloat(lineMatch[1] as string) : 2.5;

    const oneXTwo =
      home !== undefined && draw !== undefined && away !== undefined
        ? { home, draw, away }
        : undefined;
    if (!oneXTwo && (home !== undefined || draw !== undefined || away !== undefined)) {
      warnings.push(`${fixture}: incomplete 1X2 trio dropped`);
    }
    const totals =
      over !== undefined && under !== undefined ? { line, over, under } : undefined;
    if (!totals && (over !== undefined || under !== undefined)) {
      warnings.push(`${fixture}: incomplete totals pair dropped`);
    }
    if (!oneXTwo && !totals) {
      warnings.push(`${fixture}: no usable odds — row dropped`);
      return;
    }

    const sourceFormat: NormalizedMarket["sourceFormat"] =
      formats.size > 1 ? "mixed" : (formats.values().next().value ?? "decimal");

    markets.push({
      homeTeam,
      awayTeam,
      ...(row.kickoff ? { kickoff: row.kickoff } : {}),
      ...(oneXTwo ? { oneXTwo } : {}),
      ...(totals ? { totals } : {}),
      sourceFormat
    });
  });

  return { markets, warnings, failures };
}

export function buildDataset(input: {
  engine: EngineName;
  source: string;
  seed?: number;
  stats?: NormalizedStats;
  odds?: NormalizedOdds;
  extractedAt?: string;
}): NormalizedDataset {
  return {
    teams: input.stats?.teams ?? [],
    markets: input.odds?.markets ?? [],
    warnings: [...(input.stats?.warnings ?? []), ...(input.odds?.warnings ?? [])],
    failures: [...(input.stats?.failures ?? []), ...(input.odds?.failures ?? [])],
    meta: {
      engine: input.engine,
      source: input.source,
      extractedAt: input.extractedAt ?? new Date().toISOString(),
      ...(input.seed !== undefined ? { seed: input.seed } : {})
    }
  };
}
