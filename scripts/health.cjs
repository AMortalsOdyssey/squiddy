"use strict";
const fs = require("node:fs"),
  path = require("node:path");
const { official, privateSave } = require("./operator.cjs");
function summarize(
  { maintenance = [], files = [], jobs = [], audits = [] },
  now = Date.now(),
) {
  const state =
    maintenance.find((x) => x._id === "cursors" || x.id === "cursors") ||
    maintenance[0];
  const stale =
    !state?.last_completed_at || now - state.last_completed_at > 15 * 60000;
  const failed = files.filter((f) => (f.failures || 0) > 0).length;
  const pendingJobs = jobs.filter((j) => j.status !== "completed");
  const stalled = pendingJobs.filter(
    (j) => now - j.created_at > 24 * 3600000,
  ).length;
  const recent = audits.filter(
    (a) =>
      now - a.created_at < 30 * 60000 &&
      ["runtime_error", "maintenance_item_failure"].includes(a.type),
  ).length;
  return {
    status: stale || failed || stalled || recent ? "needs_attention" : "ok",
    scheduler_stale: stale,
    last_completed_at: state?.last_completed_at || null,
    queued_files_observed: files.length,
    failed_files_observed: failed,
    unfinished_jobs_observed: pendingJobs.length,
    stalled_jobs_observed: stalled,
    recent_errors_observed: recent,
    counts_may_be_truncated: [files, jobs, audits].some((a) => a.length >= 100),
    scope: "Bounded operator readback, not a traffic SLO or cost alert",
  };
}
function main() {
  const root = path.resolve(
    process.argv[2] || "artifacts/health-" + Date.now(),
  );
  fs.mkdirSync(root, { mode: 0o700 });
  const data = {};
  for (const [name, table] of Object.entries({
    maintenance: "maintenance_state",
    files: "file_deletions",
    jobs: "cleanup_jobs",
    audits: "audit_events",
  }))
    data[name] = official(
      "cloud_db_read_doc",
      { "collection-name": table, query: {}, limit: 100 },
      path.join(root, table + ".json"),
    ).data;
  const result = summarize(data);
  if (result.counts_may_be_truncated && result.status === "ok")
    result.status = "unknown";
  privateSave(path.join(root, "summary.json"), result);
  console.log(JSON.stringify(result));
  if (result.status !== "ok") process.exitCode = 2;
}
if (require.main === module) main();
module.exports = { summarize };
