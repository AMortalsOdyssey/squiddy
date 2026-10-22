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
  await f.store.transaction(async (tx) => {
    for (let i = 0; i < 60; i++)
      await tx.put("cleanup_jobs", "000-completed-" + i, {
        status: "completed",
      });
  });
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
  await r.maintenance(
    { Type: "Timer", TriggerName: "test-only" },
    { SOURCE: "wx_trigger" },
  );
  assert.equal(
    f.store.snapshot().cleanup_jobs[f.jid].scheduler_runs,
    1,
    "60个历史完成任务不能让新任务等待翻页",
  );
  for (let i = 0; i < 7; i++)
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
          remove: async (c, id) => {
            await tx.remove(c, id);
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
test("关闭厨房的持久删除批次在删后丢回执时保留游标，重入只提交一次进度", async () => {
  const memory = createMemoryStore({
    kitchens: {
      k: { id: "k", status: "closed" },
      original: { status: "active" },
    },
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
      foreign: { kitchen_id: "original" },
    },
  });
  let loseAck = true;
  const store = {
    ...memory,
    removeClosedKitchenRows: async (table, ids) => {
      await memory.transaction(async (tx) => {
        for (const id of ids) await tx.remove(table, id);
      });
      if (loseAck) throw Error("ack lost after deletion");
    },
  };
  await assert.rejects(cleanupBatch(store, "job"), /ack lost/);
  let s = memory.snapshot();
  assert.deepEqual(Object.keys(s.dishes), ["foreign"]);
  assert.equal(s.cleanup_jobs.job.table, 14);
  assert.equal(s.cleanup_jobs.job.cursor, "");
  assert.deepEqual(s.cleanup_jobs.job.pending_delete.ids, ["d1", "d2"]);
  loseAck = false;
  await cleanupBatch(store, "job");
  s = memory.snapshot();
  assert.equal(s.cleanup_jobs.job.table, 15);
  assert.equal(s.cleanup_jobs.job.pending_delete, undefined);
  assert.equal(s.cleanup_jobs.job.removed_rows, 2);
  await cleanupBatch(store, "job");
  assert.equal(memory.snapshot().cleanup_jobs.job.removed_rows, 2);
  assert.ok(memory.snapshot().kitchens.original);
});
test("活跃厨房不能进入非事务批量删除阶段", async () => {
  const memory = createMemoryStore({
    kitchens: { k: { status: "active" } },
    cleanup_jobs: {
      job: {
        kind: "kitchen",
        kitchen_id: "k",
        dish_ids: ["d"],
        meal_ids: [],
        table: 14,
        cursor: "",
        status: "pending",
      },
    },
    dishes: { d: { kitchen_id: "k" } },
  });
  let deletes = 0;
  const store = {
    ...memory,
    removeClosedKitchenRows: async () => {
      deletes++;
    },
  };
  await assert.rejects(
    cleanupBatch(store, "job"),
    (e) => e.code === "INVALID_STATE",
  );
  assert.equal(deletes, 0);
  assert.ok(memory.snapshot().dishes.d);
  assert.equal(memory.snapshot().cleanup_jobs.job.pending_delete, undefined);
});
