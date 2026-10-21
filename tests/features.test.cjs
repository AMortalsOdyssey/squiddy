const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./helpers/fixture.cjs");
const { backup, restore } = require("../scripts/backup.cjs");
const { createService } = require("../domain/service");
test("两账号代表3个人，人数、请求份数、实际份数分开", async () => {
  const f = await setup();
  for (const [actor, people] of [
    ["alice", 2],
    ["bob", 1],
  ])
    await f.call(actor, "selection.replace", {
      meal_id: f.mid,
      people,
      items: [{ dish_id: f.dishes[0], quantity: 1 }],
      note: "",
      expected_revision: 0,
    });
  let m = await f.call("chef", "meal.read", { meal_id: f.mid });
  assert.equal(m.summary[0].people, 3);
  assert.equal(m.summary[0].requested_quantity, 2);
  assert.equal(m.chef_quote.total_known_minor, 2400);
  await f.call("chef", "meal.lock", {
    meal_id: f.mid,
    expected_revision: m.revision,
  });
  m = await f.call("chef", "meal.read", { meal_id: f.mid });
  await f.call("chef", "plan.confirm", {
    meal_id: f.mid,
    expected_revision: m.revision,
    items: [{ dish_id: f.dishes[0], quantity: 2 }],
  });
  m = await f.call("chef", "meal.read", { meal_id: f.mid });
  assert.equal(m.items[0].requested_people, 3);
  assert.equal(m.items[0].quantity, 2);
});
test("下架仅改变开放菜单可选性，锁单快照不变", async () => {
  const f = await setup();
  const old = f.store.snapshot().dishes[f.dishes[0]];
  const payload = {
    ...old,
    kitchen_id: f.kid,
    dish_id: old.id,
    expected_revision: old.revision,
    active: false,
  };
  delete payload.id;
  delete payload.revision;
  delete payload.category_name;
  await f.call("chef", "dish.save", payload);
  let m = await f.call("chef", "meal.read", { meal_id: f.mid });
  assert.equal(m.menu[0].active, false);
  await assert.rejects(
    f.call("alice", "selection.replace", {
      meal_id: f.mid,
      items: [{ dish_id: old.id, quantity: 1 }],
      expected_revision: 0,
    }),
    (e) => e.code === "INVALID_INPUT",
  );
  await f.call("chef", "meal.lock", {
    meal_id: f.mid,
    expected_revision: m.revision,
  });
  await f.call("chef", "dish.save", {
    ...payload,
    expected_revision: old.revision + 1,
    active: true,
  });
  m = await f.call("chef", "meal.read", { meal_id: f.mid });
  assert.equal(m.menu[0].active, false);
});
test("服务端读取到截止即锁需求，尚未确认制作计划", async () => {
  const f = await setup();
  f.advance(3600001);
  const m = await f.call("alice", "meal.read", { meal_id: f.mid });
  assert.equal(m.status, "locked");
  assert.equal(m.plan_confirmed, false);
});
test("误点上桌能撤销最近一步，保留原因审计且归档后禁止", async () => {
  const f = await setup();
  let m = await f.call("chef", "meal.read", { meal_id: f.mid });
  await f.call("chef", "meal.lock", {
    meal_id: f.mid,
    expected_revision: m.revision,
  });
  m = await f.call("chef", "meal.read", { meal_id: f.mid });
  await f.call("chef", "plan.confirm", {
    meal_id: f.mid,
    expected_revision: m.revision,
    items: [{ dish_id: f.dishes[0], quantity: 1 }],
  });
  for (const status of ["cooking", "served"]) {
    m = await f.call("chef", "meal.read", { meal_id: f.mid });
    await f.call("chef", "item.transition", {
      meal_id: f.mid,
      expected_revision: m.revision,
      dish_id: f.dishes[0],
      status,
    });
  }
  m = await f.call("chef", "meal.read", { meal_id: f.mid });
  assert.equal(m.status, "completed");
  await f.call("chef", "item.undo", {
    meal_id: f.mid,
    expected_revision: m.revision,
    reason: "误点了上桌",
  });
  m = await f.call("chef", "meal.read", { meal_id: f.mid });
  assert.equal(m.status, "cooking");
  assert.equal(m.items[0].status, "cooking");
  assert.equal(
    Object.values(f.store.snapshot().transition_audits)[0].reason,
    "误点了上桌",
  );
  await f.call("chef", "item.transition", {
    meal_id: f.mid,
    expected_revision: m.revision,
    dish_id: f.dishes[0],
    status: "served",
  });
  m = await f.call("chef", "meal.read", { meal_id: f.mid });
  await f.call("chef", "meal.archive", {
    meal_id: f.mid,
    expected_revision: m.revision,
  });
  m = await f.call("chef", "meal.read", { meal_id: f.mid });
  await assert.rejects(
    f.call("chef", "item.undo", {
      meal_id: f.mid,
      expected_revision: m.revision,
      reason: "过期操作",
    }),
    (e) => e.code === "INVALID_STATE",
  );
});
test("拒绝制作必须说明原因，普通成员可看到不做原因", async () => {
  const f = await setup();
  let m = await f.call("chef", "meal.read", { meal_id: f.mid });
  await f.call("chef", "meal.lock", {
    meal_id: f.mid,
    expected_revision: m.revision,
  });
  m = await f.call("chef", "meal.read", { meal_id: f.mid });
  await assert.rejects(
    f.call("chef", "plan.confirm", {
      meal_id: f.mid,
      expected_revision: m.revision,
      items: [{ dish_id: f.dishes[0], quantity: 0 }],
    }),
    (e) => e.code === "INVALID_INPUT",
  );
  await f.call("chef", "plan.confirm", {
    meal_id: f.mid,
    expected_revision: m.revision,
    items: [{ dish_id: f.dishes[0], quantity: 0, reason: "鸡蛋没有了" }],
  });
  const member = await f.call("alice", "meal.read", { meal_id: f.mid });
  assert.equal(member.items[0].reason, "鸡蛋没有了");
  assert.equal(member.served, 0);
});
test("备份校验后恢复到独立存储，源库不受恢复操作影响", async () => {
  const f = await setup();
  const envelope = backup(f.store.snapshot());
  const restored = restore(envelope);
  const service = createService({
    store: restored,
    crypto: f.crypt,
    clock: f.now,
    expectedAppId: require("./helpers/fixture.cjs").APP,
  });
  const result = await service.execute(
    "meal.read",
    { meal_id: f.mid },
    { APPID: require("./helpers/fixture.cjs").APP, OPENID: "alice" },
  );
  assert.equal(result.title, "周末晚饭");
  assert.equal(result.chef_quote, undefined);
  await restored.transaction((t) => t.remove("meals", f.mid));
  assert.ok(f.store.snapshot().meals[f.mid]);
  assert.throws(() => restore({ ...envelope, data: envelope.data + " " }));
});
test("推荐20人、时间和食材完整性过滤、充足候选返回不同组合", async () => {
  const f = await setup();
  const r = await f.call("alice", "recommend", {
    meal_id: f.mid,
    people: 20,
    avoid: ["花生"],
    max_minutes: 30,
    likes: ["番茄"],
    mild: true,
  });
  assert.ok(r.plans.length >= 2 && r.plans.length <= 3);
  for (const p of r.plans)
    for (const i of p.items) assert.equal(i.quantity, 10);
  assert.equal(
    (
      await f.call("alice", "recommend", {
        meal_id: f.mid,
        people: 4,
        avoid: [],
        max_minutes: 1,
      })
    ).plans.length,
    0,
  );
});
test("删除任务等待文件实际清理完成，不能提前报告完成", async () => {
  const f = await setup();
  const actor = f.actorId("alice");
  await f.store.transaction((t) =>
    t.put("media", "personal-image", {
      id: "personal-image",
      actor,
      kitchen_id: f.kid,
      status: "approved",
      file_id: "cloud://personal",
    }),
  );
  await f.call("alice", "account.delete");
  const { cleanupBatch } = require("../domain/maintenance");
  for (let i = 0; i < 40; i++) await cleanupBatch(f.store, actor);
  assert.notEqual(f.store.snapshot().deletion_jobs[actor].status, "completed");
  assert.ok(f.store.snapshot().file_deletions["personal-image"]);
  await f.store.transaction((t) =>
    t.remove("file_deletions", "personal-image"),
  );
  assert.equal((await cleanupBatch(f.store, actor)).status, "completed");
});
