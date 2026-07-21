import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Self-test for scripts/diff-gate-2a.sh (PROTOCOL_2A §6). The working tree is not
 * a git repo, so this builds a throwaway temp repo from scratch and exercises the
 * three gate cases plus the rerun-is-byte-identical property (§6 step 4). It
 * invokes the REAL script by absolute path; the script cd's to the repo top-level
 * it is run inside.
 */

const SCRIPT = path.resolve(fileURLToPath(import.meta.url), "../../../scripts/diff-gate-2a.sh");

const PROTOCOL_BASE = [
  "# Phase 2A protocol (fixture)",
  "",
  "Frozen prose line A.",
  "Frozen prose line B.",
  "",
  "<!-- PHASE2A-APPENDIX-START -->",
  "<!-- PHASE2A-APPENDIX-END -->",
  ""
].join("\n");

const PROTOCOL_APPENDIX_EDIT = [
  "# Phase 2A protocol (fixture)",
  "",
  "Frozen prose line A.",
  "Frozen prose line B.",
  "",
  "<!-- PHASE2A-APPENDIX-START -->",
  "Revealed scenario table row (appendix content — allowed).",
  "<!-- PHASE2A-APPENDIX-END -->",
  ""
].join("\n");

const PROTOCOL_PROSE_TAMPER = [
  "# Phase 2A protocol (fixture)",
  "",
  "TAMPERED prose line A.", // a byte outside the markers changed
  "Frozen prose line B.",
  "",
  "<!-- PHASE2A-APPENDIX-START -->",
  "<!-- PHASE2A-APPENDIX-END -->",
  ""
].join("\n");

let repo: string;
let BASE: string;

function git(...args: string[]): string {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function write(rel: string, content: string): void {
  const abs = path.join(repo, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function runGate(base: string, head: string): { status: number; stdout: string } {
  const r = spawnSync("bash", [SCRIPT, base, head], { cwd: repo, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout };
}

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), "ssda-diffgate-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Diff Gate Test");
  git("config", "commit.gpgsign", "false");

  // BASE state: the frozen protocol + an empty gate report file.
  write("docs/PROTOCOL_2A.md", PROTOCOL_BASE);
  write("evidence/phase2a/diff-gate.txt", "");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  BASE = git("rev-parse", "HEAD");
});

describe("diff-gate-2a.sh", () => {
  it("PASSES a clean, appendix-only edit plus an allowlisted suite file", () => {
    git("checkout", "-q", "-b", "case-clean", BASE);
    write("docs/PROTOCOL_2A.md", PROTOCOL_APPENDIX_EDIT);
    write("data/phase2a/scenario-suite.json", '{"protocolId":"phase2a-v1","scenarios":[]}\n');
    git("add", "-A");
    git("commit", "-q", "-m", "suite candidate");

    const { status, stdout } = runGate(BASE, "case-clean");
    expect(status).toBe(0);
    expect(stdout).toContain("allowlist: PASS");
    expect(stdout).toContain("appendix-markers: PASS");
    expect(stdout).toContain("verdict: PASS");
  });

  it("rerun is byte-identical after the gate report is committed (§6 step 4)", () => {
    // On case-clean: first run, commit its output as the report, rerun.
    const first = runGate(BASE, "case-clean");
    write("evidence/phase2a/diff-gate.txt", first.stdout);
    git("add", "-A");
    git("commit", "-q", "-m", "gate report");
    const second = runGate(BASE, "case-clean");
    expect(second.stdout).toBe(first.stdout); // report path excluded from the calc
    expect(second.status).toBe(0);
  });

  it("FAILS when a changed path is outside the allowlist", () => {
    git("checkout", "-q", "-b", "case-out", BASE);
    write("packages/agent/src/hybrid/engine.ts", "// tampered engine\n");
    git("add", "-A");
    git("commit", "-q", "-m", "out of allowlist");

    const { status, stdout } = runGate(BASE, "case-out");
    expect(status).toBe(1);
    expect(stdout).toContain("allowlist: FAIL");
    expect(stdout).toContain("out-of-allowlist: packages/agent/src/hybrid/engine.ts");
    expect(stdout).toContain("verdict: FAIL");
  });

  it("FAILS when PROTOCOL_2A.md changes OUTSIDE the appendix markers", () => {
    git("checkout", "-q", "-b", "case-prose", BASE);
    write("docs/PROTOCOL_2A.md", PROTOCOL_PROSE_TAMPER);
    git("add", "-A");
    git("commit", "-q", "-m", "prose tamper");

    const { status, stdout } = runGate(BASE, "case-prose");
    expect(status).toBe(1);
    expect(stdout).toContain("allowlist: PASS"); // the file itself is allowlisted
    expect(stdout).toContain("appendix-markers: FAIL");
    expect(stdout).toContain("verdict: FAIL");
  });
});
