"use strict";
// Trusted cloud operator only. No support/admin action is exposed to the app.
const fs = require("node:fs");
const {
  configuration,
  privateSave,
  official,
  hash,
} = require("./operator.cjs");
function replyPlan(row, reply, status, environment) {
  if (
    !row ||
    !/^\w{1,128}$/.test(row._id || row.id) ||
    typeof reply !== "string" ||
    !reply.trim() ||
    reply.length > 500 ||
    !["in_progress", "resolved"].includes(status)
  )
    throw Error("Invalid ticket, reply or status");
  const revision = Number.isInteger(row.revision) ? row.revision : 0;
  const query = {
    _id: row._id || row.id,
    ...(revision ? { revision } : { revision: { $exists: false } }),
  };
  return {
    kind: "squiddy-support-reply-v1",
    environment,
    ticket_id: query._id,
    previous_revision: revision,
    query,
    update: {
      $set: {
        reply: reply.trim(),
        status,
        revision: revision + 1,
        updated_at: Date.now(),
      },
    },
  };
}
function main() {
  const [mode, input, arg, output] = process.argv.slice(2),
    c = configuration(),
    environment = hash(c.appid + ":" + c.cloudEnv);
  if (mode === "list" || mode === "read") {
    if (mode === "read" && !/^[a-zA-Z0-9_-]{1,128}$/.test(input))
      throw Error("Invalid ticket");
    const receipt = mode === "list" ? input : arg;
    const r = official(
      "cloud_db_read_doc",
      {
        "collection-name": "feedback",
        query: mode === "read" ? { _id: input } : {},
        limit: mode === "read" ? 1 : 100,
      },
      receipt,
    );
    console.log(
      JSON.stringify({
        tickets: r.data.map((t) => ({
          id: t._id,
          status: t.status,
          revision: t.revision || 0,
        })),
        private_receipt: receipt,
      }),
    );
    return;
  }
  if (mode === "prepare") {
    const ticket = JSON.parse(fs.readFileSync(input, "utf8")),
      reply = fs.readFileSync(arg, "utf8").trim();
    if (Array.isArray(ticket.result?.data) && ticket.result.data.length !== 1)
      throw Error("Read exactly one target ticket before preparing a reply");
    const row = Array.isArray(ticket.result?.data)
      ? ticket.result.data[0]
      : ticket;
    const plan = replyPlan(row, reply, "resolved", environment);
    privateSave(output, { ...plan, sha256: hash(JSON.stringify(plan)) });
    console.log("Private reply plan created; no cloud write.");
    return;
  }
  if (mode !== "apply")
    throw Error(
      "Usage: support.cjs list NEW-receipt | read ID NEW-receipt | prepare ONE-ticket.json reply.txt NEW-plan | apply plan NEW-state",
    );
  const { sha256, ...plan } = JSON.parse(fs.readFileSync(input, "utf8"));
  if (
    sha256 !== hash(JSON.stringify(plan)) ||
    plan.environment !== environment ||
    plan.kind !== "squiddy-support-reply-v1"
  )
    throw Error("Plan integrity or environment mismatch");
  const receipt = () => arg + "." + Date.now() + ".receipt.json";
  if (fs.existsSync(arg)) {
    const state = JSON.parse(fs.readFileSync(arg, "utf8"));
    if (state.plan_sha256 !== sha256)
      throw Error("State belongs to another reply");
    if (state.status === "pending") {
      const r = official(
        "polling_task_result",
        { "task-id": state.task_id },
        receipt(),
      );
      if (r.status !== "success") {
        console.log(JSON.stringify({ status: r.status }));
        return;
      }
    }
    const current = official(
      "cloud_db_read_doc",
      {
        "collection-name": "feedback",
        query: { _id: plan.ticket_id },
        limit: 1,
      },
      receipt(),
    ).data[0];
    if (
      current?.revision !== plan.previous_revision + 1 ||
      current.reply !== plan.update.$set.reply ||
      current.status !== plan.update.$set.status
    )
      throw Error(
        "Reply readback mismatch; do not replay or overwrite a newer reply",
      );
    privateSave(arg, { status: "verified", plan_sha256: sha256 }, false);
    console.log("Reply and processing status verified.");
    return;
  }
  privateSave(arg, { status: "submitting", plan_sha256: sha256 });
  const result = official(
    "cloud_db_write_doc",
    {
      action: "update",
      "collection-name": "feedback",
      query: plan.query,
      update: plan.update,
    },
    receipt(),
  );
  privateSave(
    arg,
    {
      status: result.status || "submitted",
      task_id: result.taskId,
      plan_sha256: sha256,
    },
    false,
  );
  console.log(
    "Reply submitted once. Preserve state; confirm any native prompt, then rerun to poll and read back. Never repeat the write manually.",
  );
}
if (require.main === module) main();
module.exports = { replyPlan };
