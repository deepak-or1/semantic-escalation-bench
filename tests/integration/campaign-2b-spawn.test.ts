import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { tmpDir } from "./helpers";

/**
 * FIX 2b — prove the REAL CLI reaches its pre-flight guards.
 *
 * Every other guard test calls the exported functions directly, so deleting the
 * call from `main()` broke nothing (that was the finding). This spawns the
 * driver exactly as an operator would and asserts it refuses.
 *
 * WHY THROWAWAY GIT REPOS: the driver's guards, state files, run directories and
 * evidence paths are rooted at THIS repository. Two audits showed what happens
 * when that is assumed rather than enforced. First, launched from an unrelated
 * git repository, `git tag --points-at HEAD` answered about THAT repository, so
 * a throwaway checkout carrying a tag named `phase2b-ablation-freeze-v1`
 * attested a freeze it had nothing to do with. Second — and surviving the cwd
 * fix — git resolves `GIT_DIR`/`GIT_WORK_TREE` in preference to the working
 * directory, so the same fake repo could be injected by environment while the
 * process stood in the real root. Both bypasses are reproduced below and both
 * must buy nothing.
 *
 * The suite is passed by ABSOLUTE path so the cwd change cannot affect it, and
 * the Phase-2A baseline resolves from the script's own location rather than cwd
 * (fix 9), so nothing else depends on where this runs.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRIVER = path.join(REPO_ROOT, "scripts", "run-campaign-2b.ts");
const TSX = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

/**
 * A tag no real checkout of this project can ever carry, planted alongside the
 * fake freeze tag. Asserting on THIS name — rather than on the freeze tag, whose
 * name the real repository will legitimately carry after gate 5 — is what makes
 * "the fake repo was not consulted" provable rather than merely likely.
 */
const FAKE_MARKER_TAG = "ssda-spawn-fixture-marker-do-not-create";

/** A throwaway git repo: one commit, and only the tags the caller asks for. */
async function freshRepo(tags: string[] = []): Promise<string> {
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
  for (const tag of tags) git("tag", tag);
  return dir;
}

/** The freeze-tag fixture: a fake repo that looks frozen and clean, plus a marker. */
const fakeFrozenRepo = () => freshRepo(["phase2b-ablation-freeze-v1", FAKE_MARKER_TAG]);

/** Ground truth about the REAL repository, read the way an auditor would. */
function realGit(...args: string[]): string {
  const out = spawnSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.stderr}`);
  return out.stdout;
}

/** Spawn a tsx child, never carrying a credential, with an optional env overlay. */
function spawnTsx(entry: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("node", [TSX, entry, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      // Never let this child see a credential, whatever the parent has.
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      STAGEHAND_MODEL: "",
      ...env
    }
  });
}

const spawnCli = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) =>
  spawnTsx(DRIVER, args, cwd, env);

const SUITE_ARGS = ["--suite", path.join(REPO_ROOT, "data", "phase2a", "scenario-suite.json")];
const KEYLESS_ARGS = [...SUITE_ARGS, "--phase", "keyless"];
/**
 * The keyed shape is used for the ENV-injection probe specifically. It makes the
 * two possible outcomes fast and inert, and tells them apart unambiguously: the
 * guards refuse at the freeze tag (fix working), or — if the fake repo were
 * consulted, since it is both tagged and clean — the very next check, key
 * discipline, refuses for want of a key. Neither branch runs a trial or spends
 * anything, which is what makes this probe safe to leave in the suite.
 */
const KEYED_ARGS = [...SUITE_ARGS, "--phase", "keyed"];

describe("campaign:2b CLI pre-flight guards (spawned)", () => {
  it("refuses to execute entries from anywhere but the repository root", async () => {
    const cwd = await freshRepo();
    const startedAt = Date.now();
    const out = spawnCli(cwd, KEYLESS_ARGS);
    const durationMs = Date.now() - startedAt;

    const combined = `${out.stdout ?? ""}${out.stderr ?? ""}`;
    expect(out.status, `expected a refusal exit; output:\n${combined}`).not.toBe(0);
    expect(combined).toMatch(/campaign must run from the repository root/);
    expect(combined).toMatch(/current working directory is/);
    // It must fail at the GUARD, not earlier on something cwd-relative.
    expect(combined).not.toMatch(/Could not load --suite/);
    expect(combined).not.toMatch(/replication baseline missing/);
    // CI-comparable: a guard refusal is a startup-cost operation, not a run.
    expect(durationMs).toBeLessThan(60_000);
    console.log(`[spawn e2e] cwd-guard refusal in ${durationMs}ms, exit ${out.status}`);
  });

  it("THE AUDITOR'S BYPASS: a foreign repo carrying the freeze tag still buys NOTHING", async () => {
    // The reproduction, verbatim: a throwaway repo with one commit and a tag
    // named exactly like gate 5's. Before the fix, `git tag --points-at HEAD`
    // ran in this directory, found the name it was looking for, and let the
    // campaign proceed — the freeze attested by a checkout containing none of
    // the code it claims to freeze. The working-directory gate now fires first,
    // so the tag is never even consulted.
    const cwd = await fakeFrozenRepo();
    const out = spawnCli(cwd, KEYLESS_ARGS);

    const combined = `${out.stdout ?? ""}${out.stderr ?? ""}`;
    expect(out.status, `expected a refusal exit; output:\n${combined}`).not.toBe(0);
    expect(combined).toMatch(/campaign must run from the repository root/);
    // …and it did NOT get far enough to start a campaign on the strength of the
    // fake tag: no schedule banner, no state file line, no entry.
    expect(combined).not.toMatch(/Phase-2B keyless campaign/);
  });

  it("FIX A: GIT_DIR/GIT_WORK_TREE cannot smuggle a foreign repo past the freeze guard", async () => {
    // The cwd pin alone does NOT close this: git prefers GIT_DIR/GIT_WORK_TREE
    // over the working directory, so from the REAL repository root these two
    // variables made `git tag --points-at HEAD` return the fake repo's freeze
    // tag and `git status --porcelain` report the fake repo's clean tree while
    // ours is dirty — both guards satisfied by a checkout containing none of
    // this code. The helpers now run with every GIT_* variable stripped.
    const fake = await fakeFrozenRepo();
    const out = spawnCli(REPO_ROOT, KEYED_ARGS, {
      GIT_DIR: path.join(fake, ".git"),
      GIT_WORK_TREE: fake
    });

    const combined = `${out.stdout ?? ""}${out.stderr ?? ""}`;
    expect(out.status, `expected a refusal exit; output:\n${combined}`).not.toBe(0);
    // Seeing the REAL repo means the freeze guard refuses: this checkout's HEAD
    // carries no freeze tag while Phase 2B is unfrozen.
    expect(combined).toMatch(/freeze tag "phase2b-ablation-freeze-v1" does not point at HEAD/);
    // The unmistakable negative: had the fake repo been consulted, the guards
    // would have passed (tagged AND clean) and the NEXT check — key discipline —
    // would have been the one to refuse.
    expect(combined).not.toMatch(/keyed refuses to run without a model provider key/);
    expect(combined).not.toContain(FAKE_MARKER_TAG);
  });

  it("FIX B: the three git helpers read THIS repository, whatever the cwd and environment say", async () => {
    // The `cwd: REPO_ROOT` pins were unwired — mutation-removing each one left
    // the suite green, because the helpers are only reachable from a CLI path
    // that already refuses at the cwd gate. This calls them directly, from
    // inside the fake repo AND with the env injection pointed at it, and
    // compares every answer against ground truth read from the real repository.
    const fake = await fakeFrozenRepo();
    const probeDir = await tmpDir("ssda-2b-probe-");
    const probe = path.join(probeDir, "probe-git-helpers.ts");
    // The probe lives OUTSIDE the repository, so it cannot perturb `git status`;
    // the driver's own dependencies still resolve from the driver's location.
    writeFileSync(
      probe,
      `import { readTagsAtHead, readWorktreeStatus, readGitCommit } from ${JSON.stringify(
        pathToFileURL(DRIVER).href
      )};\n` +
        `console.log(JSON.stringify({\n` +
        `  tags: readTagsAtHead(),\n` +
        `  status: readWorktreeStatus(),\n` +
        `  commit: readGitCommit()\n` +
        `}));\n`,
      "utf8"
    );

    const out = spawnTsx(probe, [], fake, {
      GIT_DIR: path.join(fake, ".git"),
      GIT_WORK_TREE: fake
    });
    expect(out.status, `probe failed:\n${out.stdout}\n${out.stderr}`).toBe(0);
    const seen = JSON.parse(out.stdout) as {
      tags: string[];
      status: string;
      commit: string | null;
    };

    // GROUND TRUTH, read from the real repository by an independent route.
    const expectedTags = realGit("tag", "--points-at", "HEAD")
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean);
    expect(seen.tags).toEqual(expectedTags);
    // The fake repo's marker can never be a real tag of this project, so its
    // absence is proof the fake repo was not the one consulted.
    expect(seen.tags).not.toContain(FAKE_MARKER_TAG);
    expect(seen.commit).toBe(realGit("rev-parse", "HEAD").trim());
    // Full-string equality: the fake tree is clean and ours is not, so a single
    // character of divergence here means the wrong repository answered.
    expect(seen.status).toBe(realGit("status", "--porcelain"));
  });

  it("FIX E: a SUBDIRECTORY of the repository is refused — the gate is equality, not a prefix", async () => {
    // `<repo>/scripts`.startsWith(`<repo>`) is true, so a prefix test would wave
    // this through and every repo-relative default path would then resolve one
    // level down from where the driver expects it.
    const out = spawnCli(path.join(REPO_ROOT, "scripts"), KEYLESS_ARGS);
    const combined = `${out.stdout ?? ""}${out.stderr ?? ""}`;
    expect(out.status, `expected a refusal exit; output:\n${combined}`).not.toBe(0);
    expect(combined).toMatch(/campaign must run from the repository root/);
  });

  it("FIX E: a SYMLINK to the repository root PASSES the gate and proceeds to the freeze guard", async () => {
    // The gate must refuse a different tree, not a different spelling of this
    // one: an operator whose checkout is reached through a symlinked parent
    // would otherwise be locked out of their own repository.
    const linkDir = await tmpDir("ssda-2b-link-");
    const link = path.join(linkDir, "repo");
    symlinkSync(REPO_ROOT, link);

    const out = spawnCli(link, KEYLESS_ARGS);
    const combined = `${out.stdout ?? ""}${out.stderr ?? ""}`;
    // It got PAST the cwd gate and refused at the next guard instead.
    expect(combined).not.toMatch(/campaign must run from the repository root/);
    expect(combined).toMatch(/freeze tag "phase2b-ablation-freeze-v1" does not point at HEAD/);
  });

  it("--print-schedule stays exempt: it prints and exits 0 from the same foreign repo", async () => {
    const cwd = await freshRepo();
    const out = spawnCli(cwd, ["--print-schedule"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/Phase-2B keyless schedule — 30 run entries/);
    const combined = `${out.stdout ?? ""}${out.stderr ?? ""}`;
    expect(combined).not.toMatch(/does not point at HEAD/);
    expect(combined).not.toMatch(/campaign must run from the repository root/);
  });
});
