const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./helpers/fixture.cjs");
const { cleanupBatch } = require("../domain/maintenance");
const { referencedByKitchen } = require("../domain/media");

test("上传者注销保留厨房封面、菜谱与历史步骤图片，匿名化归属，无引用图片才删除", async () => {
  const f = await setup();
  const actor = f.actorId("alice");
  let k = f.store.snapshot().kitchens[f.kid];
  await f.call("chef", "member.role", {
    kitchen_id: f.kid,
    member_id: actor,
    role: "cook",
    expected_revision: k.revision,
  });
  const images = [];
  for (let i = 0; i < 5; i++) {
    const image = await f.call("alice", "media.prepare", { kitchen_id: f.kid });
    await f.call("alice", "media.complete", {
      media_id: image.id,
      base64: "aA==",
    });
    images.push(image.id);
  }
  await f.store.transaction(async (tx) => {
    for (const imageId of images) {
      const media = await tx.get("media", imageId);
      delete media.references_version;
      await tx.put("media", imageId, media);
    }
    const kitchen = await tx.get("kitchens", f.kid);
    kitchen.image_id = images[0];
    await tx.put("kitchens", f.kid, kitchen);
    const d = await tx.get("dishes", f.dishes[0]);
    d.image_id = images[1];
    d.recipe_steps = [{ text: "一步", image_id: images[2] }];
    await tx.put("dishes", d.id, d);
    const m = await tx.get("meals", f.mid);
    m.menu[0].recipe_steps = [{ text: "历史", image_id: images[3] }];
    await tx.put("meals", m.id, m);
  });
  await f.call("alice", "account.delete");
  for (let i = 0; i < 120; i++) await cleanupBatch(f.store, actor);
  const s = f.store.snapshot();
  for (const imageId of images.slice(0, 4)) {
    assert.equal(s.media[imageId].actor, undefined);
    assert.equal(s.media[imageId].owner_scope, "kitchen");
    assert.equal(s.file_deletions[imageId], undefined);
    assert.equal(
      (await f.call("chef", "media.read", { media_id: imageId })).status,
      "approved",
    );
  }
  assert.equal(s.media[images[4]], undefined);
  assert.ok(s.file_deletions[images[4]]);
  await f.store.transaction(async (tx) => {
    const k = await tx.get("kitchens", f.kid);
    k.image_id = "";
    await tx.put("kitchens", k.id, k);
    assert.equal(await referencedByKitchen(tx, images[0], k), false);
  });
});

test("归档超过40场后继续发布，历史分页无遗漏，新增历史时游标不跳记录", async () => {
  const f = await setup();
  for (let i = 0; i < 45; i++) {
    let mid;
    if (i === 0) mid = f.mid;
    else
      mid = (
        await f.call("chef", "meal.publish", {
          kitchen_id: f.kid,
          title: "第" + i + "餐",
          dish_ids: [f.dishes[0]],
          scheduled_at: f.now() + 7200000,
          cutoff_at: f.now() + 3600000,
        })
      ).id;
    let m = await f.call("chef", "meal.read", { meal_id: mid });
    await f.call("chef", "meal.cancel", {
      meal_id: mid,
      expected_revision: m.revision,
    });
    m = await f.call("chef", "meal.read", { meal_id: mid });
    await f.call("chef", "meal.archive", {
      meal_id: mid,
      expected_revision: m.revision,
    });
  }
  assert.equal(f.store.snapshot().kitchens[f.kid].active_meal_ids.length, 0);
  let cursor = "",
    all = [];
  do {
    const p = await f.call("chef", "history.read", {
      kitchen_id: f.kid,
      cursor,
    });
    all.push(...p.items);
    cursor = p.next_cursor;
  } while (cursor);
  assert.equal(all.length, 45);
  assert.equal(new Set(all.map((x) => x.id)).size, 45);
  assert.ok(
    (await f.call("chef", "kitchen.read", { kitchen_id: f.kid })).meals
      .length <= 20,
  );
  const first = await f.call("chef", "history.read", { kitchen_id: f.kid });
  await f.call("chef", "meal.publish", {
    kitchen_id: f.kid,
    title: "新餐",
    dish_ids: [f.dishes[0]],
    scheduled_at: f.now() + 7200000,
    cutoff_at: f.now() + 3600000,
  });
  const second = await f.call("chef", "history.read", {
    kitchen_id: f.kid,
    cursor: first.next_cursor,
  });
  assert.ok(second.items.every((m) => !first.items.some((x) => x.id === m.id)));
});

test("同时40场的限制仍有效，结束一场释放额度，不能跨厨房读取历史或备份", async () => {
  const f = await setup();
  for (let i = 1; i < 40; i++)
    await f.call("chef", "meal.publish", {
      kitchen_id: f.kid,
      title: "餐" + i,
      dish_ids: [f.dishes[0]],
      scheduled_at: f.now() + 7200000,
      cutoff_at: f.now() + 3600000,
    });
  await assert.rejects(
    f.call("chef", "meal.publish", {
      kitchen_id: f.kid,
      title: "超额",
      dish_ids: [f.dishes[0]],
      scheduled_at: f.now() + 7200000,
      cutoff_at: f.now() + 3600000,
    }),
    (e) => e.code === "INVALID_INPUT",
  );
  const m = await f.call("chef", "meal.read", { meal_id: f.mid });
  await f.call("chef", "meal.cancel", {
    meal_id: f.mid,
    expected_revision: m.revision,
  });
  await f.call("chef", "meal.publish", {
    kitchen_id: f.kid,
    title: "新一餐",
    dish_ids: [f.dishes[0]],
    scheduled_at: f.now() + 7200000,
    cutoff_at: f.now() + 3600000,
  });
  for (const action of ["history.read", "backup.read"])
    await assert.rejects(
      f.call("stranger", action, { kitchen_id: f.kid }),
      (e) => e.code === "NOT_FOUND",
    );
});

test("备份导出包含完整菜谱与可访问历史，普通成员不获得内部价或他人备注", async () => {
  const f = await setup();
  const chef = await f.call("chef", "backup.read", {
    kitchen_id: f.kid,
    section: "dishes",
  });
  const friend = await f.call("alice", "backup.read", {
    kitchen_id: f.kid,
    section: "dishes",
  });
  assert.equal(chef.items.length, 5);
  assert.equal(chef.items[0].default_price_minor, 1200);
  assert.ok(
    friend.items.every(
      (d) => !("default_price_minor" in d) && !("default_variant_prices" in d),
    ),
  );
  const history = await f.call("alice", "backup.read", {
    kitchen_id: f.kid,
    section: "meals",
  });
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].chef_quote, undefined);
});

test("恢复只能新建厨房且不覆盖旧菜谱，跨文件续传按来源幂等", async () => {
  const f = await setup();
  const group = "a".repeat(24);
  const k = await f.call("chef", "backup.restoreKitchen", {
    name: "恢复的新厨房",
    backup_group: group,
  });
  assert.notEqual(k.id, f.kid);
  const again = await f.call("chef", "backup.restoreKitchen", {
    name: "恢复的新厨房",
    backup_group: group,
  });
  assert.equal(again.id, k.id);
  const d = (
    await f.call("chef", "backup.read", {
      kitchen_id: f.kid,
      section: "dishes",
    })
  ).items[0];
  const p = {
    kitchen_id: k.id,
    backup_group: group,
    source_id: d.id,
    name: d.name,
    category: d.category,
    ingredients: d.ingredients,
    allergens: d.allergens,
    steps: d.steps,
    minutes: d.minutes,
    default_serves: d.default_serves,
  };
  const imported = await f.call("chef", "backup.restoreDish", p);
  const replay = await f.call("chef", "backup.restoreDish", p);
  assert.equal(imported.id, replay.id);
  assert.equal(f.store.snapshot().kitchens[k.id].dish_ids.length, 1);
  assert.equal(f.store.snapshot().kitchens[f.kid].dish_ids.length, 5);
  await assert.rejects(
    f.call("chef", "backup.restoreDish", { ...p, kitchen_id: f.kid }),
    (e) => e.code === "FORBIDDEN",
  );
});

test("反馈收件可查询自己的处理状态与回复，不能读取别人的编号", async () => {
  const f = await setup();
  const r = await f.call("alice", "feedback.submit", { message: "需要帮助" });
  assert.equal(
    (await f.call("alice", "feedback.read")).items[0].status,
    "received",
  );
  await f.store.transaction(async (tx) => {
    const v = await tx.get("feedback", r.id);
    v.reply = "已处理";
    v.status = "resolved";
    await tx.put("feedback", r.id, v);
  });
  assert.equal(
    (await f.call("alice", "feedback.read", { feedback_id: r.id })).items[0]
      .reply,
    "已处理",
  );
  assert.equal(
    (await f.call("bob", "feedback.read", { feedback_id: r.id })).items.length,
    0,
  );
});

test("退出后加入新饭局不会复活旧餐权限，旧清理任务不会删新图片或新选择", async () => {
  const f = await setup(),
    alice = f.actorId("alice");
  await f.call("alice", "selection.replace", {
    meal_id: f.mid,
    expected_revision: 0,
    items: [{ dish_id: f.dishes[0], quantity: 1 }],
    note: "old-private",
  });
  await f.call("alice", "kitchen.leave", { kitchen_id: f.kid });
  const jobId = Object.entries(f.store.snapshot().cleanup_jobs).find(
    ([, j]) => j.kind === "member",
  )[0];
  const second = (
    await f.call("chef", "meal.publish", {
      kitchen_id: f.kid,
      title: "重新相聚",
      dish_ids: [f.dishes[0]],
      scheduled_at: f.now() + 7200000,
      cutoff_at: f.now() + 3600000,
    })
  ).id;
  const invite = await f.call("chef", "invitation.create", { meal_id: second });
  await f.call("alice", "invitation.accept", { token: invite.token });
  await assert.rejects(
    f.call("alice", "meal.read", { meal_id: f.mid }),
    (e) => e.code === "NOT_FOUND",
  );
  assert.ok(
    !JSON.stringify(
      await f.call("chef", "meal.read", { meal_id: f.mid }),
    ).includes("old-private"),
  );
  await f.call("alice", "selection.replace", {
    meal_id: second,
    expected_revision: 0,
    items: [{ dish_id: f.dishes[0], quantity: 1 }],
    note: "new-private",
  });
  const k = await f.call("chef", "kitchen.read", { kitchen_id: f.kid });
  await f.call("chef", "member.role", {
    kitchen_id: f.kid,
    member_id: alice,
    role: "cook",
    expected_revision: k.revision,
  });
  const image = await f.call("alice", "media.prepare", { kitchen_id: f.kid });
  await f.call("alice", "media.complete", {
    media_id: image.id,
    base64: "aA==",
  });
  for (let i = 0; i < 120; i++) {
    const r = await cleanupBatch(f.store, jobId, { hash: f.crypt.hash });
    if (r.status === "completed") break;
  }
  const m = await f.call("alice", "meal.read", { meal_id: second });
  assert.equal(m.selection.note, "new-private");
  assert.equal(f.store.snapshot().media[image.id].actor, alice);
  assert.equal(f.store.snapshot().cleanup_jobs[jobId].status, "completed");
});

test("注销请求不随历史数量线性写入，立即隐藏私有内容，后台完成物理删除", async () => {
  const f = await setup(),
    actor = f.actorId("alice");
  await f.call("alice", "selection.replace", {
    meal_id: f.mid,
    expected_revision: 0,
    items: [{ dish_id: f.dishes[0], quantity: 1 }],
    note: "private-before-delete",
  });
  await f.store.transaction(async (tx) => {
    const kitchen = await tx.get("kitchens", f.kid),
      original = await tx.get("meals", f.mid);
    for (let i = 0; i < 100; i++) {
      const mid = "history" + String(i).padStart(17, "0"),
        m = { ...structuredClone(original), id: mid, status: "archived" };
      kitchen.meal_ids.push(mid);
      await tx.put("meals", mid, m);
      await tx.put(
        "meal_memberships",
        f.crypt.hash("participant:" + mid + ":" + actor),
        { meal_id: mid, user_id: actor, status: "active", role: "member" },
      );
      await tx.put("selections", f.crypt.hash(mid + ":" + actor), {
        meal_id: mid,
        user_id: actor,
        note: "private-history",
        items: [],
        revision: 1,
      });
    }
    await tx.put("kitchens", f.kid, kitchen);
  });
  const transact = f.store.transaction.bind(f.store);
  let writes = 0;
  f.store.transaction = (fn) =>
    transact((tx) =>
      fn({
        ...tx,
        put: async (...args) => {
          writes++;
          return tx.put(...args);
        },
      }),
    );
  await f.call("alice", "account.delete");
  assert.ok(writes < 20, "must not write every historical meal in the request");
  assert.equal(
    (await f.call("alice", "account.deletionStatus")).status,
    "pending",
  );
  assert.ok(
    !JSON.stringify(
      await f.call("chef", "meal.read", { meal_id: f.mid }),
    ).includes("private-before-delete"),
  );
  for (let i = 0; i < 300; i++) {
    const r = await cleanupBatch(f.store, actor);
    if (r.status === "completed") break;
  }
  assert.equal(f.store.snapshot().deletion_jobs[actor].status, "completed");
  assert.ok(!JSON.stringify(f.store.snapshot()).includes("private-history"));
});

test("新图片的引用索引随封面绑定和移除更新，保留判断不扫描全部历史", async () => {
  const f = await setup();
  const image = await f.call("chef", "media.prepare", { kitchen_id: f.kid });
  await f.call("chef", "media.complete", {
    media_id: image.id,
    base64: "aA==",
  });
  let k = await f.call("chef", "kitchen.read", { kitchen_id: f.kid });
  await f.call("chef", "kitchen.update", {
    kitchen_id: k.id,
    expected_revision: k.revision,
    name: k.name,
    description: k.description,
    image_id: image.id,
  });
  await f.store.transaction(async (tx) => {
    const photo = await tx.get("media", image.id),
      k = await tx.get("kitchens", f.kid);
    assert.equal(
      await referencedByKitchen(
        {
          ...tx,
          getMany: () => {
            throw Error("unexpected history scan");
          },
        },
        image.id,
        k,
        photo,
      ),
      true,
    );
  });
  k = await f.call("chef", "kitchen.read", { kitchen_id: f.kid });
  await f.call("chef", "kitchen.update", {
    kitchen_id: k.id,
    expected_revision: k.revision,
    name: k.name,
    description: k.description,
    image_id: "",
  });
  assert.equal(
    Object.keys(f.store.snapshot().media[image.id].references).length,
    0,
  );
});
