import { z } from "zod";

/**
 * Phase-2A perturbation PARAMETERS (PROTOCOL_2A §3). These are the parameterized
 * form of the Phase-1 binary chaos flags: the machinery (schema + plumbing) is
 * frozen at stage 1, while the concrete VALUES are held-out scenario data authored
 * after the policy freeze. Renderers are out of scope here (a later stage wires the
 * lab side); this module only fixes the schema and the flag-XOR-param contract.
 *
 * Precedence rule (§3): for any rendering surface a scenario uses the legacy binary
 * chaos flag OR the new parameter, never both. Contradictory combinations are
 * rejected (validateChaosParamsCompat), never resolved silently.
 */

/** The 9 UI copy keys (apps/lab/src/copy.ts COPY_TABLE). */
export const COPY_KEYS = [
  "siteName",
  "statsHeading",
  "oddsHeading",
  "loginHeading",
  "loginButton",
  "fullTableTab",
  "nextButton",
  "prevButton",
  "acceptCookies"
] as const;
export const CopyKeySchema = z.enum(COPY_KEYS);
export type CopyKey = z.infer<typeof CopyKeySchema>;

/** The 9 stat column keys (apps/lab/src/render.ts STAT_COLUMNS). */
export const STAT_COLUMN_KEYS = ["P", "W", "D", "L", "GF", "GA", "GD", "Pts", "Form"] as const;
export const StatColumnKeySchema = z.enum(STAT_COLUMN_KEYS);
export type StatColumnKey = z.infer<typeof StatColumnKeySchema>;

/** The three engine step-name controls a decoy (§3 F2) can rebind. */
export const DECOY_CONTROLS = ["next-page", "reveal-table", "login-submit"] as const;
export const DecoyControlSchema = z.enum(DECOY_CONTROLS);
export type DecoyControl = z.infer<typeof DecoyControlSchema>;

export const DecoyPlacementSchema = z.enum(["before", "after"]);
export type DecoyPlacement = z.infer<typeof DecoyPlacementSchema>;

export const LayoutConditionSchema = z.enum(["wrapped", "cards"]);
export type LayoutCondition = z.infer<typeof LayoutConditionSchema>;

/** [min, max] millisecond range overriding the Phase-1 seeded ranges (§3 Timing). */
const RangeMsSchema = z.tuple([z.number().nonnegative(), z.number().nonnegative()]);

export const ChaosParamsSchema = z.object({
  /** F1 class drift level (§3): 0 off · 1 25% · 2 50% · 3 100% · 4 100% + ids removed. */
  classDriftLevel: z.number().int().min(0).max(4).optional(),
  /** F2 decoy rebinding level (§3): 0..3, level k rebinds the first k controls. */
  decoyLevel: z.number().int().min(0).max(3).optional(),
  /** Held-out decoy visible text per rebound control (§3 F2). */
  decoyCopy: z.record(DecoyControlSchema, z.string()).optional(),
  /** Decoy position relative to the functional control in document order (§3 F2). */
  decoyPlacement: DecoyPlacementSchema.optional(),
  /** F3 pagination stress (§3): rows per page (also ACTIVATES pagination). */
  pageSize: z.number().int().min(2).max(10).optional(),
  /** Stratum K header vocabulary: column/label key → rendered string. */
  headerVocab: z.record(z.string(), z.string()).optional(),
  /** Stratum K UI copy: one of the 9 copy keys → rendered string. */
  uiCopy: z.record(CopyKeySchema, z.string()).optional(),
  /** Stratum K column order: an explicit permutation of the 9 stat columns. */
  columnOrder: z.array(StatColumnKeySchema).optional(),
  /** Stratum K layout: table nested in non-semantic divs, or a card grid. */
  layoutCondition: LayoutConditionSchema.optional(),
  /** [min,max] page-render delay range (ms), overriding the seeded range. */
  delayRangeMs: RangeMsSchema.optional(),
  /** [min,max] network-latency range (ms), overriding the seeded range. */
  networkDelayRangeMs: RangeMsSchema.optional()
});
export type ChaosParams = z.infer<typeof ChaosParamsSchema>;

/**
 * Each legacy chaos flag paired with the parameter that supersedes it for the same
 * rendering surface (§3 precedence). Using BOTH is a contradiction, rejected here.
 */
const FLAG_PARAM_CONFLICTS: ReadonlyArray<readonly [string, keyof ChaosParams]> = [
  ["columnShuffle", "columnOrder"],
  ["copyDrift", "uiCopy"],
  ["classDrift", "classDriftLevel"],
  ["layoutVariant", "layoutCondition"],
  ["pagination", "pageSize"]
];

/**
 * Return human-readable errors for the §3 flag-XOR-param contradictions: a scenario
 * that carries a legacy chaos flag AND its parallel parameter for the same surface.
 * Empty array when the scenario is consistent (flag and param used separately).
 */
export function validateChaosParamsCompat(chaos: string[], params: ChaosParams): string[] {
  const errors: string[] = [];
  for (const [flag, param] of FLAG_PARAM_CONFLICTS) {
    if (chaos.includes(flag) && params[param] !== undefined) {
      errors.push(
        `chaos flag "${flag}" and param "${param}" are mutually exclusive (§3 precedence): ` +
          `a scenario uses the legacy binary chaos flag OR the new parameter, never both.`
      );
    }
  }
  return errors;
}

/** Timing param → the chaos flag it re-bounds (both work together; not an XOR pair). */
const DELAY_FLAG: Record<"delayRangeMs" | "networkDelayRangeMs", string> = {
  delayRangeMs: "delayedRender",
  networkDelayRangeMs: "networkDelay"
};

/**
 * The FULL pure §3 config validator, single-sourced here so the lab config API
 * (apps/lab validateLabConfig) and the suite loader (parseScenarioSuite) reject the
 * IDENTICAL set of violations — a §3-violating scenario fails loudly at LOAD time,
 * never mid-run. A superset of validateChaosParamsCompat: it adds every rule the
 * zod schema cannot express —
 *  - the five flag-XOR-param contradictions (via validateChaosParamsCompat);
 *  - columnOrder must be an exact permutation of the 9 stat columns;
 *  - decoy scaffold presence: decoyLevel ≥ 1 rebinds `next-page` (needs the
 *    pagination scaffold — `pagination` flag or `pageSize`), ≥ 2 rebinds
 *    `reveal-table` (needs `hiddenTab`); level 3 also rebinds the always-present
 *    `login-submit`;
 *  - decoyLevel ≥ 1 cannot compose with a layout condition (§3 "Layout suppresses
 *    pagination" — `next-page` never renders under a layout);
 *  - timing params re-bound an active seeded draw, so each needs its flag;
 *  - inverted [min,max] timing ranges.
 * Returns human-readable strings; empty ⇒ the config is admissible.
 */
export function validateChaosConfig(chaos: string[], params: ChaosParams): string[] {
  const errors = validateChaosParamsCompat(chaos, params);

  // columnOrder must be an EXACT permutation of the 9 stat columns. The schema
  // already guarantees each entry is a valid key; here we reject wrong length or
  // duplicates (both ⇒ not a permutation).
  if (params.columnOrder !== undefined) {
    const distinct = new Set(params.columnOrder).size;
    if (params.columnOrder.length !== STAT_COLUMN_KEYS.length || distinct !== STAT_COLUMN_KEYS.length) {
      errors.push(
        `param "columnOrder" must be an exact permutation of the 9 stat columns ` +
          `[${STAT_COLUMN_KEYS.join(", ")}] (got ${JSON.stringify(params.columnOrder)}).`
      );
    }
  }

  // decoyLevel k rebinds the first k of [next-page, reveal-table, login-submit].
  // next-page/reveal-table only exist behind their scaffold; fail loudly, never
  // silently, when a rebound control has no scaffold to render it.
  const level = params.decoyLevel ?? 0;
  const paginationScaffold = chaos.includes("pagination") || params.pageSize !== undefined;
  if (level >= 1 && !paginationScaffold) {
    errors.push(
      `param "decoyLevel" ${level} rebinds "next-page" but its pagination scaffold is ` +
        `absent (set chaos flag "pagination" or param "pageSize").`
    );
  }
  if (level >= 2 && !chaos.includes("hiddenTab")) {
    errors.push(
      `param "decoyLevel" ${level} rebinds "reveal-table" but its scaffold flag ` +
        `"hiddenTab" is absent.`
    );
  }
  // level 3 also rebinds login-submit, which always exists — no scaffold needed.

  // A layout condition (flag or param) suppresses the whole pagination render path,
  // so "next-page" never renders (§3 "Layout suppresses pagination"). decoyLevel ≥ 1
  // always rebinds next-page, so it cannot compose with a layout condition — reject
  // rather than rebind a control that does not exist, even if a pagination scaffold
  // is nominally present.
  if (level >= 1) {
    const layoutFlag = chaos.includes("layoutVariant");
    const layoutParam = params.layoutCondition !== undefined;
    if (layoutFlag || layoutParam) {
      const source = layoutFlag ? 'chaos flag "layoutVariant"' : 'param "layoutCondition"';
      errors.push(
        `param "decoyLevel" ${level} rebinds "next-page" but a layout condition ` +
          `(${source}) suppresses the pagination render path (§3 "Layout suppresses ` +
          `pagination"), so "next-page" never renders — the combination is rejected.`
      );
    }
  }

  // Timing ranges only RE-BOUND an already-active seeded draw; the param needs its
  // flag (delayedRender/networkDelay are not in the XOR list — they work together).
  for (const key of ["delayRangeMs", "networkDelayRangeMs"] as const) {
    const range = params[key];
    if (range === undefined) continue;
    const flag = DELAY_FLAG[key];
    if (!chaos.includes(flag)) {
      errors.push(
        `param "${key}" re-bounds a seeded timing draw but chaos flag "${flag}" is ` +
          `absent (the param needs its flag).`
      );
    }
    if (range[0] > range[1]) {
      errors.push(`param "${key}" [min,max] is inverted: ${range[0]} > ${range[1]}.`);
    }
  }

  return errors;
}
