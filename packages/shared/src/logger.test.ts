import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunLogger } from "./logger";
import { RunEventSchema } from "./schemas/run";

async function readLines(file: string): Promise<unknown[]> {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

describe("createRunLogger", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ssda-logger-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes valid RunEvent JSONL lines", async () => {
    const file = path.join(dir, "events.jsonl");
    const logger = createRunLogger({ runId: "run-1", file });
    logger.info("started", { step: 1 });
    logger.warn("careful");
    logger.error("boom");
    await logger.flush();

    const lines = await readLines(file);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(RunEventSchema.safeParse(line).success).toBe(true);
    }
  });

  it("merges engine/step fields via child()", async () => {
    const file = path.join(dir, "child.jsonl");
    const logger = createRunLogger({ runId: "run-2", file });
    const child = logger.child({ engine: "stagehand", step: "login" });
    child.info("navigating");
    await logger.flush();

    const [event] = await readLines(file);
    const parsed = RunEventSchema.parse(event);
    expect(parsed.engine).toBe("stagehand");
    expect(parsed.step).toBe("login");
  });

  it("redacts a sensitive env value from logged data", async () => {
    const file = path.join(dir, "secret.jsonl");
    const prev = process.env.LAB_PASSWORD;
    try {
      process.env.LAB_PASSWORD = "hunter2-xyz";
      const logger = createRunLogger({ runId: "run-3", file });
      logger.info("auth", { password: "hunter2-xyz" });
      await logger.flush();

      const raw = await readFile(file, "utf8");
      expect(raw).toContain("<redacted:LAB_PASSWORD>");
      expect(raw).not.toContain("hunter2-xyz");
    } finally {
      if (prev === undefined) delete process.env.LAB_PASSWORD;
      else process.env.LAB_PASSWORD = prev;
    }
  });
});
