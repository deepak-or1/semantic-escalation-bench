import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ChaosFlagSchema, type ChaosFlag } from "./chaos";
import { ChaosParamsSchema, validateChaosConfig } from "./chaosParams";
import {
  ExpectedOutcomeSchema,
  ScenarioSpecSchema,
  SessionModeSchema,
  type ScenarioSpec
} from "./schemas/benchmark";
import { SCENARIOS } from "./scenarios";

/**
 * The machine-readable scenario-suite package (PROTOCOL_2A §4/§5 item 4). Sol
 * authors this JSON after the stage-1 policy freeze; the repo author commits it
 * byte-for-byte and the diff gate (§6) re-verifies its hash. This module is the
 * generic loader/validator/hasher — it fixes the FORMAT and the validation rules
 * at stage 1; the concrete values are held out.
 *
 * Analysis-stratum labels (§3): F1/F2/F3 are the ordered single-axis series, K is
 * the categorical named conditions, X is the predeclared interactions. `S`
 * (validator safety) is reserved for Phase 2B and never appears in a 2A package,
 * so it is intentionally absent from the enum.
 */
export const StratumSchema = z.enum(["F1", "F2", "F3", "K", "X"]);
export type Stratum = z.infer<typeof StratumSchema>;

/**
 * The frozen per-policy prediction enum (PROTOCOL_2A §4a). With N=5, "pass/fail"
 * is ambiguous for a 4/5 cell, so the enum is exactly two values: `all-pass`
 * (observed 5/5 judged-correct) and `observed-failure` (observed 0–4/5). Scored
 * report-only by the verifier; a prediction miss can never fail any gate.
 */
export const PredictionSchema = z.enum(["all-pass", "observed-failure"]);
export type Prediction = z.infer<typeof PredictionSchema>;

/** One prediction per frozen policy (A, B, B2, C, D) — the five-policy ladder (§1). */
export const ScenarioPredictionsSchema = z.object({
  A: PredictionSchema,
  B: PredictionSchema,
  B2: PredictionSchema,
  C: PredictionSchema,
  D: PredictionSchema
});
export type ScenarioPredictions = z.infer<typeof ScenarioPredictionsSchema>;

/**
 * A single held-out scenario. Carries the same rendering inputs as a Phase-1
 * ScenarioSpec (chaos flags and/or §3 params, seed, session, expected) plus the
 * analysis metadata sol authors: the stratum + condition/level identifier, and
 * the frozen per-policy prediction table (§4a). `group` is not part of the
 * package; suiteScenarioToSpec resolves it to the schema default when the runner
 * needs a ScenarioSpec.
 */
export const SuiteScenarioSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  chaos: z.array(ChaosFlagSchema),
  params: ChaosParamsSchema.optional(),
  seed: z.number().int(),
  session: SessionModeSchema,
  expected: ExpectedOutcomeSchema,
  stratum: StratumSchema,
  /** The level/condition identifier within the stratum, e.g. "level-2" or "header-1". */
  stratumId: z.string().min(1),
  predictions: ScenarioPredictionsSchema,
  predictionNote: z.string().optional()
});
export type SuiteScenario = z.infer<typeof SuiteScenarioSchema>;

export const ScenarioSuiteSchema = z.object({
  protocolId: z.string().min(1),
  scenarios: z.array(SuiteScenarioSchema).min(1)
});
export type ScenarioSuiteFile = z.infer<typeof ScenarioSuiteSchema>;

/** Reserved Phase-2A seed range (PROTOCOL_2A §4), disjoint from Phase 1's 1101–1124. */
export const SUITE_SEED_MIN = 2201;
export const SUITE_SEED_MAX = 2299;

/**
 * The scaffold every F2 scenario must carry (PROTOCOL_2A §3): the lab renders
 * `next-page` only under `pagination` and `reveal-table` only under `hiddenTab`,
 * so without both flags an F2 decoy would rebind controls that do not exist.
 */
const F2_SCAFFOLD_FLAGS: readonly ChaosFlag[] = ["pagination", "hiddenTab"];

/** Every validation rejection raises this so callers can name the failing suite. */
export class ScenarioSuiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioSuiteError";
  }
}

export interface LoadedScenarioSuite {
  protocolId: string;
  scenarios: SuiteScenario[];
  /** SHA-256 (hex) of the raw suite-file bytes (PROTOCOL_2A §5 item 4). */
  suiteHash: string;
}

/** Recursively sort object keys so a value serializes to stable, canonical bytes. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * The canonical JSON serialization of a scenario array (PROTOCOL_2A §5 item 4):
 * deterministic, key-sorted bytes. Exported so it is the SINGLE code path that
 * computeBuiltinCatalogHash uses — the built-in-catalog suiteHash is the SHA-256
 * of this, never a separately-maintained serialization.
 */
export function serializeScenariosCanonical(scenarios: readonly ScenarioSpec[]): string {
  return JSON.stringify(sortKeysDeep(scenarios));
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The suiteHash a run stamps when it runs on the built-in Phase-1 catalog:
 * SHA-256 of the catalog's canonical JSON serialization, via the one serializer
 * above (PROTOCOL_2A §5 item 4). Distinct from a suite-file hash, which is over
 * raw file bytes.
 */
export function computeBuiltinCatalogHash(): string {
  return sha256Hex(serializeScenariosCanonical(SCENARIOS));
}

/**
 * Validate and hash a scenario-suite package. `rawBytes` are the exact file bytes
 * (the suiteHash is SHA-256 over them); `text` is their UTF-8 decode. Kept
 * separate from loadScenarioSuite so callers with the bytes in hand (or tests)
 * can validate without a filesystem read.
 *
 * Validation order — each failure raises a named ScenarioSuiteError:
 *  1. JSON parse + schema (bad stratum / bad prediction value surface here).
 *  2. Seed range 2201–2299 inclusive (§4).
 *  3. Every cell is expected: "success" (§3).
 *  4. Every cell is fresh-session (§3).
 *  5. Scenario-ID uniqueness — SEEDS MAY INTENTIONALLY REPEAT across levels (§4),
 *     so uniqueness is enforced on ids, never on seeds.
 *  6. Full §3 config validation via the single-sourced validateChaosConfig (XOR
 *     precedence, columnOrder permutation, decoy scaffold/layout, timing flags,
 *     inverted ranges) — the same rules the lab config API enforces.
 *  7. Every F2 scenario carries the [pagination, hiddenTab] scaffold (§3).
 */
export function parseScenarioSuite(text: string, rawBytes: Buffer): LoadedScenarioSuite {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ScenarioSuiteError(
      `scenario suite is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const parsed = ScenarioSuiteSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ScenarioSuiteError(`scenario suite failed schema validation: ${issues}`);
  }
  const suite = parsed.data;

  for (const s of suite.scenarios) {
    if (s.seed < SUITE_SEED_MIN || s.seed > SUITE_SEED_MAX) {
      throw new ScenarioSuiteError(
        `scenario "${s.id}" seed ${s.seed} is outside the reserved Phase-2A seed range ` +
          `${SUITE_SEED_MIN}–${SUITE_SEED_MAX} (§4)`
      );
    }
  }

  // Every Phase-2A cell is expected: success (§3, stratum S). The machinery is
  // fail-loud: the loader REJECTS a non-success expectation rather than trusting
  // authoring discipline (validator safety belongs to Phase 2B, under its own tag).
  for (const s of suite.scenarios) {
    if (s.expected !== "success") {
      throw new ScenarioSuiteError(
        `scenario "${s.id}" has expected "${s.expected}" — every Phase-2A cell must be ` +
          `expected: "success" (§3)`
      );
    }
  }

  // Every Phase-2A cell is fresh-session (§3): F/K/X are presentation/addressing
  // perturbations only. Rejected fail-loud here so the verifier's grading
  // recomputation (which assumes fresh-session) never faces a mid-suite exception.
  for (const s of suite.scenarios) {
    if (s.session !== "fresh") {
      throw new ScenarioSuiteError(
        `scenario "${s.id}" has session "${s.session}" — every Phase-2A cell must be ` +
          `fresh-session (§3)`
      );
    }
  }

  const seenIds = new Set<string>();
  for (const s of suite.scenarios) {
    if (seenIds.has(s.id)) {
      throw new ScenarioSuiteError(
        `duplicate scenario id "${s.id}" — scenario ids must be unique (seeds may repeat across levels, §4)`
      );
    }
    seenIds.add(s.id);
  }

  // Full §3 config validation, single-sourced with the lab config API
  // (validateChaosConfig): XOR precedence, columnOrder permutation, decoy scaffold
  // presence, decoy-vs-layout, timing-param-needs-its-flag, and inverted ranges.
  // Every violation is a NAMED load-time rejection, never a mid-run lab 400.
  for (const s of suite.scenarios) {
    const errors = validateChaosConfig(s.chaos, s.params ?? {});
    if (errors.length > 0) {
      throw new ScenarioSuiteError(`scenario "${s.id}" has an invalid perturbation config: ${errors.join(" ")}`);
    }
  }

  for (const s of suite.scenarios) {
    if (s.stratum !== "F2") continue;
    const missing = F2_SCAFFOLD_FLAGS.filter((flag) => !s.chaos.includes(flag));
    if (missing.length > 0) {
      throw new ScenarioSuiteError(
        `F2 scenario "${s.id}" is missing the required scaffold flag(s) [${missing.join(", ")}] — ` +
          `every F2 scenario must carry chaos [pagination, hiddenTab] (§3)`
      );
    }
  }

  return {
    protocolId: suite.protocolId,
    scenarios: suite.scenarios,
    suiteHash: sha256Hex(rawBytes)
  };
}

/** Read, validate, and hash a scenario-suite JSON file (PROTOCOL_2A §5 item 4). */
export function loadScenarioSuite(filePath: string): LoadedScenarioSuite {
  const rawBytes = readFileSync(filePath);
  return parseScenarioSuite(rawBytes.toString("utf8"), rawBytes);
}

/**
 * Project a suite scenario onto the runner's ScenarioSpec (the analysis metadata —
 * stratum, stratumId, predictions — lives only in the suite file, which the
 * verifier reads separately). `group` resolves to the schema default via the
 * parse.
 */
export function suiteScenarioToSpec(s: SuiteScenario): ScenarioSpec {
  return ScenarioSpecSchema.parse({
    id: s.id,
    name: s.name,
    description: s.description,
    chaos: s.chaos,
    seed: s.seed,
    session: s.session,
    expected: s.expected,
    ...(s.params ? { params: s.params } : {})
  });
}
