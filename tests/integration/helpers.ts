import { access, mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { createLabApp } from "@ssda/lab";
import { LabClient } from "@ssda/shared";

/**
 * Shared plumbing for the integration suite: an in-process lab bound to an
 * ephemeral port, temp run directories, and a small fs existence probe. These
 * are helpers, not tests — vitest only picks up *.test.ts under this folder.
 */

export interface Lab {
  server: Server;
  url: string;
  client: LabClient;
}

/** Boot the lab in-process on 127.0.0.1:0 and wait until it answers /health. */
export async function startLab(): Promise<Lab> {
  const app = createLabApp();
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("lab server did not bind a TCP port");
  }
  const url = `http://127.0.0.1:${address.port}`;
  const client = new LabClient(url);
  await client.waitUntilReady(15_000);
  return { server, url, client };
}

/** Close the lab server; safe to call with an undefined lab (failed boot). */
export async function stopLab(lab: Lab | undefined): Promise<void> {
  if (!lab) return;
  await new Promise<void>((resolve, reject) => {
    lab.server.close((err) => (err ? reject(err) : resolve()));
  });
}

/** A fresh, isolated temp directory under the OS temp root. */
export function tmpDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
