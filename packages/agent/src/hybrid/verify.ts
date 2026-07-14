import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LabClient,
  createRunLogger,
  labCredentials,
  type ChaosFlag,
  type LabTruth,
  type PipelineResult
} from "@ssda/shared";
import { scoreOdds, scoreStats, type PipelineOptions } from "../core";
import { hybridEngine } from "./engine";

/**
 * Live acceptance harness for the hybrid engine, run KEYLESS. It empirically
 * proves the contract's core claim — that the deterministic tier constructs,
 * navigates, reads and acts with a real Stagehand v3 stack and ZERO LLM calls —
 * and that its keyless failure boundary is exactly "the page changed shape".
 *
 * Boots a real lab on an ephemeral port (the engine only ever sees a URL; this
 * grader may use the /__lab control API). Prints one PASS/FAIL line per check
 * and exits non-zero on any failure.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const PNPM = path.join(os.homedir(), "Library", "pnpm", "pnpm");

// Force keyless regardless of the host machine: the deterministic tier must
// stand on its own, and repairs must be genuinely unavailable.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.STAGEHAND_MODEL;

let failureCount = 0;

function check(id: string, ok: boolean, expected: string, got: string): void {
  if (ok) {
    console.log(`PASS ${id} — ${got}`);
  } else {
    failureCount += 1;
    console.log(`FAIL ${id} expected ${expected} got ${got}`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") return reject(new Error("no port bound"));
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

function startLab(port: number): ChildProcess {
  return spawn(PNPM, ["exec", "tsx", "apps/lab/src/server.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, LAB_PORT: String(port) },
    stdio: "ignore"
  });
}

async function tmpDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function main(): Promise<void> {
  const port = await freePort();
  const labUrl = `http://127.0.0.1:${port}`;
  const lab = new LabClient(labUrl);
  const child = startLab(port);

  async function runHybrid(scenarioId: string): Promise<PipelineResult> {
    const runDir = await tmpDir(`ssda-hybrid-${scenarioId}-`);
    const logger = createRunLogger({
      runId: scenarioId,
      file: path.join(runDir, "events.jsonl"),
      engine: "hybrid",
      console: false
    });
    const options: PipelineOptions = {
      labUrl,
      pages: ["stats", "odds"],
      credentials: labCredentials(),
      session: { mode: "fresh" },
      runId: scenarioId,
      runDir,
      logger,
      scenarioId,
      headless: true,
      maxAttempts: 2,
      navTimeoutMs: 20_000,
      stepTimeoutMs: 45_000,
      env: "local"
    };
    return hybridEngine.run(options);
  }

  async function configure(seed: number, chaos: ChaosFlag[]): Promise<LabTruth> {
    await lab.configure({ seed, chaos });
    return lab.groundTruth();
  }

  try {
    await lab.waitUntilReady(20_000);

    // 1. clean-extraction: the deterministic tier alone succeeds, ZERO LLM.
    {
      const gt = await configure(1101, []);
      const r = await runHybrid("clean-extraction");
      const s = r.normalized ? scoreStats(r.normalized.teams, gt.truth, gt.overrides) : null;
      const o = r.normalized ? scoreOdds(r.normalized.markets, gt.truth, gt.overrides) : null;
      const calls = r.tokens?.llmCalls;
      check(
        "clean-extraction",
        r.success === true && calls === 0 && s?.score === 1 && o?.score === 1,
        "success & llmCalls=0 & statsScore=1 & oddsScore=1",
        `success=${r.success} llmCalls=${calls} statsScore=${s?.score} oddsScore=${o?.score}`
      );
    }

    // 2. column-shuffle: header-name mapping reads the right columns keyless,
    //    where the positional baseline silently misreads. Still ZERO LLM.
    {
      const gt = await configure(1109, ["columnShuffle"]);
      const r = await runHybrid("column-shuffle");
      const s = r.normalized ? scoreStats(r.normalized.teams, gt.truth, gt.overrides) : null;
      const calls = r.tokens?.llmCalls;
      check(
        "column-shuffle",
        r.success === true && calls === 0 && s?.score === 1,
        "success (header map) & llmCalls=0 & statsScore=1",
        `success=${r.success} llmCalls=${calls} statsScore=${s?.score}`
      );
    }

    // 3. class-drift: the login ids vanish; keyless there is no repair. The
    //    engine fails HONESTLY with the contract's exact "repair unavailable"
    //    detail — not a crash, not fabricated data.
    {
      await configure(1108, ["classDrift"]);
      const r = await runHybrid("class-drift");
      const detail = r.failureDetail ?? "";
      check(
        "class-drift",
        r.success === false &&
          r.failureCategory === "not_found" &&
          detail.includes("semantic repair unavailable (no model key)"),
        'failure & not_found & detail includes "semantic repair unavailable (no model key)"',
        `success=${r.success} category=${r.failureCategory} detail="${detail.slice(0, 120)}"`
      );
    }
  } finally {
    child.kill("SIGKILL");
  }

  console.log(failureCount === 0 ? "\nALL HYBRID CHECKS PASS" : `\n${failureCount} HYBRID CHECK(S) FAILED`);
  process.exit(failureCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
