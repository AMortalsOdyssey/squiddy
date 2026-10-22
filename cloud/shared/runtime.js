"use strict";
const crypto = require("node:crypto");
const { cloudStore } = require("./store");
const { AppError, ensure, input, keys } = require("../domain/errors");
const { createService } = require("../domain/service");
const { referencedByKitchen } = require("../domain/media");
const {
  publicRead,
  applyMediaResult,
  cleanupBatch,
  processNotification,
} = require("../domain/maintenance");
const safeCode = (e) => (e instanceof AppError ? e.code : "UNAVAILABLE");
function trustedSource(context, expected) {
  ensure(
    expected &&
      context.SOURCE === expected &&
      // A real media event has SDK SOURCE=wx_callback and carries its sender's
      // OPENID. Client chains still have wx_client in SOURCE and cannot opt in.
      (!context.OPENID || expected === "wx_callback") &&
      !context.FROM_APPID &&
      !/(wx_client|http)/i.test(context.SOURCE),
    "FORBIDDEN",
    "此入口仅供可信平台事件调用",
  );
}
function makeRuntime({
  cloud,
  env = process.env,
  store = cloudStore(cloud.database()),
  imageProcessor,
  uploadMetadata,
  maintenanceClock = Date.now,
}) {
  const appid = env.SQUIDDY_APP_ID || "";
  const crypt = {
    hash: (s) => crypto.createHash("sha256").update(s).digest("hex"),
    random: (n) => crypto.randomBytes(n).toString("hex"),
    token: (s) => {
      ensure(
        (env.SQUIDDY_INVITE_KEY || "").length >= 32,
        "NOT_CONFIGURED",
        "邀请服务尚未配置",
      );
      return crypto
        .createHmac("sha256", env.SQUIDDY_INVITE_KEY)
        .update(s)
        .digest("hex")
        .slice(0, 48);
    },
  };
  const notificationConfig =
    env.SQUIDDY_TEMPLATE_ID &&
    env.SQUIDDY_TEMPLATE_TITLE_KEY &&
    env.SQUIDDY_TEMPLATE_STATUS_KEY
      ? { template_id: env.SQUIDDY_TEMPLATE_ID }
      : null;
  const service = createService({
    store,
    crypto: crypt,
    expectedAppId: appid,
    notificationConfig,
    moderate: async (content, openid) => {
      let r;
      try {
        r = await cloud.openapi.security.msgSecCheck({
          openid,
          scene: 4,
          version: 2,
          content,
        });
        if (r.errCode !== 0)
          throw {
            errCode: r.errCode,
            errMsg: "openapi.security.msgSecCheck: failed",
          };
      } catch (error) {
        if (Number(error?.errCode) === 45009)
          throw Object.assign(
            new AppError(
              "CONTENT_RATE_LIMITED",
              "内容审核已达平台调用限制，请稍后再试",
            ),
            {
              errCode: 45009,
              providerOperation: "openapi.security.msgSecCheck",
            },
          );
        throw error;
      }
      ensure(
        r.errCode === 0 && r.result?.suggest === "pass",
        "CONTENT_REJECTED",
        "内容未通过审核，请修改后再试",
      );
    },
    media: {
      async accept(payload, image, context) {
        ensure(
          env.SQUIDDY_MEDIA_ENABLED === "true" && env.SQUIDDY_CALLBACK_SOURCE,
          "NOT_CONFIGURED",
          "图片审核回调尚未接通",
        );
        input(
          typeof payload.base64 === "string" &&
            payload.base64.length <= 2800000 &&
            /^[A-Za-z0-9+/]+={0,2}$/.test(payload.base64),
          "图片格式或大小不正确",
        );
        const bytes = Buffer.from(payload.base64, "base64");
        input(
          bytes.length > 0 && bytes.length <= 2 * 1024 * 1024,
          "图片请控制在2MB以内",
        );
        // Decode/re-encode drops EXIF/GPS, rejects SVG and decompression bombs.
        const sharp = imageProcessor || require("sharp");
        const parser = sharp(bytes, {
          limitInputPixels: 16000000,
          animated: false,
        });
        const metadata = await parser.metadata();
        input(
          ["jpeg", "png", "webp"].includes(metadata.format) &&
            metadata.width > 0 &&
            metadata.height > 0,
          "仅支持JPEG、PNG和WebP图片",
        );
        let { data, info } = await parser
          .rotate()
          .resize({
            width: 1600,
            height: 1600,
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({ quality: 85 })
          .toBuffer({ resolveWithObject: true });
        if (data.length > 512 * 1024)
          ({ data, info } = await sharp(data)
            .resize({
              width: 960,
              height: 960,
              fit: "inside",
              withoutEnlargement: true,
            })
            .jpeg({ quality: 65 })
            .toBuffer({ resolveWithObject: true }));
        input(data.length <= 512 * 1024, "图片内容过大，请裁剪后再上传");
        const cloudPath = "private-images/" + image.id + ".jpg";
        // Reserve the provider's real file ID before the external write. A process
        // exit after upload can then be recovered without listing private storage.
        const uploadMeta = uploadMetadata
          ? await uploadMetadata(cloudPath)
          : await (() => {
              const sdk = require("@cloudbase/node-sdk");
              return sdk
                .init({ env: sdk.SYMBOL_CURRENT_ENV })
                .getUploadMetadata({ cloudPath });
            })();
        const reservedId = uploadMeta.data?.fileId;
        ensure(
          typeof reservedId === "string" && reservedId.startsWith("cloud://"),
          "UNAVAILABLE",
          "无法登记图片上传任务",
        );
        await store.transaction(async (tx) => {
          const current = await tx.get("media", image.id);
          ensure(
            current?.status === "uploading" && current.expires_at > Date.now(),
            "INVALID_IMAGE",
            "图片上传任务已失效",
          );
          current.file_id = reservedId;
          await tx.put("media", image.id, current);
          await tx.put("file_deletions", image.id, {
            id: image.id,
            file_id: reservedId,
            status: "upload_reserved",
            not_before: current.expires_at,
          });
        });
        const uploaded = await cloud.uploadFile({
          cloudPath,
          fileContent: data,
        });
        // Persist the cleanup reference before calling the asynchronous moderation API.
        await store.transaction(async (tx) => {
          const current = await tx.get("media", image.id);
          if (current) {
            current.file_id = uploaded.fileID;
            await tx.put("media", image.id, current);
            // Keep an unexpected provider result recoverable as well.
            if (uploaded.fileID === reservedId)
              await tx.remove("file_deletions", image.id);
          } else
            await tx.put("file_deletions", image.id, {
              id: image.id,
              file_id: uploaded.fileID,
              status: "pending",
            });
        });
        const urls = await cloud.getTempFileURL({
          fileList: [uploaded.fileID],
        });
        const url = urls.fileList?.[0];
        ensure(
          url?.status === 0 && url.tempFileURL,
          "UNAVAILABLE",
          "无法读取待审核图片",
        );
        const review = await cloud.openapi.security.mediaCheckAsync({
          openid: context.OPENID,
          scene: 4,
          version: 2,
          mediaType: 2,
          mediaUrl: url.tempFileURL,
        });
        ensure(
          review.errCode === 0 && review.traceId,
          "UNAVAILABLE",
          "图片审核暂不可用",
        );
        return {
          file_id: uploaded.fileID,
          trace_id: review.traceId,
          width: info.width,
          height: info.height,
          status: "pending",
        };
      },
    },
  });
  async function api(event, context) {
    input(
      event && typeof event.action === "string" && event.action.length < 64,
    );
    const payload = event.payload || {};
    if (event.action === "platform.inspect") {
      keys(payload, ["kitchen_id"]);
      const kitchen = await service.execute("kitchen.read", payload, context);
      ensure(
        kitchen.role === "owner",
        "FORBIDDEN",
        "仅厨房主人可检查平台接入状态",
      );
      const [templates, categories] = await Promise.allSettled([
        cloud.openapi.subscribeMessage.getTemplateList({}),
        cloud.openapi.subscribeMessage.getCategory({}),
      ]);
      const safe = (r) =>
        r.status === "fulfilled"
          ? {
              err_code: r.value.errCode || 0,
              response_keys: Object.keys(r.value),
              data: (
                r.value.data ||
                r.value.categoryList ||
                r.value.templateList ||
                []
              ).map((t) =>
                Object.fromEntries(
                  Object.entries(t).filter(([k]) =>
                    [
                      "priTmplId",
                      "title",
                      "content",
                      "type",
                      "example",
                      "id",
                      "name",
                    ].includes(k),
                  ),
                ),
              ),
            }
          : {
              err_code: String(
                r.reason?.errCode || r.reason?.code || "UNAVAILABLE",
              ),
              data: [],
            };
      return { templates: safe(templates), categories: safe(categories) };
    }
    if (event.action === "poster.code") {
      const share = await service.execute("share.ownerRead", payload, context);
      ensure(
        env.SQUIDDY_POSTER_ENABLED === "true",
        "NOT_CONFIGURED",
        "正式小程序码尚未接通",
      );
      const scene = "s=" + share.id;
      input(scene.length <= 32, "请重新创建较短的公开分享");
      const codeEnv = env.SQUIDDY_CODE_ENV || "release";
      input(
        ["release", "trial", "develop"].includes(codeEnv),
        "小程序码版本配置无效",
      );
      const result = await cloud.openapi.wxacode.getUnlimited({
        scene,
        page: "pages/invite/index",
        checkPath: codeEnv === "release",
        envVersion: codeEnv,
        width: 360,
      });
      ensure(
        Buffer.isBuffer(result.buffer) && result.buffer.length > 8,
        "UNAVAILABLE",
        "生成小程序码失败",
      );
      return {
        base64: result.buffer.toString("base64"),
        title: share.title,
        dishes: share.dishes,
      };
    }
    if (event.action === "media.url" || event.action === "media.content") {
      const image = await service.execute("media.read", payload, context);
      ensure(image.status === "approved", "NOT_FOUND", "图片尚未审核通过");
      if (event.action === "media.content") {
        const r = await cloud.downloadFile({ fileID: image.file_id });
        ensure(
          Buffer.isBuffer(r.fileContent) &&
            r.fileContent.length > 0 &&
            r.fileContent.length <= 512 * 1024,
          "UNAVAILABLE",
          "图片暂不可用，请重新上传",
        );
        return { base64: r.fileContent.toString("base64"), type: "jpeg" };
      }
      const r = await cloud.getTempFileURL({ fileList: [image.file_id] });
      ensure(r.fileList?.[0]?.status === 0, "UNAVAILABLE", "图片暂不可用");
      return { url: r.fileList[0].tempFileURL };
    }
    const result = await service.execute(event.action, payload, context);
    if (event.action === "profile.get")
      result.features = {
        ...result.features,
        media:
          env.SQUIDDY_MEDIA_ENABLED === "true" && !!env.SQUIDDY_CALLBACK_SOURCE,
        poster: env.SQUIDDY_POSTER_ENABLED === "true",
      };
    return result;
  }
  async function callback(event, context) {
    // Diagnostic metadata never grants callback access and contains no sender identity.
    const source =
      typeof context.SOURCE === "string" ? context.SOURCE.slice(0, 80) : "";
    await store.transaction((tx) =>
      tx.put(
        "audit_events",
        "callback-source-" +
          crypt
            .hash(
              source +
                ":" +
                !!context.OPENID +
                ":" +
                !!context.FROM_APPID +
                ":" +
                (context.APPID === appid),
            )
            .slice(0, 24),
        {
          type: "platform_callback_context",
          source,
          has_appid: !!context.APPID,
          matches_context_appid: context.APPID === appid,
          has_openid: !!context.OPENID,
          has_from_appid: !!context.FROM_APPID,
          matches_event_appid: event?.appid === appid,
          event_is_media_check: event?.Event === "wxa_media_check",
          trace_fingerprint:
            typeof event?.trace_id === "string"
              ? crypt.hash(event.trace_id).slice(0, 24)
              : "",
          created_at: Date.now(),
        },
      ),
    );
    trustedSource(context, env.SQUIDDY_CALLBACK_SOURCE);
    ensure(context.APPID === appid, "FORBIDDEN", "应用不匹配");
    // Callback can arrive before media.complete commits its trace; keep a durable inbox.
    ensure(
      event.appid === appid &&
        event.Event === "wxa_media_check" &&
        event.MsgType === "event",
      "FORBIDDEN",
      "无效审核事件",
    );
    input(
      typeof event.trace_id === "string" &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(event.trace_id),
    );
    await store.transaction((tx) =>
      tx.put("media_callbacks", event.trace_id, {
        event: {
          appid: event.appid,
          Event: event.Event,
          MsgType: event.MsgType,
          trace_id: event.trace_id,
          errcode: event.errcode,
          result: { suggest: event.result?.suggest || "" },
        },
        created_at: Date.now(),
      }),
    );
    return applyMediaResult(store, event, appid);
  }
  async function maintenance(event, context) {
    trustedSource(context, "wx_trigger");
    const deadline = maintenanceClock() + 1800;
    let processed = 0;
    const cursor = await store.transaction(
      async (tx) => (await tx.get("maintenance_state", "cursors")) || {},
    );
    const batches = [];
    function batch(table, work, limit = 10) {
      batches.push({ table, work, limit });
    }
    await batch("cleanup_jobs", async (id, data) => {
      if (data.status !== "completed")
        await cleanupBatch(store, id, { batchSize: 5, hash: crypt.hash });
    });
    await batch("media_callbacks", async (id, data) => {
      const result = await applyMediaResult(store, data.event, appid);
      if (!result.ignored || Date.now() - data.created_at > 86400000)
        await store.transaction((tx) => tx.remove("media_callbacks", id));
    });
    await batch("file_deletions", async (id, data) => {
      if (data.status === "upload_reserved") {
        if (!data.not_before || data.not_before > Date.now()) return;
        const owned = await store.transaction(async (tx) => {
          const image = await tx.get("media", id);
          if (image?.file_id === data.file_id) {
            await tx.remove("file_deletions", id);
            return true;
          }
          return false;
        });
        if (owned) return;
      }
      try {
        ensure(
          typeof data.file_id === "string" &&
            data.file_id.length <= 512 &&
            /^cloud:\/\/[^/]+\/[^\u0000]+$/.test(data.file_id),
          "INVALID_FILE_ID",
          "清理任务的文件标识无效",
        );
        const result = await cloud.deleteFile({ fileList: [data.file_id] });
        // The SDK defines -503003 as STORAGE_FILE_NONEXIST. Deletion can
        // already have succeeded before an acknowledgement or cursor was lost.
        if (
          result.fileList?.length !== 1 ||
          ![0, -503003].includes(result.fileList[0].status)
        )
          throw {
            code: "DELETE_" + (result.fileList?.[0]?.status ?? "NO_RECEIPT"),
          };
        await store.transaction(async (tx) => {
          const current = await tx.get("file_deletions", id);
          if (current?.file_id === data.file_id)
            await tx.remove("file_deletions", id);
        });
      } catch (error) {
        await store.transaction(async (tx) => {
          const current = await tx.get("file_deletions", id);
          if (current?.file_id !== data.file_id) return;
          current.failures = Math.min((current.failures || 0) + 1, 1000000);
          current.last_failed_at = Date.now();
          current.last_error_code = String(
            error?.errCode || error?.code || "UNAVAILABLE",
          )
            .replace(/[^a-zA-Z0-9_-]/g, "")
            .slice(0, 64);
          await tx.put("file_deletions", id, current);
        });
        throw error;
      }
    });
    await batch("notification_jobs", async (id, data) => {
      if (
        data.status === "sending" &&
        Date.now() - data.attempted_at > 10 * 60000
      ) {
        await store.transaction(async (tx) => {
          const j = await tx.get("notification_jobs", id);
          if (j?.status === "sending") {
            j.status = "unknown";
            await tx.put("notification_jobs", id, j);
          }
        });
        return;
      }
      await processNotification(store, id, {
        hash: crypt.hash,
        template: notificationConfig,
        send: async (job) => {
          const r = await cloud.openapi.subscribeMessage.send({
            touser: job.openid,
            templateId: job.template.template_id,
            page: "pages/meal/index?id=" + job.meal_id,
            miniprogramState: env.SQUIDDY_MESSAGE_ENV || "formal",
            data: {
              [env.SQUIDDY_TEMPLATE_TITLE_KEY]: {
                value: job.title.slice(0, 20),
              },
              [env.SQUIDDY_TEMPLATE_STATUS_KEY]: { value: "开饭啦" },
            },
          });
          if (r.errCode !== 0) throw { code: String(r.errCode) };
        },
      });
    });
    await batch("media", async (id, data) => {
      if (!data.expires_at || data.expires_at > Date.now()) return;
      await store.transaction(async (tx) => {
        const image = await tx.get("media", id);
        if (!image) return;
        const k = await tx.get("kitchens", image.kitchen_id);
        const referenced = await referencedByKitchen(tx, id, k, image);
        if (!referenced) {
          if (image.file_id)
            await tx.put("file_deletions", id, {
              id,
              file_id: image.file_id,
              status: "pending",
            });
          if (image.trace_id) await tx.remove("media_traces", image.trace_id);
          await tx.remove("media", id);
        } else if (["pending", "uploading"].includes(image.status)) {
          image.status = "failed";
          await tx.put("media", id, image);
        }
      });
    });
    for (const table of ["receipts", "audit_events"])
      await batch(
        table,
        async (id, data) => {
          if (Date.now() - data.created_at > 30 * 86400000)
            await store.transaction((tx) => tx.remove(table, id));
        },
        20,
      );
    // Leave time for the cursor commit within the free environment's 3s limit.
    // Rotate tables even after a partial batch so a busy queue cannot starve
    // notification recovery or retention cleanup.
    const startBatch = Number.isInteger(cursor.next_batch)
      ? cursor.next_batch % batches.length
      : 0;
    for (let offset = 0; offset < batches.length; offset++) {
      if (maintenanceClock() >= deadline) break;
      const index = (startBatch + offset) % batches.length;
      const { table, work, limit } = batches[index];
      const rows = await store.transaction((tx) =>
        tx.scan(table, limit, cursor[table] || ""),
      );
      let visited = 0;
      let deferred = false;
      for (const { id, data } of rows) {
        // A media reference check has several transactional reads/writes. Do not
        // start it at the tail of a 3s invocation and repeatedly lose its commit.
        const reserve =
          table === "media"
            ? 1400
            : table === "file_deletions"
              ? 900
              : table === "cleanup_jobs" && data.status !== "completed"
                ? 1200
                : 0;
        if (maintenanceClock() + reserve >= deadline) {
          deferred = true;
          break;
        }
        try {
          await work(id, data);
          processed++;
        } catch (e) {
          console.warn("maintenance.item_failed", { table, code: safeCode(e) });
          await store.transaction((tx) =>
            tx.put(
              "audit_events",
              "maintenance-failure-" +
                crypt.hash(table + ":" + id).slice(0, 24),
              {
                type: "maintenance_item_failure",
                table,
                code: safeCode(e),
                provider_code: String(e?.errCode || e?.code || "UNAVAILABLE")
                  .replace(/[^a-zA-Z0-9_-]/g, "")
                  .slice(0, 64),
                created_at: Date.now(),
              },
            ),
          );
        }
        cursor[table] = id;
        visited++;
      }
      if (visited === rows.length && rows.length < limit) cursor[table] = "";
      cursor.next_batch =
        deferred && visited === 0 ? index : (index + 1) % batches.length;
      if (deferred) break;
    }
    cursor.last_completed_at = Date.now();
    cursor.last_processed = processed;
    await store.transaction((tx) =>
      tx.put("maintenance_state", "cursors", cursor),
    );
    return { processed, cursors: cursor };
  }
  const handlers = {
    api,
    publicRead: (event) => publicRead(store, event.share_id),
    platformCallback: callback,
    maintenance,
  };
  async function handle(kind, event, context) {
    const start = Date.now();
    try {
      ensure(appid, "NOT_CONFIGURED", "服务尚未配置");
      const data = await handlers[kind](event, context);
      console.info("request.complete", {
        kind,
        action: String(event?.action || "")
          .replace(/[^a-zA-Z0-9_.-]/g, "")
          .slice(0, 64),
        elapsed_ms: Date.now() - start,
      });
      return { ok: true, data };
    } catch (error) {
      const code = safeCode(error);
      const diagnostic = {
        kind,
        action: String(event?.action || "")
          .replace(/[^a-zA-Z0-9_.-]/g, "")
          .slice(0, 64),
        code,
        provider_code: String(error?.errCode || error?.code || "")
          .replace(/[^a-zA-Z0-9_-]/g, "")
          .slice(0, 64),
        operation: String(
          error?.providerOperation || error?.errMsg || error?.message || "",
        )
          .split(":")[0]
          .replace(/[^a-zA-Z0-9_.-]/g, "")
          .slice(0, 80),
        elapsed_ms: Date.now() - start,
      };
      console.warn("request.failed", {
        ...diagnostic,
      });
      // Private operational evidence when the environment has no paid log service.
      // Do not persist request bodies, identities, error messages or stack traces.
      if (!(error instanceof AppError) || error.providerOperation) {
        try {
          const id = crypto.randomBytes(12).toString("hex");
          await store.transaction((tx) =>
            tx.put("audit_events", id, {
              id,
              type: "runtime_error",
              ...diagnostic,
              created_at: Date.now(),
            }),
          );
        } catch {
          console.warn("request.diagnostic_write_failed", { kind });
        }
      }
      return {
        ok: false,
        error: {
          code,
          message:
            error instanceof AppError
              ? error.message
              : "服务暂不可用，请稍后重试",
        },
      };
    }
  }
  return { handle, api, callback, maintenance, store };
}
module.exports = { makeRuntime, trustedSource };
