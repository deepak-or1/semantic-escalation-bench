import { assessDataset, decimalToImplied, type NormalizedDataset } from "@ssda/shared";
import { forecastMatch } from "./forecast";
import { resolveParams, type ModelParams } from "./params";
import { deriveStrengths } from "./strengths";
import {
  devig,
  downgradeConfidence,
  expectedValuePerUnit,
  type MarketSide,
  type ValueSelection
} from "./value";

export interface Watchlist {
  generatedAt: string;
  paramsUsed: ModelParams;
  datasetConfidence: { label: "high" | "medium" | "low"; reasons: string[] };
  selections: ValueSelection[];
  allSelections: ValueSelection[];
  limitations: string[];
}

// Always-present caveats, ordered from most to least model-specific. Any
// skipped-market notes are appended after these.
const LIMITATIONS = [
  "Home and away goals are modelled as independent Poisson draws (no Dixon-Coles low-score correction).",
  "Scoring rates are estimated from a single partial season and carry sampling noise.",
  "Home advantage is a constant multiplier, not fit per team or venue.",
  "Recent form is a crude 3/1/0-points heuristic over the last five results.",
  "Bookmaker margin means small modelled edges are usually noise, not genuine value.",
  "Research demo — not betting advice."
];

const DEFAULT_MIN_EDGE = 0.02;

export function datasetConfidence(
  dataset: NormalizedDataset
): { label: "high" | "medium" | "low"; reasons: string[] } {
  const { failures, warnings } = assessDataset(dataset);
  if (failures.length > 0) {
    return { label: "low", reasons: failures };
  }
  if (warnings.length === 0 && dataset.teams.length >= 10 && dataset.markets.length >= 4) {
    return { label: "high", reasons: [] };
  }
  return { label: "medium", reasons: warnings.length > 0 ? warnings : ["small dataset"] };
}

export function buildWatchlist(
  dataset: NormalizedDataset,
  options: { params?: Partial<ModelParams>; minEdge?: number; now?: string } = {}
): Watchlist {
  const params = resolveParams(options.params);
  const minEdge = options.minEdge ?? DEFAULT_MIN_EDGE;
  const generatedAt = options.now ?? new Date().toISOString();

  const confidence = datasetConfidence(dataset);
  const { strengths, leagueAvgObserved } = deriveStrengths(dataset.teams, params);
  // Forecast off the observed rate, not the default fallback; report what we used.
  const forecastParams: ModelParams = { ...params, leagueAvgGoals: leagueAvgObserved };
  const paramsUsed: ModelParams = { ...params, leagueAvgGoals: leagueAvgObserved };

  const allSelections: ValueSelection[] = [];
  const limitations = [...LIMITATIONS];

  for (const market of dataset.markets) {
    const home = strengths.get(market.homeTeam);
    const away = strengths.get(market.awayTeam);
    const fixture = `${market.homeTeam} vs ${market.awayTeam}`;
    if (!home || !away) {
      const missing = !home ? market.homeTeam : market.awayTeam;
      limitations.push(`skipped market ${fixture}: unknown team ${missing}`);
      continue;
    }

    const forecast = forecastMatch(home, away, forecastParams);
    const teamNotes = [...new Set([...home.notes, ...away.notes])];
    const selConfidence = teamNotes.length > 0 ? downgradeConfidence(confidence.label) : confidence.label;

    const build = (
      market_: MarketSide,
      label: string,
      odds: number,
      prob: number,
      noVig: number
    ): ValueSelection => ({
      fixture,
      homeTeam: market.homeTeam,
      awayTeam: market.awayTeam,
      kickoff: market.kickoff,
      market: market_,
      label,
      decimalOdds: odds,
      modelProbability: prob,
      impliedRaw: decimalToImplied(odds),
      impliedNoVig: noVig,
      edge: prob - noVig,
      expectedValuePerUnit: expectedValuePerUnit(prob, odds),
      confidence: selConfidence,
      notes: teamNotes
    });

    if (market.oneXTwo) {
      const nv = devig([market.oneXTwo.home, market.oneXTwo.draw, market.oneXTwo.away]);
      allSelections.push(
        build("home", `${market.homeTeam} win`, market.oneXTwo.home, forecast.probs.home, nv[0] as number),
        build("draw", "Draw", market.oneXTwo.draw, forecast.probs.draw, nv[1] as number),
        build("away", `${market.awayTeam} win`, market.oneXTwo.away, forecast.probs.away, nv[2] as number)
      );
    }
    if (market.totals) {
      const nv = devig([market.totals.over, market.totals.under]);
      allSelections.push(
        build("over25", "Over 2.5 goals", market.totals.over, forecast.probs.over25, nv[0] as number),
        build("under25", "Under 2.5 goals", market.totals.under, forecast.probs.under25, nv[1] as number)
      );
    }
  }

  const byEvDesc = (a: ValueSelection, b: ValueSelection): number =>
    b.expectedValuePerUnit - a.expectedValuePerUnit;
  allSelections.sort(byEvDesc);
  const selections = allSelections.filter((s) => s.edge > minEdge);

  return {
    generatedAt,
    paramsUsed,
    datasetConfidence: confidence,
    selections,
    allSelections,
    limitations
  };
}
