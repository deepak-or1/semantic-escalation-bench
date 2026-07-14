import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { dashboardPortFromEnv, runsRoot } from "@ssda/shared";
import { loadDashboardData } from "./data";
import { renderDashboardHtml } from "./render";

/**
 * The dashboard server. "/" re-reads disk and renders fresh on every request
 * (so a new bench/agent run shows up without a restart); "/runs/…" serves the
 * artifact files (screenshots, JSON, event logs) referenced by the page, with
 * a path-traversal guard so nothing outside runsRoot() is ever reachable.
 */

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

function contentType(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Resolve a "/runs/…" request to an absolute path, or null if it escapes
 * runsRoot() (path traversal) or is malformed.
 */
function resolveRunsPath(urlPath: string): string | null {
  const root = runsRoot();
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath.slice("/runs/".length));
  } catch {
    return null;
  }
  const abs = path.resolve(root, rel);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(prefix)) return null;
  return abs;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (pathname === "/" || pathname === "/index.html") {
      const data = await loadDashboardData();
      const html = renderDashboardHtml(data, { embedAssets: false });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (pathname.startsWith("/runs/")) {
      const abs = resolveRunsPath(pathname);
      if (!abs) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }
      let info;
      try {
        info = await stat(abs);
      } catch {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      if (!info.isFile()) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      res.writeHead(200, {
        "content-type": contentType(abs),
        "content-length": info.size
      });
      createReadStream(abs).pipe(res);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Internal error");
    console.error(error instanceof Error ? error.message : error);
  }
});

const port = dashboardPortFromEnv();
server.listen(port, "127.0.0.1", () => {
  console.log(`dashboard on http://127.0.0.1:${port}`);
});
