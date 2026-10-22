const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fixture, APP } = require("./helpers/fixture.cjs");
const { cleanupBatch } = require("../domain/maintenance");
const { makeRuntime } = require("../cloudfunctions/maintenance/shared/runtime");
const { createMemoryStore } = require("../domain/store");
async function prepared() {
  const f = fixture();
  const original = (
    await f.call("chef", "kitchen.create", { name: "保留厨房" })
  ).id;
  const kid = (await f.call("chef", "kitchen.create", { name: "待回收厨房" }))
    .id;
  const dish = (
    await f.call("chef", "dish.save", {
      kitchen_id: kid,
      name: "菜",
      category: "vegetable",
      ingredients: ["番茄"],
      allergens: [],
      minutes: 10,
    })
  ).id;
  const mids = [];
  for (let i = 0; i < 40; i++)
    mids.push(
      (
        await f.call("chef", "meal.publish", {
          kitchen_id: kid,
          title: "餐",
          dish_ids: [dish],
          scheduled_at: f.now() + 86400000,
          cutoff_at: f.now() + 43200000,
        })
      ).id,
    );
  await f.call("chef", "meal.cancel", {
    meal_id: mids[0],
    expected_revision: 1,
  });
  mids.push(
    (
      await f.call("chef", "meal.publish", {
        kitchen_id: kid,
        title: "新餐",
        dish_ids: [dish],
        scheduled_at: f.now() + 86400000,
        cutoff_at: f.now() + 43200000,
      })
    ).id,
  );
  for (const mid of mids.slice(1))
    await f.call("chef", "meal.cancel", { meal_id: mid, expected_revision: 1 });
  await f.store.transaction(async (tx) => {
    await tx.put("media", "target-image", {
      id: "target-image",
      kitchen_id: kid,
      actor: f.actorId("chef"),
      file_id: "cloud://test/cleanup-target",
      status: "approved",
    });
    for (let i = 0; i < 300; i++)
      await tx.put(
        "meal_memberships",
        "foreign-" + String(i).padStart(4, "0"),
        { meal_id: "foreign-meal", user_id: "foreign-user", status: "active" },
      );
  });
  const k = await f.call("chef", "kitchen.read", { kitchen_id: kid });
  await f.call("chef", "kitchen.close", {
    kitchen_id: kid,
    expected_revision: k.revision,
  });
  return { ...f, kid, original, jid: "kitchen-" + kid };
}
test("真实调度入口代码按范围回收41餐，不扫描300条无关成员；文件失败时不完成且恢复后完成", async () => {
  const f = await prepared();
  let fail = true,
    deletes = 0;
  const r = makeRuntime({
    store: f.store,
    cloud: {
      database: () => ({}),
      deleteFile: async () => {
        deletes++;
        if (fail) throw Error("provider unavailable");
        return { fileList: [{ status: 0 }] };
      },
    },
    env: { SQUIDDY_APP_ID: APP },
  });
  for (let i = 0; i < 8; i++)
    await r.maintenance(
      { Type: "Timer", TriggerName: "test-only" },
      { SOURCE: "wx_trigger" },
    );
  let s = f.store.snapshot();
  assert.equal(s.cleanup_jobs[f.jid].status, "running");
  assert.equal(s.cleanup_jobs[f.jid].scanned_rows < 200, true);
  assert.ok(s.file_deletions["target-image"]);
  assert.ok(deletes);
  fail = false;
  for (
    let i = 0;
    i < 8 && f.store.snapshot().cleanup_jobs[f.jid].status !== "completed";
    i++
  )
    await r.maintenance(
      { Type: "Timer", TriggerName: "test-only" },
      { SOURCE: "wx_trigger" },
    );
  s = f.store.snapshot();
  assert.equal(s.cleanup_jobs[f.jid].status, "completed");
  assert.equal(s.kitchens[f.kid], undefined);
  assert.ok(s.kitchens[f.original]);
  assert.equal(Object.keys(s.meals || {}).length, 0);
  assert.equal(Object.keys(s.meal_memberships).length, 300);
  assert.equal(s.file_deletions["target-image"], undefined);
  assert.equal(s.cleanup_jobs[f.jid].last_scheduler_run.source, "wx_trigger");
  assert.ok(
    s.cleanup_jobs[f.jid].completed_at >= s.cleanup_jobs[f.jid].started_at,
  );
  assert.ok(
    Object.keys(s.receipts).length > 80,
    "厨房回收保留幂等回执正常保留期",
  );
});
test("批量删除失败回滚文档和游标；重入不会跳过未删记录", async () => {
  const memory = createMemoryStore({
    cleanup_jobs: {
      job: {
        kind: "kitchen",
        kitchen_id: "k",
        dish_ids: ["d1", "d2"],
        meal_ids: [],
        table: 14,
        cursor: "",
        status: "pending",
      },
    },
    dishes: {
      d1: { kitchen_id: "k" },
      d2: { kitchen_id: "k" },
      foreign: { kitchen_id: "other" },
    },
  });
  const before = memory.snapshot();
  const store = {
    transaction: (fn) =>
      memory.transaction((tx) =>
        fn({
          ...tx,
          removeMany: async (c, ids) => {
            await tx.remove(c, ids[0]);
            throw Error("bulk failed");
          },
        }),
      ),
  };
  await assert.rejects(cleanupBatch(store, "job"), /bulk failed/);
  assert.deepEqual(memory.snapshot(), before);
  await cleanupBatch(memory, "job");
  assert.equal(Object.keys(memory.snapshot().dishes).length, 1);
});
test("空过滤条件不扫描全库，游标与资源筛选同时生效", async () => {
  const memory = createMemoryStore({
    rows: {
      a: { kitchen_id: "k" },
      b: { kitchen_id: "other" },
      c: { kitchen_id: "k" },
    },
  });
  await memory.transaction(async (tx) => {
    assert.deepEqual(await tx.scan("rows", 20, "", []), []);
    assert.deepEqual(
      (
        await tx.scan("rows", 20, "a", [{ field: "kitchen_id", values: ["k"] }])
      ).map((x) => x.id),
      ["c"],
    );
  });
});
test("云适配器使用事务内主键删除，失败会拒绝整个推进而不调用非事务条件删除", async () => {
  const { cloudStore } = require("../cloud/shared/store");
  const pending = new Set(),
    removed = [],
    original = ["a", "b", "c"];
  let fail = true,
    committed = [...original];
  const db = {
    runTransaction: async (fn) => {
      pending.clear();
      const result = await fn({
        collection: () => ({
          where: () => {
            throw Error("non-transactional query remove");
          },
          doc: (id) => ({
            remove: async () => {
              removed.push(id);
              if (fail && id === "b") throw Error("delete failed");
              pending.add(id);
            },
          }),
        }),
      });
      committed = original.filter((id) => !pending.has(id));
      return result;
    },
  };
  const store = cloudStore(db);
  await assert.rejects(
    store.transaction((tx) => tx.removeMany("rows", original)),
    /delete failed/,
  );
  assert.deepEqual(committed, original);
  fail = false;
  await store.transaction((tx) => tx.removeMany("rows", original));
  assert.deepEqual(committed, []);
  assert.deepEqual(new Set(removed), new Set(original));
});
