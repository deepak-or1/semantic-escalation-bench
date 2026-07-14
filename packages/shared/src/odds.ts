/**
 * Odds conversion utilities. Decimal odds are the canonical internal format;
 * everything else is converted on the way in.
 */

export type OddsFormat = "decimal" | "american";

export function americanToDecimal(american: number): number {
  if (!Number.isFinite(american) || Math.abs(american) < 100) {
    throw new Error(`americanToDecimal: invalid American odds ${american}`);
  }
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

export function decimalToAmerican(decimal: number): number {
  if (!Number.isFinite(decimal) || decimal <= 1) {
    throw new Error(`decimalToAmerican: invalid decimal odds ${decimal}`);
  }
  return decimal >= 2
    ? Math.round((decimal - 1) * 100)
    : -Math.round(100 / (decimal - 1));
}

export function formatAmerican(american: number): string {
  return american > 0 ? `+${american}` : String(american);
}

export function decimalToImplied(decimal: number): number {
  if (!Number.isFinite(decimal) || decimal <= 1) {
    throw new Error(`decimalToImplied: invalid decimal odds ${decimal}`);
  }
  return 1 / decimal;
}

export function impliedToDecimal(probability: number): number {
  if (!(probability > 0) || probability >= 1) {
    throw new Error(`impliedToDecimal: invalid probability ${probability}`);
  }
  return 1 / probability;
}

/** Sum of implied probabilities minus 1 — the bookmaker margin. */
export function overround(implied: readonly number[]): number {
  return implied.reduce((acc, p) => acc + p, 0) - 1;
}

/** Normalise implied probabilities so they sum to 1 (removes the vig). */
export function removeVig(implied: readonly number[]): number[] {
  const total = implied.reduce((acc, p) => acc + p, 0);
  if (total <= 0) throw new Error("removeVig: probabilities sum to <= 0");
  return implied.map((p) => p / total);
}

/**
 * Parse a raw odds cell as scraped from a page. Accepts decimal ("1.85",
 * "12.5") and American ("+120", "-145") formats. Returns null when the cell
 * is not a usable odds value ("—", "N/A", "abc", "0.62", ...).
 */
export function parseOddsValue(
  raw: string
): { decimal: number; format: OddsFormat } | null {
  const s = raw.trim();
  if (/^[+-]\d+$/.test(s)) {
    const american = Number.parseInt(s, 10);
    if (Math.abs(american) < 100) return null;
    return { decimal: americanToDecimal(american), format: "american" };
  }
  if (/^\d+(\.\d+)?$/.test(s)) {
    const decimal = Number.parseFloat(s);
    if (decimal > 1 && decimal <= 1000) return { decimal, format: "decimal" };
  }
  return null;
}
