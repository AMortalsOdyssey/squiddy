"use strict";
const { ensure, input, id } = require("./errors");
const { referencedByKitchen } = require("./media");
const { clearActor } = require("./meal-tools");
const { sha256 } = require("../shared/hash");
const { getMany } = require("./collections");
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
  "users",
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
        (s.epoch || 0) === (m.share_epoch || 0) &&
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
  {
    removeFile = async () => {},
    batchSize = 20,
    hash = sha256,
    coalesceEmpty = false,
    canContinue = () => true,
    schedulerRun,
  } = {},
) {
  input(Number.isInteger(batchSize) && batchSize > 0 && batchSize <= 50);
  return store.transaction(async (tx) => {
    const job = await tx.get("cleanup_jobs", jobId);
    ensure(job, "NOT_FOUND", "删除任务不存在");
    if (job.status === "completed") return job;
    ensure(
      ["account", "member", "kitchen"].includes(job.kind),
      "INVALID_STATE",
      "清理任务类型无效",
    );
    id(job.kind === "kitchen" ? job.kitchen_id : job.actor);
    if (schedulerRun && job.last_scheduler_run?.id !== schedulerRun.id) {
      job.scheduler_runs = (job.scheduler_runs || 0) + 1;
      job.last_scheduler_run = schedulerRun;
      job.started_at ||= Date.now();
    }
    let table = tables[job.table];
    if (!table) {
      if ((await getMany(tx, "file_deletions", job.file_ids || [])).size) {
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
      } else if (job.kind === "kitchen")
        await tx.remove("kitchens", job.kitchen_id);
      job.status = "completed";
      job.completed_at = Date.now();
      await tx.put("cleanup_jobs", jobId, job);
      return job;
    }
    const scope = (table) =>
      job.kind === "kitchen"
        ? table === "users"
          ? [{ field: "kitchen_ids", values: [job.kitchen_id] }]
          : [
              { field: "kitchen_id", values: [job.kitchen_id] },
              { field: "meal_id", values: job.meal_ids || [] },
              { field: "_id", values: job.dish_ids || [] },
              { field: "_id", values: job.meal_ids || [] },
            ]
        : ["actor", "user_id", "creator", "participant_ids", "accepted"].map(
            (field) => ({ field, values: [job.actor] }),
          );
    let rows, pageSize;
    do {
      // Image reference checks and account/member updates need a smaller batch.
      pageSize =
        table === "media"
          ? Math.min(batchSize, 2)
          : job.kind === "kitchen" && table !== "users"
            ? batchSize
            : Math.min(batchSize, 5);
      rows = await tx.scan(table, pageSize, job.cursor, scope(table));
      if (rows.length || !coalesceEmpty) break;
      job.table++;
      job.cursor = "";
      table = tables[job.table];
    } while (table && canContinue());
    const removing = [];
    for (const { id: rowId, data: r } of rows) {
      if (table === "users" && job.kind === "kitchen") {
        if (r.kitchen_ids?.includes(job.kitchen_id)) {
          r.kitchen_ids = r.kitchen_ids.filter((id) => id !== job.kitchen_id);
          await tx.put("users", rowId, r);
        }
        job.cursor = rowId;
        continue;
      }
      if (
        table === "meals" &&
        ["account", "member"].includes(job.kind) &&
        (job.kind === "account" || r.kitchen_id === job.kitchen_id) &&
        r.participant_ids?.includes(job.actor)
      ) {
        const part =
          job.kind === "member"
            ? await tx.get(
                "meal_memberships",
                hash("participant:" + rowId + ":" + job.actor),
              )
            : null;
        if (
          job.kind === "account" ||
          (part?.membership_epoch || 0) < (job.membership_epoch || 1)
        ) {
          clearActor(r, job.actor);
          r.participant_ids = r.participant_ids.filter((a) => a !== job.actor);
          r.revision++;
          await tx.put("meals", rowId, r);
        }
      }
      let memberScope = false;
      if (job.kind === "member") {
        if (r.kitchen_id) memberScope = r.kitchen_id === job.kitchen_id;
        else if (r.meal_id)
          memberScope =
            (await tx.get("meals", r.meal_id))?.kitchen_id === job.kitchen_id;
        let generation = r.membership_epoch || 0;
        if (r.meal_id)
          generation =
            (
              await tx.get(
                "meal_memberships",
                hash("participant:" + r.meal_id + ":" + job.actor),
              )
            )?.membership_epoch || 0;
        else if (r.media_id)
          generation =
            (await tx.get("media", r.media_id))?.membership_epoch || 0;
        if (generation >= (job.membership_epoch || 1)) memberScope = false;
      }
      const belongs =
        job.kind === "account" || job.kind === "member"
          ? (job.kind !== "member" || memberScope) &&
            (r.actor === job.actor ||
              r.user_id === job.actor ||
              r.creator === job.actor)
          : r.kitchen_id === job.kitchen_id ||
            job.meal_ids.includes(r.meal_id) ||
            job.dish_ids.includes(rowId) ||
            job.meal_ids.includes(rowId);
      if (belongs) {
        if (
          job.kind === "member" &&
          ["memberships", "meal_memberships"].includes(table)
        ) {
          if (table === "meal_memberships") {
            r.status = "revoked";
            await tx.put(table, rowId, r);
          }
          job.cursor = rowId;
          continue;
        }
        if (
          ["account", "member"].includes(job.kind) &&
          table === "media" &&
          (await referencedByKitchen(
            tx,
            rowId,
            await tx.get("kitchens", r.kitchen_id),
            r,
          ))
        ) {
          // Recipes belong to the shared kitchen. Erase the uploader identity,
          // retain referenced bytes, and never leave a recipe pointing at a deleted file.
          delete r.actor;
          delete r.upload_request;
          r.owner_scope = "kitchen";
          await tx.put("media", rowId, r);
          const queued = await tx.get("file_deletions", rowId);
          if (queued?.file_id === r.file_id)
            await tx.remove("file_deletions", rowId);
          const trace =
            r.trace_id && (await tx.get("media_traces", r.trace_id));
          if (trace) {
            delete trace.actor;
            await tx.put("media_traces", r.trace_id, trace);
          }
          job.cursor = rowId;
          continue;
        }
        if (table === "media" && r.file_id) {
          job.file_ids ||= [];
          if (!job.file_ids.includes(rowId)) job.file_ids.push(rowId);
          const reservation = await tx.get("file_deletions", rowId);
          await tx.put("file_deletions", rowId, {
            ...(reservation?.status === "upload_reserved" ? reservation : {}),
            id: rowId,
            file_id: r.file_id,
            status:
              reservation?.status === "upload_reserved"
                ? "upload_reserved"
                : "pending",
            job_id: jobId,
          });
        }
        removing.push(rowId);
      } else if (
        ["account", "member"].includes(job.kind) &&
        (job.kind !== "member" || memberScope) &&
        table === "invitations" &&
        r.accepted?.includes(job.actor)
      ) {
        r.accepted = r.accepted.filter((a) => a !== job.actor);
        await tx.put(table, rowId, r);
      }
      job.cursor = rowId;
    }
    if (removing.length) {
      if (tx.removeMany) await tx.removeMany(table, removing);
      else for (const id of removing) await tx.remove(table, id);
    }
    if (rows.length && rows.length < pageSize) {
      job.table++;
      job.cursor = "";
    } else if (!rows.length && !coalesceEmpty) {
      job.table++;
      job.cursor = "";
    }
    job.status = "running";
    job.batches = (job.batches || 0) + 1;
    job.scanned_rows = (job.scanned_rows || 0) + rows.length;
    job.removed_rows = (job.removed_rows || 0) + removing.length;
    job.last_progress_at = Date.now();
    await tx.put("cleanup_jobs", jobId, job);
    return {
      status: job.status,
      table: job.table,
      total_tables: tables.length,
      next_table: tables[job.table] || "finalize",
      scanned: rows.length,
      removed: removing.length,
    };
  });
}
async function processNotification(
  store,
  jobId,
  { send, template, now = () => Date.now(), hash },
) {
  const prepared = await store.transaction(async (tx) => {
    const job = await tx.get("notification_jobs", jobId);
    if (!job || job.status !== "pending") return null;
    const preference = await tx.get("notification_preferences", jobId);
    const user = await tx.get("users", job.actor),
      meal = await tx.get("meals", job.meal_id);
    const membership =
      hash && meal
        ? await tx.get(
            "memberships",
            hash("member:" + meal.kitchen_id + ":" + job.actor),
          )
        : null;
    const participant =
      hash && meal
        ? await tx.get(
            "meal_memberships",
            hash("participant:" + meal.id + ":" + job.actor),
          )
        : null;
    if (!template) {
      job.status = "not_configured";
      await tx.put("notification_jobs", jobId, job);
      return null;
    }
    if (
      user?.status !== "active" ||
      preference?.accepted !== true ||
      !meal ||
      (hash && membership?.status !== "active") ||
      (hash &&
        (participant?.status !== "active" ||
          (participant.membership_epoch || 0) !== (membership?.epoch || 0))) ||
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
