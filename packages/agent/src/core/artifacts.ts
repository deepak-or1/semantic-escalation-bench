import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeJson, type NormalizedDataset } from "@ssda/shared";

export async function persistRaw(
  runDir: string,
  attempt: number,
  page: "stats" | "odds",
  raw: unknown
): Promise<string> {
  const file = path.join(runDir, "raw", `${page}-attempt-${attempt}.json`);
  await writeJson(file, raw ?? null);
  return file;
}

export async function persistNormalized(
  runDir: string,
  dataset: NormalizedDataset
): Promise<string> {
  const file = path.join(runDir, "normalized.json");
  await writeJson(file, dataset);
  return file;
}

/** Save a PNG buffer under runDir/artifacts and return its relative path. */
export async function saveScreenshot(
  runDir: string,
  name: string,
  buffer: Buffer | Uint8Array
): Promise<string> {
  const dir = path.join(runDir, "artifacts");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  await writeFile(file, buffer);
  return path.join("artifacts", `${name}.png`);
}
