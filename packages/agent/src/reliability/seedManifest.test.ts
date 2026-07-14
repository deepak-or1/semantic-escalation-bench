import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BenchmarkResults, TrialResult } from "@ssda/shared";
import { writeJson } from "@ssda/shared";
import { describe, expect, it } from "vitest";
import { buildHealsManifest, loadAndVerifySeedCacheManifest } from "./seedManifest";

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function tmp(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Write a healed-cache.json under <benchDir>/trials/<runId>/artifacts/. */
async function writeCache(benchDir: string, runId: string, content: string): Promise<string> {
  const dir = path.join(benchDir, "trials", runId, "artifacts");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "healed-cache.json");
  await writeFile(file, content, "utf8");
  return file;
}

function healedTrial(scenarioId: string, runId: string): TrialResult {
  return {
    scenarioId,
    engine: "hybrid",
    trial: 1,
    runId,
    healedSteps: ["login"]
  } as unknown as TrialResult;
}

function results(trials: TrialResult[]): BenchmarkResults {
  return {
    benchId: "bench-1",
    createdAt: "2026-07-14T00:00:00.000Z",
    trials,
    environment: {
      gitCommit: "abc123",
      gitDirty: false,
      stagehandModel: "anthropic/claude-haiku-4-5",
      promptsHash: "P"
    }
  } as unknown as BenchmarkResults;
}

describe("buildHealsManifest", () => {
  it("picks the FIRST healed trial per scenario in results order and records its sha256", async () => {
    const benchDir = await tmp("ssda-seedman-build-");
    const firstContent = '{"cache":"first"}';
    const secondContent = '{"cache":"second"}';
    const firstFile = await writeCache(benchDir, "class-drift-hybrid-t1", firstContent);
    await writeCache(benchDir, "class-drift-hybrid-t2", secondContent);

    const { manifest, warnings, found } = await buildHealsManifest(
      results([
        healedTrial("class-drift", "class-drift-hybrid-t1"),
        healedTrial("class-drift", "class-drift-hybrid-t2")
      ]),
      benchDir
    );

    expect(found).toBe(1);
    expect(warnings).toEqual([]);
    expect(manifest.selectionRule).toBe("first-healed-trial-in-results-order");
    const entry = manifest.scenarios["class-drift"]!;
    expect(entry.trialRunId).toBe("class-drift-hybrid-t1");
    expect(entry.cacheFile).toBe(firstFile);
    expect(entry.cacheSha256).toBe(sha256(firstContent));
    expect(entry.cacheSha256).not.toBe(sha256(secondContent));
    expect(manifest.source.benchId).toBe("bench-1");
    expect(manifest.source.promptsHash).toBe("P");
  });

  it("warns and skips a scenario whose healed-cache.json is missing", async () => {
    const benchDir = await tmp("ssda-seedman-missing-");
    const { warnings, found } = await buildHealsManifest(
      results([healedTrial("class-drift", "class-drift-hybrid-t1")]),
      benchDir
    );
    expect(found).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/no healed-cache\.json/);
  });
});

describe("loadAndVerifySeedCacheManifest", () => {
  async function goodManifestFile(): Promise<{ manifestFile: string; cacheFile: string }> {
    const benchDir = await tmp("ssda-seedman-load-");
    const cacheFile = await writeCache(benchDir, "class-drift-hybrid-t1", '{"cache":"ok"}');
    const { manifest } = await buildHealsManifest(
      results([healedTrial("class-drift", "class-drift-hybrid-t1")]),
      benchDir
    );
    const manifestFile = path.join(benchDir, "heals-manifest.json");
    await writeJson(manifestFile, manifest);
    return { manifestFile, cacheFile };
  }

  it("passes on a good manifest and returns a stable combined content hash", async () => {
    const { manifestFile } = await goodManifestFile();
    const loaded = await loadAndVerifySeedCacheManifest(manifestFile);
    expect(Object.keys(loaded.scenarios)).toEqual(["class-drift"]);
    expect(loaded.combinedContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.path).toBe(path.resolve(manifestFile));
    // Deterministic: verifying the same untouched manifest twice is identical.
    const again = await loadAndVerifySeedCacheManifest(manifestFile);
    expect(again.combinedContentHash).toBe(loaded.combinedContentHash);
  });

  it("throws when a referenced cache file was tampered (one byte flipped)", async () => {
    const { manifestFile, cacheFile } = await goodManifestFile();
    // Flip the cache content after collection — the recorded sha256 no longer matches.
    await writeFile(cacheFile, '{"cache":"TAMPERED"}', "utf8");
    await expect(loadAndVerifySeedCacheManifest(manifestFile)).rejects.toThrow(
      /changed since collection/
    );
  });

  it("throws when a manifest entry is missing cacheSha256 (e.g. a v1 manifest)", async () => {
    const benchDir = await tmp("ssda-seedman-v1-");
    const cacheFile = await writeCache(benchDir, "class-drift-hybrid-t1", '{"cache":"ok"}');
    const v1 = { scenarios: { "class-drift": { cacheFile, provenance: { benchId: "x" } } } };
    const manifestFile = path.join(benchDir, "v1-manifest.json");
    await writeFile(manifestFile, JSON.stringify(v1), "utf8");
    await expect(loadAndVerifySeedCacheManifest(manifestFile)).rejects.toThrow(
      /cacheSha256.*regenerate with pnpm heals:collect/s
    );
  });
});
