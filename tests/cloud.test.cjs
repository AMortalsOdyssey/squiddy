const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  makeRuntime,
  trustedSource,
} = require("../cloudfunctions/api/shared/runtime");
const { createMemoryStore } = require("../domain/store");
const { createService } = require("../domain/service");
const { fixture, setup, APP } = require("./helpers/fixture.cjs");
function runtime(extra = {}) {
  const store = extra.store || createMemoryStore();
  let sends = 0;
  const cloud = {
    database: () => ({}),
    openapi: {
      security: {
        msgSecCheck: async () => ({ errCode: 0, result: { suggest: "pass" } }),
        mediaCheckAsync: async () => ({ errCode: 0, traceId: "trace-1" }),
      },
      subscribeMessage: {
        send: async () => {
          sends++;
          return { errCode: 0 };
        },
      },
    },
    uploadFile: async () => ({ fileID: "cloud://test/private.jpg" }),
    getTempFileURL: async () => ({
      fileList: [
        { status: 0, tempFileURL: "https://example.invalid/private-signed" },
      ],
    }),
    deleteFile: async () => ({ fileList: [{ status: 0 }] }),
  };
  return {
    ...makeRuntime({
      cloud,
      store,
      env: {
        SQUIDDY_APP_ID: APP,
        SQUIDDY_INVITE_KEY: "test-key-only-32-characters-long-xxxx",
        ...extra.env,
      },
    }),
    cloud,
    sends: () => sends,
  };
}
const ctx = { APPID: APP, OPENID: "chef" };
test("云入口只信SDK身份，公开入口不暴露通用业务动作", async () => {
  const r = runtime();
  assert.equal(
    (
      await r.handle(
        "api",
        { action: "profile.get", payload: { OPENID: "chef" } },
        {},
      )
    ).error.code,
    "UNAUTHORIZED",
  );
  assert.equal(
    (
      await r.handle(
        "publicRead",
        { action: "profile.get", share_id: "no-share" },
        {},
      )
    ).error.code,
    "NOT_FOUND",
  );
});
test("图片回调配置缺失、客户端链、跨应用伪造均拒绝", async () => {
  for (const source of ["wx_client", "wx_client,scf", "http", ""])
    assert.throws(() => trustedSource({ SOURCE: source }, source));
  const r = runtime();
  assert.equal(
    (await r.handle("platformCallback", {}, {})).error.code,
    "FORBIDDEN",
  );
});
test("审核回调早到可留存，maintenance在trace提交后应用", async () => {
  const r = runtime({
    env: { SQUIDDY_CALLBACK_SOURCE: "verified-test-source" },
  });
  const e = {
    appid: APP,
    Event: "wxa_media_check",
    MsgType: "event",
    trace_id: "trace-early",
    errcode: 0,
    result: { suggest: "pass" },
  };
  await r.callback(e, { APPID: APP, SOURCE: "verified-test-source" });
  await r.store.transaction(async (t) => {
    await t.put("media", "image1", {
      id: "image1",
      trace_id: "trace-early",
      status: "pending",
    });
    await t.put("media_traces", "trace-early", { media_id: "image1" });
  });
  await r.maintenance({}, { SOURCE: "wx_trigger" });
  assert.equal(r.store.snapshot().media.image1.status, "approved");
  assert.equal(Object.keys(r.store.snapshot().media_callbacks).length, 0);
});
test("云图片先鉴权，再重编码；JPEG输出无EXIF，不直传原文件", async () => {
  const r = runtime({
    env: {
      SQUIDDY_MEDIA_ENABLED: "true",
      SQUIDDY_CALLBACK_SOURCE: "verified-test-source",
    },
  });
  const sharp = require("../cloudfunctions/api/node_modules/sharp");
  const bytes = await sharp({
    create: { width: 64, height: 32, channels: 3, background: "#ff0000" },
  })
    .withExif({ IFD0: { Artist: "private-name" } })
    .jpeg()
    .toBuffer();
  let uploaded;
  r.cloud.uploadFile = async ({ fileContent }) => {
    uploaded = fileContent;
    return { fileID: "cloud://test/private.jpg" };
  };
  const k = await r.api(
    {
      action: "kitchen.create",
      payload: { request_id: "k1", name: "测试厨房" },
    },
    ctx,
  );
  const ticket = await r.api(
    {
      action: "media.prepare",
      payload: { request_id: "m1", kitchen_id: k.id },
    },
    ctx,
  );
  const result = await r.api(
    {
      action: "media.complete",
      payload: {
        request_id: "u1",
        media_id: ticket.id,
        base64: bytes.toString("base64"),
      },
    },
    ctx,
  );
  assert.equal(result.status, "pending");
  const meta = await sharp(uploaded).metadata();
  assert.equal(meta.exif, undefined);
  assert.equal(meta.format, "jpeg");
  assert.equal(
    (
      await r.handle(
        "api",
        { action: "media.url", payload: { media_id: ticket.id } },
        ctx,
      )
    ).error.code,
    "NOT_FOUND",
  );
});
test("图片审核未配置时拒绝云上传，不假装通过", async () => {
  const r = runtime();
  let count = 0;
  r.cloud.uploadFile = async () => {
    count++;
  };
  const k = await r.api(
    {
      action: "kitchen.create",
      payload: { request_id: "k1", name: "测试厨房" },
    },
    ctx,
  );
  const ticket = await r.api(
    {
      action: "media.prepare",
      payload: { request_id: "m1", kitchen_id: k.id },
    },
    ctx,
  );
  const out = await r.handle(
    "api",
    {
      action: "media.complete",
      payload: { request_id: "u1", media_id: ticket.id, base64: "AAAA" },
    },
    ctx,
  );
  assert.equal(out.error.code, "NOT_CONFIGURED");
  assert.equal(count, 0);
});
test("重试事务不重复调用图片外部审核；同请求重放只上传一次", async () => {
  const f = fixture();
  const { id: kid } = await f.call("chef", "kitchen.create", {
    name: "图片厨房",
  });
  const { id } = await f.call("chef", "media.prepare", { kitchen_id: kid });
  let calls = 0;
  const retrying = {
    transaction: async (fn) => {
      await createMemoryStore(f.store.snapshot()).transaction(fn);
      return f.store.transaction(fn);
    },
  };
  const service = createService({
    store: retrying,
    crypto: f.crypt,
    expectedAppId: APP,
    clock: f.now,
    media: {
      accept: async () => {
        calls++;
        return {
          status: "pending",
          file_id: "cloud://test",
          trace_id: "t",
          width: 1,
          height: 1,
        };
      },
    },
  });
  const p = { media_id: id, request_id: "upload1" };
  await service.execute("media.complete", p, ctx);
  await service.execute("media.complete", p, ctx);
  assert.equal(calls, 1);
});
test("scheduler持久化游标，已完成任务不阻塞第11个任务", async () => {
  const r = runtime();
  await r.store.transaction(async (t) => {
    for (let i = 0; i < 12; i++)
      await t.put("cleanup_jobs", "job" + String(i).padStart(2, "0"), {
        status: "completed",
      });
    await t.put("notification_jobs", "send-old", {
      status: "sending",
      attempted_at: Date.now() - 3600000,
    });
  });
  await r.maintenance({}, { SOURCE: "wx_trigger" });
  assert.equal(
    r.store.snapshot().maintenance_state.cursors.cleanup_jobs,
    "job09",
  );
  await r.maintenance({}, { SOURCE: "wx_trigger" });
  assert.equal(r.store.snapshot().maintenance_state.cursors.cleanup_jobs, "");
  assert.equal(
    r.store.snapshot().notification_jobs["send-old"].status,
    "unknown",
  );
});
test("注销即时移除索引、成员数、厨师可见的个人备注", async () => {
  const f = await setup();
  await f.call("alice", "selection.replace", {
    meal_id: f.mid,
    expected_revision: 0,
    items: [{ dish_id: f.dishes[0], quantity: 1 }],
    note: "private-note",
  });
  await f.call("alice", "account.delete");
  const m = await f.call("chef", "meal.read", { meal_id: f.mid });
  assert.equal(m.participant_count, 2);
  assert.ok(!JSON.stringify(m).includes("private-note"));
  assert.ok(
    !f.store.snapshot().kitchens[f.kid].member_ids.includes(f.actorId("alice")),
  );
});
test("SDK兼容导入和原型污染防护", () => {
  for (const name of ["api", "publicRead", "platformCallback", "maintenance"]) {
    const sdk = require(
      "../cloudfunctions/" + name + "/node_modules/wx-server-sdk",
    );
    assert.equal(typeof sdk.init, "function");
    assert.equal(typeof sdk.getWXContext, "function");
    const set = require(
      "../cloudfunctions/" + name + "/node_modules/lodash.set",
    );
    set({}, "__proto__.squiddyPolluted", true);
    set({}, "constructor.prototype.squiddyPolluted", true);
    assert.equal({}.squiddyPolluted, undefined);
  }
});
test("海报小程序码先鉴权、默认关闭，scene不含邀请口令且不超过32字符", async () => {
  const f = await setup();
  const share = await f.call("chef", "share.create", { meal_id: f.mid });
  assert.equal(share.id.length, 24);
  const r = runtime({
    store: f.store,
    env: { SQUIDDY_POSTER_ENABLED: "true" },
  });
  let scene;
  r.cloud.openapi.wxacode = {
    getUnlimited: async (p) => {
      scene = p.scene;
      return { buffer: Buffer.from("PNG-test-only") };
    },
  };
  const output = await r.api(
    { action: "poster.code", payload: { share_id: share.id } },
    ctx,
  );
  assert.equal(scene, "s=" + share.id);
  assert.ok(scene.length <= 32);
  assert.ok(output.base64);
  assert.ok(!JSON.stringify(output).includes("price"));
  await assert.rejects(
    r.api(
      { action: "poster.code", payload: { share_id: share.id } },
      { ...ctx, OPENID: "alice" },
    ),
    (e) => e.code === "FORBIDDEN",
  );
  const disabled = runtime({ store: f.store });
  await assert.rejects(
    disabled.api(
      { action: "poster.code", payload: { share_id: share.id } },
      ctx,
    ),
    (e) => e.code === "NOT_CONFIGURED",
  );
});
