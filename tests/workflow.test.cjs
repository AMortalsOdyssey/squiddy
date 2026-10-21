const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, fixture, APP } = require("./helpers/fixture.cjs");
const {
  publicRead,
  applyMediaResult,
  cleanupBatch,
  processNotification,
} = require("../domain/maintenance");
const forbidden =
  /price|quote|subtotal|total_known|unpriced|openid|token_hash/i;
function noPrivateKeys(value) {
  for (const [key, val] of Object.entries(value || {})) {
    assert.equal(forbidden.test(key), false, "private key: " + key);
    if (val && typeof val === "object") noPrivateKeys(val);
  }
}
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code);

test("三人完整闭环：点菜汇总3人，厨师定2份，上桌后成员无价格", async () => {
  const f = await setup();
  for (const a of ["chef", "alice", "bob"])
    await f.call(a, "selection.replace", {
      meal_id: f.mid,
      items: [{ dish_id: f.dishes[0], quantity: 1 }],
      note: a + "备注",
      expected_revision: 0,
    });
  let chef = await f.call("chef", "meal.read", { meal_id: f.mid });
  assert.equal(chef.summary[0].people, 3);
  assert.equal(chef.chef_quote.total_known_minor, 3600);
  let guest = await f.call("alice", "meal.read", { meal_id: f.mid });
  noPrivateKeys(guest);
  assert.equal(guest.selection.note, "alice备注");
  assert.equal(JSON.stringify(guest).includes("bob备注"), false);
  await f.call("chef", "meal.lock", {
    meal_id: f.mid,
    expected_revision: chef.revision,
  });
  chef = await f.call("chef", "meal.read", { meal_id: f.mid });
  await f.call("chef", "plan.confirm", {
    meal_id: f.mid,
    expected_revision: chef.revision,
    items: [{ dish_id: f.dishes[0], quantity: 2 }],
  });
  chef = await f.call("chef", "meal.read", { meal_id: f.mid });
  assert.equal(chef.chef_quote.total_known_minor, 2400);
  await f.call("chef", "item.transition", {
    meal_id: f.mid,
    dish_id: f.dishes[0],
    status: "cooking",
    expected_revision: chef.revision,
  });
  chef = await f.call("chef", "meal.read", { meal_id: f.mid });
  await f.call("chef", "item.transition", {
    meal_id: f.mid,
    dish_id: f.dishes[0],
    status: "served",
    expected_revision: chef.revision,
  });
  guest = await f.call("alice", "meal.read", { meal_id: f.mid });
  assert.equal(guest.status, "completed");
  assert.equal(guest.items[0].quantity, 2);
  noPrivateKeys(guest);
});
test("并发点菜互不覆盖，重复请求5次只保存一个版本", async () => {
  const f = await setup();
  const payload = {
    request_id: "retry-key",
    meal_id: f.mid,
    items: [{ dish_id: f.dishes[0], quantity: 2 }],
    note: "",
    expected_revision: 0,
  };
  await Promise.all([
    ...Array.from({ length: 5 }, () =>
      f.call("alice", "selection.replace", payload),
    ),
    f.call("bob", "selection.replace", { ...payload, request_id: "bob-key" }),
  ]);
  const view = await f.call("chef", "meal.read", { meal_id: f.mid });
  assert.equal(view.summary[0].people, 2);
  assert.equal(view.summary[0].requested_quantity, 4);
  assert.equal(
    (await f.call("alice", "meal.read", { meal_id: f.mid })).selection.revision,
    1,
  );
});
test("幂等键复用不同内容拒绝，不静默接受", async () => {
  const f = await setup();
  const p = {
    request_id: "same",
    meal_id: f.mid,
    items: [],
    note: "a",
    expected_revision: 0,
  };
  await f.call("alice", "selection.replace", p);
  await rejects(
    f.call("alice", "selection.replace", { ...p, note: "b" }),
    "IDEMPOTENCY_CONFLICT",
  );
});
test("锁单与并发提交串行化，锁单之后提交拒绝", async () => {
  const f = await setup();
  const m = await f.call("chef", "meal.read", { meal_id: f.mid });
  await f.call("chef", "meal.lock", {
    meal_id: f.mid,
    expected_revision: m.revision,
  });
  await rejects(
    f.call("alice", "selection.replace", {
      meal_id: f.mid,
      items: [],
      note: "",
      expected_revision: 0,
    }),
    "CLOSED",
  );
});
test("服务端截止，不信客户端时钟；空草稿也不能越过截止", async () => {
  const f = await setup();
  f.advance(3600001);
  await rejects(
    f.call("alice", "selection.replace", {
      meal_id: f.mid,
      items: [],
      note: "",
      expected_revision: 0,
    }),
    "CLOSED",
  );
});
test("同一成员旧版本提交冲突，保留第一次备注", async () => {
  const f = await setup();
  const p = { meal_id: f.mid, items: [], note: "first", expected_revision: 0 };
  await f.call("alice", "selection.replace", p);
  await rejects(
    f.call("alice", "selection.replace", { ...p, note: "second" }),
    "CONFLICT",
  );
  assert.equal(
    (await f.call("alice", "meal.read", { meal_id: f.mid })).selection.note,
    "first",
  );
});
test("用户伪造价格/角色字段拒绝，返回无真实价", async () => {
  const f = await setup();
  await rejects(
    f.call("alice", "selection.replace", {
      meal_id: f.mid,
      items: [],
      note: "",
      expected_revision: 0,
      price: 100,
    }),
    "INVALID_INPUT",
  );
  await rejects(
    f.call("alice", "price.update", {
      meal_id: f.mid,
      dish_id: f.dishes[0],
      unit_price_minor: 1,
      expected_revision: 1,
      role: "cook",
    }),
    "FORBIDDEN",
  );
});
test("跨厨房ID及未受邀账号不能读饭局", async () => {
  const f = await setup();
  await rejects(
    f.call("mallory", "meal.read", { meal_id: f.mid }),
    "NOT_FOUND",
  );
  const own = await f.call("mallory", "kitchen.create", { name: "别人的厨房" });
  await rejects(
    f.call("mallory", "dish.save", {
      kitchen_id: own.id,
      dish_id: f.dishes[0],
      expected_revision: 1,
    }),
    "NOT_FOUND",
  );
});
test("厨师改价不影响朋友选择版本，也不回写菜谱默认价", async () => {
  const f = await setup();
  await f.call("chef", "price.update", {
    meal_id: f.mid,
    dish_id: f.dishes[0],
    unit_price_minor: 0,
    expected_revision: 1,
  });
  await f.call("alice", "selection.replace", {
    meal_id: f.mid,
    items: [{ dish_id: f.dishes[0], quantity: 1 }],
    note: "",
    expected_revision: 0,
  });
  const m = await f.call("chef", "meal.read", { meal_id: f.mid });
  assert.equal(m.chef_quote.total_known_minor, 0);
  assert.equal(m.chef_quote.unpriced_count, 0);
  assert.equal(
    (await f.call("chef", "kitchen.read", { kitchen_id: f.kid })).dishes[0]
      .default_price_minor,
    1200,
  );
});
test("接单交接后旧厨师立即无价格，旧改价请求重放也拒绝", async () => {
  const f = await setup();
  const p = {
    request_id: "price-old",
    meal_id: f.mid,
    dish_id: f.dishes[0],
    unit_price_minor: 500,
    expected_revision: 1,
  };
  await f.call("chef", "price.update", p);
  let m = await f.call("chef", "meal.read", { meal_id: f.mid });
  await f.call("chef", "meal.assignCook", {
    meal_id: f.mid,
    member_id: f.actorId("alice"),
    expected_revision: m.revision,
  });
  noPrivateKeys(await f.call("chef", "meal.read", { meal_id: f.mid }));
  assert.ok(
    (await f.call("alice", "meal.read", { meal_id: f.mid })).chef_quote,
  );
  await rejects(f.call("chef", "price.update", p), "FORBIDDEN");
});
test("转让给非厨师的新主人没有菜谱默认价或本餐价", async () => {
  const f = await setup();
  const k = await f.call("chef", "kitchen.read", { kitchen_id: f.kid });
  await f.call("chef", "member.role", {
    kitchen_id: f.kid,
    member_id: f.actorId("bob"),
    role: "owner",
    expected_revision: k.revision,
  });
  const b = await f.call("bob", "kitchen.read", { kitchen_id: f.kid });
  assert.equal(b.role, "owner");
  for (const d of b.dishes) noPrivateKeys(d);
  noPrivateKeys(await f.call("bob", "meal.read", { meal_id: f.mid }));
});
test("邀请重复加入不重复计数，库里不存明文令牌", async () => {
  const f = await setup();
  await f.call("alice", "invitation.accept", { token: f.invitation.token });
  assert.equal(
    (await f.call("chef", "meal.read", { meal_id: f.mid })).participant_count,
    3,
  );
  assert.equal(
    JSON.stringify(f.store.snapshot()).includes(f.invitation.token),
    false,
  );
});
test("邀请撤销和过期后拒绝；已撤销成员不能用旧邀请恢复", async () => {
  const f = await setup();
  await f.call("chef", "member.remove", {
    kitchen_id: f.kid,
    member_id: f.actorId("bob"),
  });
  await rejects(
    f.call("bob", "invitation.accept", { token: f.invitation.token }),
    "FORBIDDEN",
  );
  await rejects(f.call("bob", "meal.read", { meal_id: f.mid }), "NOT_FOUND");
  await f.call("chef", "invitation.revoke", { invitation_id: f.invitation.id });
  await rejects(
    f.call("eve", "invitation.accept", { token: f.invitation.token }),
    "INVITATION_EXPIRED",
  );
});
test("菜谱改名保留发布时名称，下架改变开放菜单可选性", async () => {
  const f = await setup();
  const k = await f.call("chef", "kitchen.read", { kitchen_id: f.kid });
  const d = k.dishes[0];
  await f.call("chef", "dish.save", {
    kitchen_id: f.kid,
    dish_id: d.id,
    expected_revision: d.revision,
    name: d.name,
    category: d.category,
    ingredients: d.ingredients,
    allergens: d.allergens,
    steps: d.steps,
    minutes: d.minutes,
    vegetarian: d.vegetarian,
    spicy: d.spicy,
    active: false,
    default_price_minor: 1200,
  });
  const m = await f.call("alice", "meal.read", { meal_id: f.mid });
  assert.equal(m.menu[0].active, false);
});
test("全部明确不做显示未开餐，不制造上桌记录", async () => {
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
    items: [{ dish_id: f.dishes[0], quantity: 0, reason: "临时缺货" }],
  });
  m = await f.call("alice", "meal.read", { meal_id: f.mid });
  assert.equal(m.status, "completed");
  assert.equal(m.served, 0);
});
test("推荐严守忌口且不含价格，不能凑忌口菜", async () => {
  const f = await setup();
  const r = await f.call("alice", "recommend", {
    meal_id: f.mid,
    people: 4,
    avoid: ["鸡蛋", "面粉"],
    vegetarian: true,
    mild: true,
  });
  noPrivateKeys(r);
  for (const p of r.plans)
    for (const i of p.items)
      assert.equal([f.dishes[0], f.dishes[3]].includes(i.dish_id), false);
  assert.equal(
    (
      await f.call("alice", "recommend", {
        meal_id: f.mid,
        people: 4,
        avoid: ["番茄", "猪肉", "莲藕", "面粉", "黄瓜"],
      })
    ).plans.length,
    0,
  );
});
test("公开分享与邀请权限分离，匿名投影无时间身份价格且可撤销", async () => {
  const f = await setup();
  const share = await f.call("chef", "share.create", { meal_id: f.mid });
  const view = await publicRead(f.store, share.id, f.now());
  noPrivateKeys(view);
  assert.deepEqual(Object.keys(view).sort(), ["dishes", "title"]);
  await f.call("chef", "share.revoke", { share_id: share.id });
  await rejects(publicRead(f.store, share.id, f.now()), "NOT_FOUND");
});
test("文本审核失败不写数据", async () => {
  const f = fixture();
  await rejects(
    f.call("chef", "kitchen.create", { name: "BLOCKED_TEXT" }),
    "CONTENT_REJECTED",
  );
  assert.deepEqual(f.store.snapshot(), {});
});
test("图片回调只有匹配待审核任务才生效，旧回调不能覆盖", async () => {
  const f = fixture();
  await f.store.transaction(async (t) => {
    await t.put("media", "img", {
      id: "img",
      status: "pending",
      trace_id: "trace",
    });
    await t.put("media_traces", "trace", { media_id: "img" });
  });
  const e = {
    appid: APP,
    Event: "wxa_media_check",
    MsgType: "event",
    trace_id: "trace",
    errcode: 0,
    result: { suggest: "pass" },
  };
  assert.equal((await applyMediaResult(f.store, e, APP)).status, "approved");
  assert.equal(
    (
      await applyMediaResult(
        f.store,
        { ...e, result: { suggest: "risky" } },
        APP,
      )
    ).ignored,
    true,
  );
  await rejects(
    applyMediaResult(f.store, { ...e, appid: "evil" }, APP),
    "FORBIDDEN",
  );
});
test("注销即时禁止访问，分批清理实际删除个人资料与选择", async () => {
  const f = await setup();
  await f.call("alice", "selection.replace", {
    meal_id: f.mid,
    items: [],
    note: "private-note",
    expected_revision: 0,
  });
  await f.call("alice", "account.delete");
  await rejects(f.call("alice", "profile.get"), "ACCOUNT_DELETED");
  const actor = f.actorId("alice");
  for (let i = 0; i < 100; i++) {
    const r = await cleanupBatch(f.store, actor);
    if (r.status === "completed") break;
  }
  const state = f.store.snapshot();
  assert.equal(state.deletion_jobs[actor].status, "completed");
  assert.equal(JSON.stringify(state).includes("private-note"), false);
  assert.deepEqual(state.users[actor], { id: actor, status: "deleted" });
});
test("主人未转让不能注销，不能默默删除其他人的厨房", async () => {
  const f = await setup();
  await rejects(f.call("chef", "account.delete"), "OWNER_TRANSFER_REQUIRED");
});
test("未知通知发送结果不自动重试", async () => {
  const f = fixture();
  await f.store.transaction(async (t) => {
    await t.put("users", "a", { status: "active", openid: "a" });
    await t.put("meals", "m", { status: "completed", participant_ids: ["a"] });
    await t.put("notification_preferences", "n", { accepted: true });
    await t.put("notification_jobs", "n", {
      actor: "a",
      meal_id: "m",
      status: "pending",
    });
  });
  let sends = 0;
  const adapter = {
    template: { id: "template" },
    send: async () => {
      sends++;
      throw Error("timeout");
    },
  };
  assert.equal(
    (await processNotification(f.store, "n", adapter)).status,
    "unknown",
  );
  await processNotification(f.store, "n", adapter);
  assert.equal(sends, 1);
});
test("云身份必须来自本应用，伪造OPENID参数无效", async () => {
  const f = fixture();
  await rejects(
    f.service.execute("profile.get", {}, { OPENID: "a", APPID: "other" }),
    "UNAUTHORIZED",
  );
  await rejects(
    f.service.execute("profile.get", { OPENID: "a" }, { APPID: APP }),
    "UNAUTHORIZED",
  );
});

test("统一撤销使换页前和旧格式邀请全部失效，重试撤销不影响后来新生成的邀请", async () => {
  const f = await setup();
  const second = await f.call("chef", "invitation.create", { meal_id: f.mid });
  await f.store.transaction(async (tx) => {
    for (const row of await tx.scan("invitations")) {
      delete row.data.epoch;
      await tx.put("invitations", row.id, row.data);
    }
  });
  await rejects(
    f.call("alice", "invitation.revokeAll", { meal_id: f.mid }),
    "FORBIDDEN",
  );
  const payload = { meal_id: f.mid, request_id: "revoke-all-invites" };
  await f.call("chef", "invitation.revokeAll", payload);
  for (const token of [f.invitation.token, second.token])
    await rejects(
      f.call("eve", "invitation.resolve", { token }),
      "INVITATION_EXPIRED",
    );
  const fresh = await f.call("chef", "invitation.create", { meal_id: f.mid });
  await f.call("chef", "invitation.revokeAll", payload);
  await f.call("eve", "invitation.accept", { token: fresh.token });
  assert.equal(
    (await f.call("chef", "meal.read", { meal_id: f.mid })).participant_count,
    4,
  );
});
test("统一撤销覆盖所有旧公开摘要，重新生成与匿名读取仍正常且无私有字段", async () => {
  const f = await setup();
  const shares = [];
  for (let i = 0; i < 2; i++)
    shares.push(await f.call("chef", "share.create", { meal_id: f.mid }));
  await f.store.transaction(async (tx) => {
    for (const row of await tx.scan("public_shares")) {
      delete row.data.epoch;
      await tx.put("public_shares", row.id, row.data);
    }
  });
  await rejects(
    f.call("alice", "share.revokeAll", { meal_id: f.mid }),
    "FORBIDDEN",
  );
  const payload = { meal_id: f.mid, request_id: "revoke-all-shares" };
  await f.call("chef", "share.revokeAll", payload);
  for (const s of shares) {
    await rejects(publicRead(f.store, s.id, f.now()), "NOT_FOUND");
    await rejects(
      f.call("chef", "share.ownerRead", { share_id: s.id }),
      "NOT_FOUND",
    );
  }
  const fresh = await f.call("chef", "share.create", { meal_id: f.mid });
  await f.call("chef", "share.revokeAll", payload);
  const view = await publicRead(f.store, fresh.id, f.now());
  noPrivateKeys(view);
  assert.deepEqual(Object.keys(view).sort(), ["dishes", "title"]);
});
