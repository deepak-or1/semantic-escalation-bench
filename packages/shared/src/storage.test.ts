import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendJsonl,
  createRunDir,
  listRunManifests,
  mirrorToLatest,
  readJsonl,
  redactSecrets
} from "./storage";

describe("redactSecrets", () => {
  it("masks a sensitive env value found in the text (explicit env)", () => {
    const secret = "s3cret-value-123";
    const text = `connecting with password=${secret} to lab`;
    const out = redactSecrets(text, { LAB_PASSWORD: secret });
    expect(out).not.toContain(secret);
    expect(out).toContain("<redacted:LAB_PASSWORD>");
  });

  it("leaves text untouched when no secret is present", () => {
    const text = "nothing sensitive here";
    expect(redactSecrets(text, { LAB_PASSWORD: "s3cret-value-123" })).toBe(text);
  });
});

describe("file-based run storage", () => {
  let runsDir: string;
  let prevRunsDir: string | undefined;

  beforeEach(async () => {
    prevRunsDir = process.env.SSDA_RUNS_DIR;
    runsDir = await mkdtemp(path.join(tmpdir(), "ssda-storage-"));
    process.env.SSDA_RUNS_DIR = runsDir;
  });

  afterEach(async () => {
    if (prevRunsDir === undefined) delete process.env.SSDA_RUNS_DIR;
    else process.env.SSDA_RUNS_DIR = prevRunsDir;
    await rm(runsDir, { recursive: true, force: true });
  });

  it("round-trips records through appendJsonl + readJsonl", async () => {
    const file = path.join(runsDir, "events.jsonl");
    const records = [{ a: 1 }, { b: "two" }, { c: [3, 4] }];
    for (const record of records) await appendJsonl(file, record);
    expect(await readJsonl(file)).toEqual(records);
  });

  it("returns [] from readJsonl for a missing file", async () => {
    expect(await readJsonl(path.join(runsDir, "does-not-exist.jsonl"))).toEqual([]);
  });

  it("creates a run dir, lists its manifest, and mirrors it to latest", async () => {
    const { runId, dir, manifest } = await createRunDir({ kind: "bench", seed: 1101 });
    expect(manifest.runId).toBe(runId);
    expect(manifest.kind).toBe("bench");
    expect(existsSync(path.join(dir, "manifest.json"))).toBe(true);

    const manifests = await listRunManifests();
    expect(manifests.map((m) => m.runId)).toContain(runId);

    const latest = await mirrorToLatest(dir);
    expect(latest).toBe(path.join(runsDir, "latest"));
    const mirrored = JSON.parse(await readFile(path.join(latest, "manifest.json"), "utf8"));
    expect(mirrored.runId).toBe(runId);
  });
});
