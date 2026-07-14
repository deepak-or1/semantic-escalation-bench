/**
 * Tiny formatting + escaping helpers shared across the dashboard renderer.
 * No dependencies — safe to import from both the data and render layers.
 */

/** HTML-escape any value for safe interpolation into markup (incl. attributes). */
export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// `<` (could start </script>) and the two Unicode line separators (illegal in
// JS string literals) — anything that could corrupt an embedded JSON island.
const SCRIPT_UNSAFE = new RegExp("[<\\u2028\\u2029]", "g");

/** Serialize a value for safe embedding inside a <script> tag. */
export function jsonForScript(data: unknown): string {
  return JSON.stringify(data).replace(
    SCRIPT_UNSAFE,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

/** Fraction (0–1) to a percentage string. */
export function pct(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Milliseconds to a seconds string. */
export function secs(ms: number, digits = 2): string {
  return `${(ms / 1000).toFixed(digits)}s`;
}

/** Signed percentage with a sign always shown (e.g. "+4.2%" / "-1.1%"). */
export function signedPct(fraction: number, digits = 1): string {
  const s = (fraction * 100).toFixed(digits);
  return fraction >= 0 ? `+${s}%` : `${s}%`;
}

/** Truncate to a max length with an ellipsis so SVG gutter labels never clip. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Clamp a number into [min, max]. */
export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * A "nice" axis maximum plus evenly spaced ticks from 0. Rounds the step to a
 * clean 1/2/2.5/5/10 × 10ⁿ so ticks read as round numbers.
 */
export function niceTicks(max: number, count = 4): { max: number; ticks: number[] } {
  if (!Number.isFinite(max) || max <= 0) return { max: 1, ticks: [0, 1] };
  const rawStep = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  let stepUnit: number;
  if (norm <= 1) stepUnit = 1;
  else if (norm <= 2) stepUnit = 2;
  else if (norm <= 2.5) stepUnit = 2.5;
  else if (norm <= 5) stepUnit = 5;
  else stepUnit = 10;
  const step = stepUnit * mag;
  const niceMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= niceMax + step * 1e-6; v += step) {
    ticks.push(Math.round(v * 1e6) / 1e6);
  }
  return { max: niceMax, ticks };
}

/** Path for a bar with only its data-end (right) corners rounded, square at the baseline. */
export function barPathRight(x: number, y: number, w: number, h: number, r: number): string {
  if (w <= 0 || h <= 0) return "";
  const rr = Math.max(0, Math.min(r, w, h / 2));
  return (
    `M${x},${y} h${w - rr}` +
    ` a${rr},${rr} 0 0 1 ${rr},${rr}` +
    ` v${h - 2 * rr}` +
    ` a${rr},${rr} 0 0 1 ${-rr},${rr}` +
    ` h${-(w - rr)} z`
  );
}
