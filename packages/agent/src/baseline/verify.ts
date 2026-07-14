import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LabClient,
  createRunLogger,
  labCredentials,
  type AccuracyReport,
  type ChaosFlag,
  type LabTruth,
  type PipelineResult
} from "@ssda/shared";
import { scoreOdds, scoreStats, type PipelineOptions } from "../core";
import { baselineEngine } from "./engine";

/**
 * Live acceptance harness for the Playwright baseline. Boots a real lab, drives
 * the engine headless across the reliability catalog, and asserts the outcome
 * of each scenario. Prints one PASS/FAIL line per check and exits non-zero if
 * anything fails. This harness MAY use the /__lab control API (it is the
 * grader, not the engine).
 */

const LAB_PORT = 4532;
const LAB_URL = `http://127.0.0.1:${LAB_PORT}`;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const PNPM = path.join(os.homedir(), "Library", "pnpm", "pnpm");

const lab = new LabClient(LAB_URL);
let failureCount = 0;

function check(id: string, ok: boolean, expected: string, got: string): void {
  if (ok) {
    console.log(`PASS ${id} — ${got}`);
  } else {
    failureCount += 1;
    console.log(`FAIL ${id} expected ${expected} got ${got}`);
  }
}

function startLab(): ChildProcess {
  return spawn(PNPM, ["exec", "tsx", "apps/lab/src/server.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, LAB_PORT: String(LAB_PORT) },
    stdio: "ignore"
  });
}

async function tmpDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

interface RunOpts {
  scenarioId: string;
  seed: number;
  session?: PipelineOptions["session"];
  saveSessionStateTo?: string;
}

async function runEngine(opts: RunOpts): Promise<PipelineResult> {
  const runDir = await tmpDir(`ssda-baseline-${opts.scenarioId}-`);
  const logger = createRunLogger({
    runId: opts.scenarioId,
    file: path.join(runDir, "events.jsonl"),
    console: false
  });
  const options: PipelineOptions = {
    labUrl: LAB_URL,
    pages: ["stats", "odds"],
    credentials: labCredentials(),
    session: opts.session ?? { mode: "fresh" },
    runId: opts.scenarioId,
    runDir,
    logger,
    scenarioId: opts.scenarioId,
    seed: opts.seed,
    headless: true,
    maxAttempts: 2,
    navTimeoutMs: 20_000,
    stepTimeoutMs: 45_000,
    env: "local",
    ...(opts.saveSessionStateTo ? { saveSessionStateTo: opts.saveSessionStateTo } : {})
  };
  return baselineEngine.run(options);
}

const hasStep = (result: PipelineResult, name: string): boolean =>
  result.steps.some((s) => s.name === name);

const stats = (result: PipelineResult, gt: LabTruth): AccuracyReport | null =>
  result.normalized ? scoreStats(result.normalized.teams, gt.truth, gt.overrides) : null;
const odds = (result: PipelineResult, gt: LabTruth): AccuracyReport | null =>
  result.normalized ? scoreOdds(result.normalized.markets, gt.truth, gt.overrides) : null;

async function configure(seed: number, chaos: ChaosFlag[]): Promise<LabTruth> {
  await lab.configure({ seed, chaos });
  return lab.groundTruth();
}

async function runAll(): Promise<void> {
  // ── clean-extraction (1101) ──────────────────────────────────────────────
  {
    const gt = await configure(1101, []);
    const r = await runEngine({ scenarioId: "clean-extraction", seed: 1101 });
    const s = stats(r, gt);
    const o = odds(r, gt);
    check(
      "clean-extraction",
      r.success === true && s?.score === 1 && o?.score === 1,
      "success & statsScore=1 & oddsScore=1",
      `success=${r.success} statsScore=${s?.score} oddsScore=${o?.score}`
    );
    const dir = r.artifacts.dir;
    const artifactsOk =
      (await fileExists(path.join(dir, "artifacts", "stats-a1.png"))) &&
      (await fileExists(path.join(dir, "raw", "stats-attempt-1.json"))) &&
      (await fileExists(path.join(dir, "normalized.json")));
    check(
      "clean-extraction-artifacts",
      artifactsOk,
      "stats-a1.png & stats-attempt-1.json & normalized.json present",
      `present=${artifactsOk}`
    );
  }

  // ── session-reuse (1102) — one config: fresh+save, then reuse ─────────────
  {
    await configure(1102, []);
    const dir = await tmpDir("ssda-session-reuse-");
    const stateFile = path.join(dir, "session.json");
    const fresh = await runEngine({ scenarioId: "session-reuse-seed", seed: 1102, saveSessionStateTo: stateFile });
    const reuse = await runEngine({
      scenarioId: "session-reuse",
      seed: 1102,
      session: { mode: "reuse", stateFile }
    });
    check(
      "session-reuse",
      fresh.success === true && reuse.success === true && !hasStep(reuse, "login"),
      "success & no login step",
      `freshSuccess=${fresh.success} success=${reuse.success} loginStep=${hasStep(reuse, "login")}`
    );
  }

  // ── expired-session (1103) — fresh+save, force-expire, then expired run ───
  {
    await configure(1103, []);
    const dir = await tmpDir("ssda-session-expired-");
    const stateFile = path.join(dir, "session.json");
    const fresh = await runEngine({ scenarioId: "expired-seed", seed: 1103, saveSessionStateTo: stateFile });
    await lab.expireAllSessions();
    const expired = await runEngine({
      scenarioId: "expired-session",
      seed: 1103,
      session: { mode: "expired", stateFile }
    });
    check(
      "expired-session",
      fresh.success === true && expired.success === true && hasStep(expired, "login"),
      "success & login step present",
      `freshSuccess=${fresh.success} success=${expired.success} loginStep=${hasStep(expired, "login")}`
    );
  }

  // ── cookie-banner (1104) ──────────────────────────────────────────────────
  {
    await configure(1104, ["cookieBanner"]);
    const r = await runEngine({ scenarioId: "cookie-banner", seed: 1104 });
    check(
      "cookie-banner",
      r.success === true && hasStep(r, "consent"),
      "success & consent step present",
      `success=${r.success} consentStep=${hasStep(r, "consent")}`
    );
  }

  // ── modal-overlay (1105) ──────────────────────────────────────────────────
  {
    await configure(1105, ["modal"]);
    const r = await runEngine({ scenarioId: "modal-overlay", seed: 1105 });
    check(
      "modal-overlay",
      r.success === true && hasStep(r, "dismiss-modal"),
      "success & dismiss-modal step present",
      `success=${r.success} dismissStep=${hasStep(r, "dismiss-modal")}`
    );
  }

  // ── delayed-render (1106) ─────────────────────────────────────────────────
  {
    await configure(1106, ["delayedRender"]);
    const r = await runEngine({ scenarioId: "delayed-render", seed: 1106 });
    check("delayed-render", r.success === true, "success", `success=${r.success}`);
  }

  // ── class-drift (1108) — ids removed → cannot find the hooks ──────────────
  {
    await configure(1108, ["classDrift"]);
    const r = await runEngine({ scenarioId: "class-drift", seed: 1108 });
    const catOk = r.failureCategory === "not_found" || r.failureCategory === "timeout";
    check(
      "class-drift",
      r.success === false && catOk,
      "failure & category in {not_found,timeout}",
      `success=${r.success} category=${r.failureCategory}`
    );
  }

  // ── column-shuffle (1109) — fixed indices misread → domain inconsistency ──
  {
    await configure(1109, ["columnShuffle"]);
    const r = await runEngine({ scenarioId: "column-shuffle", seed: 1109 });
    check(
      "column-shuffle",
      r.success === false && r.failureCategory === "validation",
      "failure & category validation",
      `success=${r.success} category=${r.failureCategory}`
    );
  }

  // ── layout-variant (1110) — no table at all for #standings ────────────────
  {
    await configure(1110, ["layoutVariant"]);
    const r = await runEngine({ scenarioId: "layout-variant", seed: 1110 });
    check(
      "layout-variant",
      r.success === false && r.failureCategory === "not_found",
      "failure & category not_found",
      `success=${r.success} category=${r.failureCategory}`
    );
  }

  // ── hidden-tab (1111) ─────────────────────────────────────────────────────
  {
    await configure(1111, ["hiddenTab"]);
    const r = await runEngine({ scenarioId: "hidden-tab", seed: 1111 });
    check(
      "hidden-tab",
      r.success === true && hasStep(r, "reveal-table"),
      "success & reveal-table step present",
      `success=${r.success} revealStep=${hasStep(r, "reveal-table")}`
    );
  }

  // ── pagination (1112) — 12 teams across 3 pages ───────────────────────────
  {
    const gt = await configure(1112, ["pagination"]);
    const r = await runEngine({ scenarioId: "pagination", seed: 1112 });
    const teams = r.normalized?.teams.length ?? 0;
    const s = stats(r, gt);
    check(
      "pagination",
      r.success === true && teams === 12 && s?.score === 1,
      "success & 12 teams & statsScore=1",
      `success=${r.success} teams=${teams} statsScore=${s?.score}`
    );
  }

  // ── partial-data (1113) — em-dash cells → warnings, not failure ───────────
  {
    const gt = await configure(1113, ["partialData"]);
    const r = await runEngine({ scenarioId: "partial-data", seed: 1113 });
    const warnings = r.normalized?.warnings.length ?? 0;
    const s = stats(r, gt);
    check(
      "partial-data",
      r.success === true && warnings > 0 && s?.score === 1,
      "success & warnings>0 & statsScore=1",
      `success=${r.success} warnings=${warnings} statsScore=${s?.score}`
    );
  }

  // ── copy-drift (1114) — text changes, ids stable → unaffected ─────────────
  {
    await configure(1114, ["copyDrift"]);
    const r = await runEngine({ scenarioId: "copy-drift", seed: 1114 });
    check("copy-drift", r.success === true, "success", `success=${r.success}`);
  }

  // ── odds-format-american (1115) — moneyline normalised to decimal ─────────
  {
    const gt = await configure(1115, ["oddsFormatAmerican"]);
    const r = await runEngine({ scenarioId: "odds-format-american", seed: 1115 });
    const o = odds(r, gt);
    check(
      "odds-format-american",
      r.success === true && (o?.score ?? 0) >= 0.95,
      "success & oddsScore>=0.95",
      `success=${r.success} oddsScore=${o?.score}`
    );
  }

  // ── schema-violation (1116) — corrupt values → clean validation failure ───
  {
    await configure(1116, ["corruptData"]);
    const r = await runEngine({ scenarioId: "schema-violation", seed: 1116 });
    check(
      "schema-violation",
      r.success === false && r.failureCategory === "validation",
      "failure & category validation",
      `success=${r.success} category=${r.failureCategory}`
    );
  }

  // ── stale-session (1117) — bounced between stats and odds → relogin ───────
  {
    await configure(1117, ["staleSession"]);
    const r = await runEngine({ scenarioId: "stale-session", seed: 1117 });
    check(
      "stale-session",
      r.success === true && hasStep(r, "relogin"),
      "success & relogin step present",
      `success=${r.success} reloginStep=${hasStep(r, "relogin")}`
    );
  }

  // ── site-v1 (1118) — survival baseline: the clean launch site ─────────────
  {
    const gt = await configure(1118, []);
    const r = await runEngine({ scenarioId: "site-v1", seed: 1118 });
    const s = stats(r, gt);
    const o = odds(r, gt);
    check(
      "site-v1",
      r.success === true && s?.score === 1 && o?.score === 1,
      "success & statsScore=1 & oddsScore=1",
      `success=${r.success} statsScore=${s?.score} oddsScore=${o?.score}`
    );
  }

  // ── site-v2 (1119) — content refresh: reworded copy + shuffled columns ────
  // Copy drift leaves the ids alone, so the baseline reaches the table; the
  // column shuffle silently misreads fixed indices → domain inconsistency.
  {
    await configure(1119, ["copyDrift", "columnShuffle"]);
    const r = await runEngine({ scenarioId: "site-v2", seed: 1119 });
    check(
      "site-v2",
      r.success === false && r.failureCategory === "validation",
      "failure & category validation",
      `success=${r.success} category=${r.failureCategory}`
    );
  }

  // ── site-v3 (1120) — redesign: hashed classes, ids gone, card grid ────────
  // Same death as class drift: the login hooks vanish before any data is read.
  {
    await configure(1120, ["copyDrift", "classDrift", "layoutVariant"]);
    const r = await runEngine({ scenarioId: "site-v3", seed: 1120 });
    const catOk = r.failureCategory === "not_found" || r.failureCategory === "timeout";
    check(
      "site-v3",
      r.success === false && catOk,
      "failure & category in {not_found,timeout}",
      `success=${r.success} category=${r.failureCategory}`
    );
  }

  // ── compound-blocked-and-slow (1121) — banner + modal over a slow render ──
  {
    const gt = await configure(1121, [
      "cookieBanner",
      "modal",
      "delayedRender",
      "networkDelay"
    ]);
    const r = await runEngine({ scenarioId: "compound-blocked-and-slow", seed: 1121 });
    const s = stats(r, gt);
    const o = odds(r, gt);
    check(
      "compound-blocked-and-slow",
      r.success === true && s?.score === 1 && o?.score === 1,
      "success & statsScore=1 & oddsScore=1",
      `success=${r.success} statsScore=${s?.score} oddsScore=${o?.score}`
    );
  }

  // ── compound-session-churn (1122) — stale bounce + pagination + US odds ───
  {
    const gt = await configure(1122, [
      "staleSession",
      "pagination",
      "oddsFormatAmerican"
    ]);
    const r = await runEngine({ scenarioId: "compound-session-churn", seed: 1122 });
    const teams = r.normalized?.teams.length ?? 0;
    const o = odds(r, gt);
    check(
      "compound-session-churn",
      r.success === true &&
        teams === 12 &&
        hasStep(r, "relogin") &&
        (o?.score ?? 0) >= 0.95,
      "success & 12 teams & relogin step & oddsScore>=0.95",
      `success=${r.success} teams=${teams} relogin=${hasStep(r, "relogin")} oddsScore=${o?.score}`
    );
  }

  // ── compound-messy-data-day (1123) — modal over slow page hiding gaps ─────
  {
    const gt = await configure(1123, ["partialData", "networkDelay", "modal"]);
    const r = await runEngine({ scenarioId: "compound-messy-data-day", seed: 1123 });
    const warnings = r.normalized?.warnings.length ?? 0;
    const s = stats(r, gt);
    check(
      "compound-messy-data-day",
      r.success === true &&
        warnings > 0 &&
        hasStep(r, "dismiss-modal") &&
        s?.score === 1,
      "success & warnings>0 & dismiss-modal step & statsScore=1",
      `success=${r.success} warnings=${warnings} dismiss=${hasStep(r, "dismiss-modal")} statsScore=${s?.score}`
    );
  }

  // ── compound-redesign-storm (1124) — hashed classes + copy + card grid ────
  // Class drift removes the login ids: the baseline dies at login, as in v3.
  {
    await configure(1124, ["classDrift", "copyDrift", "layoutVariant"]);
    const r = await runEngine({ scenarioId: "compound-redesign-storm", seed: 1124 });
    const catOk = r.failureCategory === "not_found" || r.failureCategory === "timeout";
    check(
      "compound-redesign-storm",
      r.success === false && catOk,
      "failure & category in {not_found,timeout}",
      `success=${r.success} category=${r.failureCategory}`
    );
  }
}

async function main(): Promise<void> {
  const child = startLab();
  try {
    await lab.waitUntilReady(20_000);
    await runAll();
  } finally {
    child.kill("SIGKILL");
  }
  console.log(failureCount === 0 ? "\nALL SCENARIOS PASS" : `\n${failureCount} SCENARIO(S) FAILED`);
  process.exit(failureCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
