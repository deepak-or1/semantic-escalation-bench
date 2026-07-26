import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tmpDir } from "./helpers";

/**
 * FIX 2b — prove the REAL CLI reaches its pre-flight guards.
 *
 * Every other guard test calls the exported functions directly, so deleting the
 * call from `main()` broke nothing (that was the finding). This spawns the
 * driver exactly as an operator would and asserts it refuses.
 *
 * WHY A FRESH TEMP GIT REPO AS cwd: the freeze tag must be ABSENT for the
 * refusal to be the one under test, and it must stay absent forever — including
 * after gate 5 tags the real repository. A throwaway repo with one commit and no
 * tags is deterministic in a way that "the current checkout" can never be.
 * The suite is passed by ABSOLUTE path so the cwd change cannot affect it, and
 * the Phase-2A baseline now resolves from the script's own location rather than
 * cwd (fix 9), so nothing else depends on where this runs.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A throwaway git repo: one commit, no tags, nothing uncommitted. */
async function freshRepoWithoutTags(): Promise<string> {
  const dir = await tmpDir("ssda-2b-spawn-");
  const git = (...args: string[]) => {
    const out = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (out.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.stderr}`);
  };
  git("init", "--quiet");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "spawn test");
  mkdirSync(path.join(dir, "placeholder"), { recursive: true });
  writeFileSync(path.join(dir, "placeholder", "README.md"), "spawn-test fixture\n", "utf8");
  git("add", ".");
  git("commit", "--quiet", "-m", "fixture");
  return dir;
}

describe("campaign:2b CLI pre-flight guards (spawned)", () => {
  it("refuses to execute entries when the freeze tag does not point at HEAD", async () => {
    const cwd = await freshRepoWithoutTags();
    const startedAt = Date.now();
    const out = spawnSync(
      "node",
      [
        path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(REPO_ROOT, "scripts", "run-campaign-2b.ts"),
        "--suite",
        path.join(REPO_ROOT, "data", "phase2a", "scenario-suite.json"),
        "--phase",
        "keyless"
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          // Never let this child see a credential, whatever the parent has.
          ANTHROPIC_API_KEY: "",
          OPENAI_API_KEY: "",
          STAGEHAND_MODEL: ""
        }
      }
    );
    const durationMs = Date.now() - startedAt;

    const combined = `${out.stdout ?? ""}${out.stderr ?? ""}`;
    expect(out.status, `expected a refusal exit; output:\n${combined}`).not.toBe(0);
    expect(combined).toMatch(/phase2b-ablation-freeze-v1/);
    expect(combined).toMatch(/does not point at HEAD/);
    expect(combined).toMatch(/gate 5/);
    // It must fail at the GUARD, not earlier on something cwd-relative.
    expect(combined).not.toMatch(/Could not load --suite/);
    expect(combined).not.toMatch(/replication baseline missing/);
    // CI-comparable: a guard refusal is a startup-cost operation, not a run.
    expect(durationMs).toBeLessThan(60_000);
    console.log(`[spawn e2e] freeze-guard refusal in ${durationMs}ms, exit ${out.status}`);
  });

  it("--print-schedule stays exempt: it prints and exits 0 from the same tagless repo", async () => {
    const cwd = await freshRepoWithoutTags();
    const out = spawnSync(
      "node",
      [
        path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(REPO_ROOT, "scripts", "run-campaign-2b.ts"),
        "--print-schedule"
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", STAGEHAND_MODEL: "" }
      }
    );
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/Phase-2B keyless schedule — 30 run entries/);
    expect(`${out.stdout}${out.stderr}`).not.toMatch(/does not point at HEAD/);
  });
});
