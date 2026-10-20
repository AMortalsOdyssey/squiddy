"use strict";
const { ensure, input, id } = require("./errors");
const tables = [
  "feedback",
  "transition_audits",
  "memberships",
  "meal_memberships",
  "selections",
  "notification_preferences",
  "notification_jobs",
  "invitations",
  "invite_refs",
  "public_shares",
  "media",
  "media_traces",
  "media_callbacks",
  "dish_prices",
  "dishes",
  "meal_prices",
  "meals",
  "receipts",
  "audit_events",
];
async function publicRead(store, shareId, now = Date.now()) {
  id(shareId);
  return store.transaction(async (tx) => {
    const s = await tx.get("public_shares", shareId);
    ensure(s && !s.revoked && s.expires_at > now, "NOT_FOUND", "分享已失效");
    const k = await tx.get("kitchens", s.kitchen_id),
      m = await tx.get("meals", s.meal_id);
    ensure(
      k?.status === "active" &&
        m &&
        !["cancelled", "archived"].includes(m.status),
      "NOT_FOUND",
      "分享已失效",
    );
    // Public snapshots intentionally exclude invitation credentials, time, participants and prices.
    return {
      title: s.title,
      dishes: s.dishes.map((d) => ({
        name: d.name,
        category_name: d.category_name,
      })),
    };
  });
}
async function applyMediaResult(store, event, expectedAppId) {
  ensure(
    event.appid === expectedAppId &&
      event.Event === "wxa_media_check" &&
      event.MsgType === "event",
    "FORBIDDEN",
    "无效审核事件",
  );
  input(typeof event.trace_id === "string" && event.trace_id.length <= 128);
  return store.transaction(async (tx) => {
    const link = await tx.get("media_traces", event.trace_id);
    if (!link) return { ignored: true };
    const image = await tx.get("media", link.media_id);
    if (
      !image ||
      image.status !== "pending" ||
      image.trace_id !== event.trace_id
    )
      return { ignored: true };
    image.status =
      event.errcode === 0 && event.result?.suggest === "pass"
        ? "approved"
        : event.errcode === 0
          ? "rejected"
          : "failed";
    await tx.put("media", image.id, image);
    return { status: image.status };
  });
}
async function cleanupBatch(
  store,
  jobId,
  { removeFile = async () => {}, batchSize = 20 } = {},
) {
  input(Number.isInteger(batchSize) && batchSize > 0 && batchSize <= 50);
  return store.transaction(async (tx) => {
    const job = await tx.get("cleanup_jobs", jobId);
    ensure(job, "NOT_FOUND", "删除任务不存在");
    if (job.status === "completed") return job;
    const table = tables[job.table];
    if (!table) {
      for (const fid of job.file_ids || [])
        if (await tx.get("file_deletions", fid)) {
          job.status = "running";
          await tx.put("cleanup_jobs", jobId, job);
          return { status: "running", phase: "files" };
        }

      if (job.kind === "account") {
        await tx.put("users", job.actor, { id: job.actor, status: "deleted" });
        await tx.put("deletion_jobs", job.actor, {
          status: "completed",
          completed_at: Date.now(),
        });
      } else await tx.remove("kitchens", job.kitchen_id);
      job.status = "completed";
      await tx.put("cleanup_jobs", jobId, job);
      return job;
    }
    const rows = await tx.scan(table, batchSize, job.cursor);
    for (const { id: rowId, data: r } of rows) {
      const belongs =
        job.kind === "account"
          ? r.actor === job.actor ||
            r.user_id === job.actor ||
            r.creator === job.actor
          : r.kitchen_id === job.kitchen_id ||
            job.meal_ids.includes(r.meal_id) ||
            job.dish_ids.includes(rowId) ||
            job.meal_ids.includes(rowId);
      if (belongs) {
        if (table === "media" && r.file_id) {
          job.file_ids ||= [];
          if (!job.file_ids.includes(rowId)) job.file_ids.push(rowId);
          await tx.put("file_deletions", rowId, {
            id: rowId,
            file_id: r.file_id,
            status: "pending",
            job_id: jobId,
          });
        }
        await tx.remove(table, rowId);
      } else if (
        job.kind === "account" &&
        table === "invitations" &&
        r.accepted?.includes(job.actor)
      ) {
        r.accepted = r.accepted.filter((a) => a !== job.actor);
        await tx.put(table, rowId, r);
      }
      job.cursor = rowId;
    }
    if (rows.length < batchSize) {
      job.table++;
      job.cursor = "";
    }
    job.status = "running";
    await tx.put("cleanup_jobs", jobId, job);
    return {
      status: job.status,
      table: job.table,
      total_tables: tables.length,
    };
  });
}
async function processNotification(
  store,
  jobId,
  { send, template, now = () => Date.now() },
) {
  const prepared = await store.transaction(async (tx) => {
    const job = await tx.get("notification_jobs", jobId);
    if (!job || job.status !== "pending") return null;
    const preference = await tx.get("notification_preferences", jobId);
    const user = await tx.get("users", job.actor),
      meal = await tx.get("meals", job.meal_id);
    if (!template) {
      job.status = "not_configured";
      await tx.put("notification_jobs", jobId, job);
      return null;
    }
    if (
      user?.status !== "active" ||
      preference?.accepted !== true ||
      !meal ||
      meal.status !== "completed" ||
      !meal.participant_ids.includes(job.actor)
    ) {
      job.status = "skipped";
      await tx.put("notification_jobs", jobId, job);
      return null;
    }
    job.status = "sending";
    job.attempted_at = now();
    await tx.put("notification_jobs", jobId, job);
    return { job, openid: user.openid };
  });
  if (!prepared) return { skipped: true };
  let status = "sent",
    code = "";
  try {
    await send({
      openid: prepared.openid,
      meal_id: prepared.job.meal_id,
      title: prepared.job.title,
      template,
    });
  } catch (e) {
    code = String(e.errCode || e.code || "UNKNOWN");
    status = ["43101", "43107", "40037", "47003"].includes(code)
      ? "failed"
      : "unknown";
  }
  // Unknown results are never automatically retried: a successful send may have timed out.
  await store.transaction(async (tx) => {
    const j = await tx.get("notification_jobs", jobId);
    if (j) {
      j.status = status;
      j.code = code;
      await tx.put("notification_jobs", jobId, j);
    }
  });
  return { status, code };
}
module.exports = {
  publicRead,
  applyMediaResult,
  cleanupBatch,
  processNotification,
};
