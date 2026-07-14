/**
 * @ssda/dashboard — a self-contained, read-only HTML dashboard over runs/.
 * Public surface: load the data, render the page. The server and report script
 * are entry points, not part of this module's exports.
 */
export { loadDashboardData } from "./data";
export type {
  DashboardData,
  DashboardBench,
  DashboardAgent,
  FailureTrial,
  ScreenshotRef
} from "./data";
export { renderDashboardHtml } from "./render";
