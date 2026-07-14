import { appendFile, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SENSITIVE_ENV_KEYS } from "./constants";
import { RunManifestSchema, type RunManifest } from "./schemas/run";

/**
 * Lightweight file-based run storage: JSON documents + JSONL event streams
 * under runs/. No database — everything is inspectable with cat/jq.
 */

export function runsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.SSDA_RUNS_DIR ?? path.resolve(process.cwd(), "runs");
}

export function newRunId(kind: RunManifest["kind"], now = new Date()): string {
  return `${kind}-${now.toISOString().replace(/[:.]/g, "-")}`;
}

export async function createRunDir(
  manifest: Omit<RunManifest, "runId" | "createdAt"> & { runId?: string }
): Promise<{ runId: string; dir: string; manifest: RunManifest }> {
  const runId = manifest.runId ?? newRunId(manifest.kind);
  const dir = path.join(runsRoot(), runId);
  await mkdir(dir, { recursive: true });
  const full: RunManifest = RunManifestSchema.parse({
    ...manifest,
    runId,
    createdAt: new Date().toISOString()
  });
  await writeJson(path.join(dir, "manifest.json"), full);
  return { runId, dir, manifest: full };
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

export async function readJsonOr<T>(file: string, fallback: T): Promise<T> {
  try {
    return await readJson<T>(file);
  } catch {
    return fallback;
  }
}

export async function appendJsonl(file: string, record: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(record) + "\n", "utf8");
}

export async function readJsonl<T>(file: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

/** Replace runs/latest with a copy of the given run directory. */
export async function mirrorToLatest(sourceDir: string): Promise<string> {
  const latest = path.join(runsRoot(), "latest");
  await rm(latest, { recursive: true, force: true });
  await cp(sourceDir, latest, { recursive: true });
  return latest;
}

/** All run manifests under runs/, newest first. */
export async function listRunManifests(): Promise<RunManifest[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(runsRoot());
  } catch {
    return [];
  }
  const manifests: RunManifest[] = [];
  for (const entry of entries) {
    if (entry === "latest" || entry.startsWith(".")) continue;
    const parsed = RunManifestSchema.safeParse(
      await readJsonOr(path.join(runsRoot(), entry, "manifest.json"), null)
    );
    if (parsed.success) manifests.push(parsed.data);
  }
  return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Mask values of sensitive env vars anywhere they appear in a string.
 * Applied to every log line so keys can't leak into runs/ artifacts.
 */
export function redactSecrets(
  text: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  let out = text;
  for (const key of SENSITIVE_ENV_KEYS) {
    const value = env[key];
    if (value && value.length >= 4) {
      out = out.split(value).join(`<redacted:${key}>`);
    }
  }
  return out;
}
