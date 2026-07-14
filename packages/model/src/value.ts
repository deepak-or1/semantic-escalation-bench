import { decimalToImplied, removeVig } from "@ssda/shared";

export type MarketSide = "home" | "draw" | "away" | "over25" | "under25";

export interface ValueSelection {
  fixture: string;
  homeTeam: string;
  awayTeam: string;
  kickoff?: string;
  market: MarketSide;
  label: string;
  decimalOdds: number;
  modelProbability: number;
  impliedRaw: number;
  impliedNoVig: number;
  edge: number;
  expectedValuePerUnit: number;
  confidence: "high" | "medium" | "low";
  notes: string[];
}

/** Profit/loss expectation of a 1-unit stake at fair-vs-model probability `p`. */
export function expectedValuePerUnit(p: number, decimalOdds: number): number {
  return p * (decimalOdds - 1) - (1 - p);
}

/** Implied probabilities with the bookmaker margin removed, in input order. */
export function devig(decimalOdds: readonly number[]): number[] {
  return removeVig(decimalOdds.map((o) => decimalToImplied(o)));
}

/** One rung down the confidence ladder; low is the floor. */
export function downgradeConfidence(
  label: "high" | "medium" | "low"
): "high" | "medium" | "low" {
  return label === "high" ? "medium" : "low";
}
