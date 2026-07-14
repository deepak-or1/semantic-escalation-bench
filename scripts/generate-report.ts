/**
 * Render the dashboard to a single self-contained HTML file with every
 * screenshot inlined as a data URI, so the report opens anywhere with no
 * server and no external requests.
 *
 *   pnpm report            # writes runs/latest/report.html
 *
 * Refuses (exit 1) if there is no benchmark to report on yet.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { runsRoot } from "@ssda/shared";
import { loadDashboardData, renderDashboardHtml } from "@ssda/dashboard";

async function main(): Promise<void> {
  const latestDir = path.join(runsRoot(), "latest");
  const resultsFile = path.join(latestDir, "results.json");

  if (!existsSync(resultsFile)) {
    console.error(
      `No benchmark results at ${resultsFile}.\n` +
        "Run `pnpm bench` first to produce runs/latest/results.json, then re-run `pnpm report`."
    );
    process.exit(1);
  }

  // Report always reflects real runs/ data — never the dev fixture override.
  const env = { ...process.env };
  delete env.SSDA_DASHBOARD_FIXTURE;

  const data = await loadDashboardData(env);
  const html = renderDashboardHtml(data, { embedAssets: true });

  const outFile = path.join(latestDir, "report.html");
  await writeFile(outFile, html, "utf8");
  console.log(path.resolve(outFile));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
