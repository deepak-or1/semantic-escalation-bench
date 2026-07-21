/**
 * Private-lab lifecycle helpers, extracted from scripts/run-benchmark.ts (Wave E
 * 8a + 8k) so both the benchmark CLI and the Phase-2A campaign driver
 * (scripts/run-campaign-2a.ts) share ONE implementation. Behaviour is identical
 * to the originals — this file only moved them.
 *
 * Every benchmark/campaign run owns a PRIVATE lab child on a free ephemeral port,
 * exclusive to that run, killed on exit — so concurrent runs never contaminate
 * each other's trial isolation.
 */
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// scripts/ lives directly under the repo root; "../.." from this file resolves to
// the repo root exactly as it did from scripts/run-benchmark.ts.
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");

/** Ask the OS for a free ephemeral port on the loopback interface. */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not determine a free ephemeral port")));
      }
    });
  });
}

/**
 * Spawn a PRIVATE lab child bound to `port` (Wave E 8a + 8k). Portable spawn:
 * runs the repo's OWN tsx through the current Node instead of a machine-specific
 * global pnpm path. `node_modules/.bin/tsx` is pnpm's shim whose target is
 * `tsx/dist/cli.mjs`; invoking that target via `process.execPath` means the
 * child depends on nothing on PATH. (Windows caveat: the .bin entry there is
 * `tsx.CMD`, but running `cli.mjs` through `process.execPath` works the same.)
 */
export function spawnPrivateLab(port: number): ChildProcess {
  const tsxCli = path.resolve(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
  return spawn(process.execPath, [tsxCli, "apps/lab/src/server.ts"], {
    cwd: REPO_ROOT,
    stdio: "ignore",
    env: { ...process.env, LAB_PORT: String(port) }
  });
}

/** Kill a child and confirm it actually exited (Wave E 8a: verify death). */
export async function killAndVerify(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 3000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 2000))]);
  }
}
