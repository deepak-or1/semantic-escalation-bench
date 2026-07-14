import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BenchmarkResults } from "@ssda/shared";

/**
 * Cryptographically-pinned seed-cache manifests (Wave F F4). The v1 manifest
 * hashed only its own TEXT for provenance, so a referenced healed-cache.json
 * could change without changing the recorded `seedCacheHash`. The v2 manifest
 * carries trial/commit/model provenance and a per-cache content sha256, and the
 * verifying loader recomputes every cache's hash before a run trusts it — so a
 * swapped cache is caught, and `seedCacheHash` (the combined content hash) moves
 * whenever any referenced byte changes.
 */

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The on-disk v2 seed-cache manifest format. */
export interface SeedCacheManifestFile {
  generatedAt: string;
  /** Frozen selection rule — the FIRST healed trial per scenario in results.json
   *  trial order (scenario catalog order × engine order × ascending trial index). */
  selectionRule: "first-healed-trial-in-results-order";
  source: {
    benchId: string;
    gitCommit: string | null;
    gitDirty: boolean | null;
    stagehandModel?: string;
    promptsHash: string;
  };
  scenarios: Record<
    string,
    {
      cacheFile: string; // absolute path
      cacheSha256: string; // sha256 of the cache file bytes
      trialRunId: string;
      engine: string;
      trial: number;
      healedSteps: string[];
      createdAt: string;
    }
  >;
}

/**
 * Build a v2 manifest from a benchmark run's results. Iterates trials IN ORDER;
 * the FIRST healed trial per scenario wins (the frozen selection rule). Each
 * referenced healed-cache.json is read and its sha256 recorded; a missing file
 * becomes a warning and is skipped. The source block is derived from the run's
 * benchId + environment provenance.
 */
export async function buildHealsManifest(
  results: BenchmarkResults,
  benchDir: string
): Promise<{ manifest: SeedCacheManifestFile; warnings: string[]; found: number }> {
  const scenarios: SeedCacheManifestFile["scenarios"] = {};
  const warnings: string[] = [];
  let found = 0;

  for (const trial of results.trials) {
    if ((trial.healedSteps?.length ?? 0) === 0) continue;
    // First healed trial per scenario in results order (frozen selection rule).
    if (scenarios[trial.scenarioId]) continue;
    const cacheFile = path.resolve(benchDir, "trials", trial.runId, "artifacts", "healed-cache.json");
    if (!existsSync(cacheFile)) {
      warnings.push(
        `skipping ${trial.scenarioId}/${trial.engine}: no healed-cache.json at ${cacheFile}`
      );
      continue;
    }
    const bytes = await readFile(cacheFile);
    scenarios[trial.scenarioId] = {
      cacheFile,
      cacheSha256: sha256(bytes),
      trialRunId: trial.runId,
      engine: trial.engine,
      trial: trial.trial,
      healedSteps: [...(trial.healedSteps ?? [])],
      createdAt: results.createdAt
    };
    found += 1;
  }

  const env = results.environment;
  const manifest: SeedCacheManifestFile = {
    generatedAt: new Date().toISOString(),
    selectionRule: "first-healed-trial-in-results-order",
    source: {
      benchId: results.benchId,
      gitCommit: env.gitCommit,
      gitDirty: env.gitDirty,
      ...(env.stagehandModel ? { stagehandModel: env.stagehandModel } : {}),
      promptsHash: env.promptsHash
    },
    scenarios
  };
  return { manifest, warnings, found };
}

const REGEN_HINT = "regenerate with pnpm heals:collect";

/**
 * Load and cryptographically verify a v2 seed-cache manifest. REJECTS (throws)
 * any entry missing `cacheSha256` (e.g. a stale v1 manifest); for EVERY entry it
 * reads the referenced cache file and recomputes its sha256, throwing (naming the
 * scenario and both hashes) on any mismatch. Returns the resolved manifest path,
 * the scenarios map, and a `combinedContentHash` — sha256 over the manifest text
 * hash plus every referenced cache's verified content hash — which the runner
 * records as `seedCacheHash`.
 */
export async function loadAndVerifySeedCacheManifest(file: string): Promise<{
  path: string;
  scenarios: SeedCacheManifestFile["scenarios"];
  combinedContentHash: string;
}> {
  const rawManifestText = await readFile(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawManifestText);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`seed-cache manifest at ${file} is not valid JSON (${reason}); ${REGEN_HINT}.`);
  }
  const scenariosRaw = (parsed as { scenarios?: unknown }).scenarios;
  if (!scenariosRaw || typeof scenariosRaw !== "object") {
    throw new Error(`seed-cache manifest at ${file} has no "scenarios" object; ${REGEN_HINT}.`);
  }

  const entries = Object.entries(scenariosRaw as Record<string, unknown>);
  for (const [id, value] of entries) {
    const entry = value as { cacheFile?: unknown; cacheSha256?: unknown };
    if (typeof entry.cacheSha256 !== "string" || entry.cacheSha256.length === 0) {
      throw new Error(
        `seed-cache manifest entry "${id}" is missing cacheSha256 (a v1 manifest?); ${REGEN_HINT}.`
      );
    }
    if (typeof entry.cacheFile !== "string" || entry.cacheFile.length === 0) {
      throw new Error(`seed-cache manifest entry "${id}" is missing cacheFile; ${REGEN_HINT}.`);
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(entry.cacheFile);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `seed-cache for "${id}" could not be read at ${entry.cacheFile} (${reason}); ${REGEN_HINT}.`
      );
    }
    const actual = sha256(bytes);
    if (actual !== entry.cacheSha256) {
      throw new Error(
        `seed-cache for "${id}" changed since collection: manifest sha256 ${entry.cacheSha256} ` +
          `!= file sha256 ${actual}; ${REGEN_HINT}.`
      );
    }
  }

  const combinedContentHash = sha256(
    JSON.stringify({
      manifest: sha256(rawManifestText),
      caches: entries
        .map(([id, value]) => [id, (value as { cacheSha256: string }).cacheSha256] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    })
  );

  return {
    path: path.resolve(file),
    scenarios: scenariosRaw as SeedCacheManifestFile["scenarios"],
    combinedContentHash
  };
}
