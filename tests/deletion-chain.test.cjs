const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setup, APP } = require("./helpers/fixture.cjs");
const { makeRuntime } = require("../cloudfunctions/api/shared/runtime");
const sharp = require("../cloudfunctions/api/node_modules/sharp");

// Platform identities and moderation are substitutes. File bytes and the deployed
// runtime/cleanup code are real; this is not a second WeChat account acceptance.
test("云运行时代码注销全链：即时撤权、共享图保留、文件失败阻塞完成、恢复后清空私人数据", async () => {
  const f = await setup();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "squiddy-delete-"));
  let seq = 0,
    trace = 0,
    failDelete = true,
    deleteAttempts = 0;
  const context = (name) => ({ APPID: APP, OPENID: name, SOURCE: "wx_client" });
  const filePath = (id) => path.join(dir, path.basename(id));
  const cloud = {
    database: () => ({}),
    openapi: {
      security: {
        msgSecCheck: async () => ({ errCode: 0, result: { suggest: "pass" } }),
        mediaCheckAsync: async () => ({
          errCode: 0,
          traceId: "trace" + ++trace,
        }),
      },
    },
    uploadFile: async ({ cloudPath, fileContent }) => {
      const fileID = "cloud://test/" + cloudPath;
      await fs.writeFile(filePath(fileID), fileContent);
      return { fileID };
    },
    getTempFileURL: async () => ({
      fileList: [{ status: 0, tempFileURL: "https://example.invalid/test" }],
    }),
    downloadFile: async ({ fileID }) => ({
      fileContent: await fs.readFile(filePath(fileID)),
    }),
    deleteFile: async ({ fileList }) => {
      deleteAttempts++;
      if (failDelete) return { fileList: [{ status: -503002 }] };
      await fs.unlink(filePath(fileList[0]));
      return { fileList: [{ status: 0 }] };
    },
  };
  const r = makeRuntime({
    cloud,
    store: f.store,
    maintenanceClock: () => 0,
    uploadMetadata: async (cloudPath) => ({
      data: { fileId: "cloud://test/" + cloudPath },
    }),
    env: {
      SQUIDDY_APP_ID: APP,
      SQUIDDY_INVITE_KEY: "test-key-with-at-least-32-characters",
      SQUIDDY_MEDIA_ENABLED: "true",
      SQUIDDY_CALLBACK_SOURCE: "wx_callback",
    },
  });
  const call = async (actor, action, payload = {}) =>
    r.handle(
      "api",
      { action, payload: { ...payload, request_id: "chain_" + ++seq } },
      context(actor),
    );
  const ok = async (...args) => {
    const x = await call(...args);
    assert.equal(x.ok, true, JSON.stringify(x));
    return x.data;
  };
  try {
    assert.equal(
      (await call("chef", "account.delete")).error.code,
      "OWNER_TRANSFER_REQUIRED",
    );
    let k = await f.call("chef", "kitchen.read", { kitchen_id: f.kid });
    await ok("chef", "member.role", {
      kitchen_id: f.kid,
      member_id: f.actorId("alice"),
      role: "cook",
      expected_revision: k.revision,
    });
    const bytes = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#eecbaa" },
    })
      .jpeg()
      .toBuffer();
    const images = [];
    for (let i = 0; i < 2; i++) {
      const image = await ok("alice", "media.prepare", { kitchen_id: f.kid });
      await ok("alice", "media.complete", {
        media_id: image.id,
        base64: bytes.toString("base64"),
      });
      const result = await r.handle(
        "platformCallback",
        {
          appid: APP,
          Event: "wxa_media_check",
          MsgType: "event",
          trace_id: "trace" + trace,
          errcode: 0,
          result: { suggest: "pass" },
        },
        { APPID: APP, SOURCE: "wx_callback" },
      );
      assert.equal(result.ok, true);
      images.push(image.id);
    }
    k = await ok("chef", "kitchen.read", { kitchen_id: f.kid });
    await ok("chef", "kitchen.update", {
      kitchen_id: f.kid,
      name: k.name,
      description: k.description,
      image_id: images[0],
      expected_revision: k.revision,
    });
    await ok("alice", "selection.replace", {
      meal_id: f.mid,
      expected_revision: 0,
      items: [{ dish_id: f.dishes[0], quantity: 1 }],
      note: "delete-chain-private-note",
    });
    await ok("alice", "feedback.submit", {
      message: "delete-chain-private-feedback",
    });
    const uploaded = f.store.snapshot().media;
    const sharedFile = uploaded[images[0]].file_id,
      orphanFile = uploaded[images[1]].file_id;
    const savedShared = await fs.readFile(filePath(sharedFile));
    await ok("alice", "account.delete");
    assert.equal(
      (await ok("alice", "account.deletionStatus")).status,
      "pending",
    );
    for (const action of [
      "profile.get",
      "export.mine",
      "feedback.read",
      "account.delete",
    ])
      assert.equal((await call("alice", action)).error.code, "ACCOUNT_DELETED");
    assert.equal(
      (await call("alice", "media.content", { media_id: images[0] })).error
        .code,
      "ACCOUNT_DELETED",
    );
    assert.ok(
      !JSON.stringify(
        await ok("chef", "meal.read", { meal_id: f.mid }),
      ).includes("delete-chain-private-note"),
    );
    assert.equal(
      (await ok("chef", "kitchen.read", { kitchen_id: f.kid })).members.length,
      2,
    );
    for (let i = 0; i < 180; i++)
      await r.maintenance({}, { SOURCE: "wx_trigger" });
    assert.ok(deleteAttempts > 0);
    assert.notEqual(
      (await ok("alice", "account.deletionStatus")).status,
      "completed",
    );
    assert.ok(f.store.snapshot().file_deletions[images[1]]);
    assert.ok(await fs.readFile(filePath(orphanFile)));
    failDelete = false;
    for (let i = 0; i < 80; i++) {
      await r.maintenance({}, { SOURCE: "wx_trigger" });
      if ((await ok("alice", "account.deletionStatus")).status === "completed")
        break;
    }
    assert.equal(
      (await ok("alice", "account.deletionStatus")).status,
      "completed",
    );
    const state = f.store.snapshot();
    assert.deepEqual(state.users[f.actorId("alice")], {
      id: f.actorId("alice"),
      status: "deleted",
    });
    assert.equal(state.media[images[0]].actor, undefined);
    assert.equal(state.media[images[0]].upload_request, undefined);
    assert.equal(state.media[images[0]].owner_scope, "kitchen");
    assert.equal(state.media[images[1]], undefined);
    assert.equal(state.file_deletions[images[1]], undefined);
    await assert.rejects(fs.access(filePath(orphanFile)), { code: "ENOENT" });
    assert.deepEqual(await fs.readFile(filePath(sharedFile)), savedShared);
    assert.equal(
      (await ok("chef", "media.content", { media_id: images[0] })).base64,
      savedShared.toString("base64"),
    );
    for (const table of [
      "memberships",
      "meal_memberships",
      "selections",
      "feedback",
      "receipts",
    ])
      assert.ok(
        !Object.values(state[table] || {}).some(
          (x) =>
            x.user_id === f.actorId("alice") || x.actor === f.actorId("alice"),
        ),
        table,
      );
    assert.ok(!JSON.stringify(state).includes("delete-chain-private-note"));
    assert.ok(!JSON.stringify(state).includes("delete-chain-private-feedback"));
    assert.equal(
      (await call("alice", "profile.get")).error.code,
      "ACCOUNT_DELETED",
    );
    assert.equal((await ok("chef", "profile.get")).kitchens.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
