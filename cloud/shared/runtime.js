"use strict";
const crypto = require("node:crypto");
const { cloudStore } = require("./store");
const { AppError, ensure, input } = require("../domain/errors");
const { createService } = require("../domain/service");
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
      !context.OPENID &&
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
      const r = await cloud.openapi.security.msgSecCheck({
        openid,
        scene: 4,
        version: 2,
        content,
      });
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
        const { data, info } = await parser
          .rotate()
          .resize({
            width: 1600,
            height: 1600,
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({ quality: 85 })
          .toBuffer({ resolveWithObject: true });
        const uploaded = await cloud.uploadFile({
          cloudPath: "private-images/" + image.id + ".jpg",
          fileContent: data,
        });
        // Persist the cleanup reference before calling the asynchronous moderation API.
        await store.transaction(async (tx) => {
          const current = await tx.get("media", image.id);
          if (current) {
            current.file_id = uploaded.fileID;
            await tx.put("media", image.id, current);
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
    if (event.action === "poster.code") {
      const share = await service.execute("share.ownerRead", payload, context);
      ensure(
        env.SQUIDDY_POSTER_ENABLED === "true",
        "NOT_CONFIGURED",
        "正式小程序码尚未接通",
      );
      const scene = "s=" + share.id;
      input(scene.length <= 32, "请重新创建较短的公开分享");
      const result = await cloud.openapi.wxacode.getUnlimited({
        scene,
        page: "pages/invite/index",
        checkPath: true,
        envVersion: env.SQUIDDY_CODE_ENV || "release",
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
    if (event.action === "media.url") {
      const image = await service.execute("media.read", payload, context);
      ensure(image.status === "approved", "NOT_FOUND", "图片尚未审核通过");
      const r = await cloud.getTempFileURL({ fileList: [image.file_id] });
      ensure(r.fileList?.[0]?.status === 0, "UNAVAILABLE", "图片暂不可用");
      return { url: r.fileList[0].tempFileURL };
    }
    return service.execute(event.action, payload, context);
  }
  async function callback(event, context) {
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
    let processed = 0;
    const cursor = await store.transaction(
      async (tx) => (await tx.get("maintenance_state", "cursors")) || {},
    );
    async function batch(table, work, limit = 10) {
      const rows = await store.transaction((tx) =>
        tx.scan(table, limit, cursor[table] || ""),
      );
      for (const { id, data } of rows) {
        try {
          await work(id, data);
          processed++;
        } catch (e) {
          console.warn("maintenance.item_failed", { table, code: safeCode(e) });
        }
      }
      cursor[table] = rows.length < limit ? "" : rows.at(-1).id;
    }
    await batch("cleanup_jobs", async (id, data) => {
      if (data.status !== "completed") await cleanupBatch(store, id);
    });
    await batch("media_callbacks", async (id, data) => {
      const result = await applyMediaResult(store, data.event, appid);
      if (!result.ignored || Date.now() - data.created_at > 86400000)
        await store.transaction((tx) => tx.remove("media_callbacks", id));
    });
    await batch("file_deletions", async (id, data) => {
      const result = await cloud.deleteFile({ fileList: [data.file_id] });
      if (result.fileList?.every((f) => f.status === 0))
        await store.transaction((tx) => tx.remove("file_deletions", id));
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
        template: notificationConfig,
        send: async (job) => {
          const r = await cloud.openapi.subscribeMessage.send({
            touser: job.openid,
            templateId: job.template.template_id,
            page: "pages/meal/index?id=" + job.meal_id,
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
        let referenced = k?.image_id === id;
        for (const did of k?.dish_ids || []) {
          const d = await tx.get("dishes", did);
          if (d?.image_id === id) {
            referenced = true;
            break;
          }
        }
        if (!referenced)
          for (const mid of k?.meal_ids || []) {
            const m = await tx.get("meals", mid);
            if (m?.menu.some((d) => d.image_id === id)) {
              referenced = true;
              break;
            }
          }
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
        action: event?.action || "",
        elapsed_ms: Date.now() - start,
      });
      return { ok: true, data };
    } catch (error) {
      const code = safeCode(error);
      console.warn("request.failed", {
        kind,
        code,
        elapsed_ms: Date.now() - start,
      });
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
