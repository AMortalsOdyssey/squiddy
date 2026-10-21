const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./helpers/fixture.cjs");
const { lineKey } = require("../shared/selection");
async function lockPlan(f, items) {
  let m = await f.call("chef", "meal.read", { meal_id: f.mid });
  await f.call("chef", "meal.lock", {
    meal_id: f.mid,
    expected_revision: m.revision,
  });
  m = await f.call("chef", "meal.read", { meal_id: f.mid });
  await f.call("chef", "plan.confirm", {
    meal_id: f.mid,
    expected_revision: m.revision,
    items,
  });
  return f.call("chef", "meal.read", { meal_id: f.mid });
}
async function step(f, row, status) {
  const m = await f.call("chef", "meal.read", { meal_id: f.mid });
  return f.call("chef", "item.transition", {
    meal_id: f.mid,
    dish_id: row.dish_id,
    line_id: row.line_id,
    status,
    expected_revision: m.revision,
  });
}
test("同菜多规格口味分别点选、计价、锁单、上菜和撤销；兼容旧单规格", async () => {
  const f = await setup(),
    did = f.dishes[0];
  const old = f.store.snapshot().dishes[did];
  const payload = {
    ...old,
    kitchen_id: f.kid,
    dish_id: did,
    expected_revision: old.revision,
    variants: ["小份", "大份"],
    attributes: [{ name: "口味", options: ["不辣", "微辣"] }],
    variant_prices: [{ variant: "大份", unit_price_minor: 2000 }],
  };
  for (const k of ["id", "revision", "category_name"]) delete payload[k];
  await f.call("chef", "dish.save", payload);
  const published = await f.call("chef", "meal.publish", {
    kitchen_id: f.kid,
    title: "多规格验收",
    dish_ids: [did],
    scheduled_at: f.now() + 7200000,
    cutoff_at: f.now() + 3600000,
  });
  f.mid = published.id;
  const invite = await f.call("chef", "invitation.create", { meal_id: f.mid });
  for (const a of ["alice", "bob"])
    await f.call(a, "invitation.accept", { token: invite.token });
  const rows = [
    {
      dish_id: did,
      variant: "小份",
      options: [{ name: "口味", value: "不辣" }],
      quantity: 2,
    },
    {
      dish_id: did,
      variant: "大份",
      options: [{ name: "口味", value: "微辣" }],
      quantity: 1,
    },
  ];
  await f.call("alice", "selection.replace", {
    meal_id: f.mid,
    items: rows,
    people: 2,
    expected_revision: 0,
  });
  // Default variant prices are copied at publication; a menu snapshot remains stable.
  let m = await f.call("chef", "meal.read", { meal_id: f.mid });
  assert.equal(m.summary.filter((r) => r.dish_id === did).length, 2);
  assert.equal(m.chef_quote.total_known_minor, 4400);
  await f.call("chef", "price.update", {
    meal_id: f.mid,
    dish_id: did,
    line_id: lineKey(rows[1]),
    unit_price_minor: 2000,
    expected_revision: m.chef_quote.revision,
  });
  m = await f.call("chef", "meal.read", { meal_id: f.mid });
  assert.equal(m.chef_quote.total_known_minor, 4400);
  await assert.rejects(
    f.call("alice", "selection.replace", {
      meal_id: f.mid,
      expected_revision: 1,
      items: [{ ...rows[0], quantity: 20 }, rows[1]],
    }),
    (e) => e.code === "INVALID_INPUT",
  );
  await assert.rejects(
    f.call("alice", "selection.replace", {
      meal_id: f.mid,
      expected_revision: 1,
      items: [rows[0], rows[0]],
    }),
    (e) => e.code === "INVALID_INPUT",
  );
  const member = await f.call("alice", "meal.read", { meal_id: f.mid });
  assert.ok(!member.chef_prices && !member.chef_quote);
  m = await lockPlan(
    f,
    rows.map((i) => ({ ...i, line_id: lineKey(i) })),
  );
  assert.equal(m.items.length, 2);
  await assert.rejects(
    f.call("chef", "item.transition", {
      meal_id: f.mid,
      dish_id: did,
      status: "cooking",
      expected_revision: m.revision,
    }),
    (e) => e.code === "INVALID_INPUT",
  );
  await step(f, m.items[1], "cooking");
  await step(f, m.items[1], "served");
  m = await f.call("chef", "meal.read", { meal_id: f.mid });
  assert.equal(m.items[0].status, "planned");
  assert.equal(m.items[1].status, "served");
  await f.call("chef", "item.undo", {
    meal_id: f.mid,
    expected_revision: m.revision,
    reason: "误点上桌",
  });
  m = await f.call("chef", "meal.read", { meal_id: f.mid });
  assert.equal(m.items[1].status, "cooking");
  assert.equal(m.items[0].status, "planned");
});
test("规格默认价在发布时快照，厨房访客不可见；同口味顺序不产生重复组合", async () => {
  const f = await setup(),
    did = f.dishes[0],
    old = f.store.snapshot().dishes[did];
  const p = {
    ...old,
    kitchen_id: f.kid,
    dish_id: did,
    expected_revision: old.revision,
    variants: ["小份", "大份"],
    attributes: [
      { name: "口味", options: ["不辣", "微辣"] },
      { name: "葱", options: ["加葱", "无葱"] },
    ],
    variant_prices: [{ variant: "大份", unit_price_minor: 2000 }],
  };
  for (const k of ["id", "revision", "category_name"]) delete p[k];
  await f.call("chef", "dish.save", p);
  const pub = await f.call("chef", "meal.publish", {
    kitchen_id: f.kid,
    title: "规格价格",
    dish_ids: [did],
    scheduled_at: f.now() + 7200000,
    cutoff_at: f.now() + 3600000,
  });
  const row = {
    dish_id: did,
    variant: "大份",
    quantity: 2,
    options: [
      { name: "口味", value: "微辣" },
      { name: "葱", value: "无葱" },
    ],
  };
  await f.call("chef", "selection.replace", {
    meal_id: pub.id,
    items: [row],
    expected_revision: 0,
  });
  const m = await f.call("chef", "meal.read", { meal_id: pub.id });
  assert.equal(m.chef_quote.total_known_minor, 4000);
  const k = await f.call("alice", "kitchen.read", { kitchen_id: f.kid });
  assert.ok(!JSON.stringify(k).includes("unit_price_minor"));
  assert.equal(
    lineKey(row),
    lineKey({ ...row, options: row.options.slice().reverse() }),
  );
  assert.match(lineKey(row), /^[a-zA-Z0-9]{32}$/);
  await assert.rejects(
    f.call("chef", "selection.replace", {
      meal_id: pub.id,
      items: [row, { ...row, options: row.options.slice().reverse() }],
      expected_revision: 1,
    }),
    (e) => e.code === "INVALID_INPUT",
  );
});
test("购物清单取实际计划、去重保留用量和认领；并发与撤权阻止覆盖", async () => {
  const f = await setup();
  let s = await f.call("alice", "shopping.read", { meal_id: f.mid });
  assert.equal(s.revision, 0);
  assert.equal(s.can_generate, false);
  await assert.rejects(
    f.call("chef", "shopping.generate", {
      meal_id: f.mid,
      expected_revision: 0,
    }),
    (e) => e.code === "INVALID_STATE",
  );
  await lockPlan(f, [
    { dish_id: f.dishes[0], quantity: 2 },
    { dish_id: f.dishes[1], quantity: 0, reason: "这次不做" },
  ]);
  await f.call("chef", "shopping.generate", {
    meal_id: f.mid,
    expected_revision: 0,
  });
  s = await f.call("alice", "shopping.read", { meal_id: f.mid });
  assert.deepEqual(
    s.items.map((i) => i.name),
    ["番茄", "鸡蛋"],
  );
  assert.equal(s.items[0].sources[0].quantity, 2);
  const iid = s.items[0].id;
  await f.call("alice", "shopping.claim", {
    meal_id: f.mid,
    expected_revision: s.revision,
    item_id: iid,
    claimed: true,
  });
  s = await f.call("bob", "shopping.read", { meal_id: f.mid });
  await assert.rejects(
    f.call("bob", "shopping.claim", {
      meal_id: f.mid,
      expected_revision: s.revision,
      item_id: iid,
      claimed: true,
    }),
    (e) => e.code === "CONFLICT",
  );
  await f.call("chef", "shopping.update", {
    meal_id: f.mid,
    expected_revision: s.revision,
    item_id: iid,
    name: "番茄",
    amount: "4个",
    note: "选熟一点的",
  });
  s = await f.call("chef", "shopping.read", { meal_id: f.mid });
  await f.call("bob", "shopping.check", {
    meal_id: f.mid,
    expected_revision: s.revision,
    item_id: iid,
    checked: true,
  });
  await assert.rejects(
    f.call("chef", "shopping.generate", {
      meal_id: f.mid,
      expected_revision: s.revision,
    }),
    (e) => e.code === "CONFLICT",
  );
  s = await f.call("chef", "shopping.read", { meal_id: f.mid });
  await f.call("chef", "shopping.generate", {
    meal_id: f.mid,
    expected_revision: s.revision,
  });
  s = await f.call("alice", "shopping.read", { meal_id: f.mid });
  const i = s.items.find((i) => i.id === iid);
  assert.equal(i.amount, "4个");
  assert.equal(i.checked, true);
  assert.equal(i.claimed_by_me, true);
  assert.ok(!JSON.stringify(s).includes(f.actorId("alice")));
  const replay = {
    meal_id: f.mid,
    expected_revision: s.revision,
    name: "纸巾",
    amount: "1包",
    note: "",
    request_id: "shopping-alice",
  };
  await f.call("alice", "shopping.add", replay);
  await f.call("alice", "kitchen.leave", { kitchen_id: f.kid });
  await assert.rejects(
    f.call("alice", "shopping.add", replay),
    (e) => e.code === "NOT_FOUND",
  );
  s = await f.call("chef", "shopping.read", { meal_id: f.mid });
  assert.equal(s.items.find((i) => i.id === iid).claimed_name, "");
});
test("饭后反馈只评价上桌菜，本人和主厨可看；版本、审核和删除隐私有效", async () => {
  const f = await setup();
  let r = await f.call("alice", "meal.review.read", { meal_id: f.mid });
  assert.equal(r.available, false);
  const m = await lockPlan(f, [
    { dish_id: f.dishes[0], quantity: 1 },
    { dish_id: f.dishes[1], quantity: 0, reason: "不做" },
  ]);
  await step(f, m.items[0], "cooking");
  await step(f, m.items[0], "served");
  const p = {
    meal_id: f.mid,
    expected_revision: 0,
    note: "谢谢厨师",
    items: [
      {
        line_id: m.items[0].line_id,
        tags: ["下次还想吃", "淡一点"],
        note: "番茄好吃",
      },
    ],
  };
  await assert.rejects(
    f.call("alice", "meal.review.save", {
      ...p,
      items: [{ line_id: m.items[1].line_id, tags: [], note: "" }],
    }),
    (e) => e.code === "INVALID_INPUT",
  );
  await assert.rejects(
    f.call("alice", "meal.review.save", { ...p, note: "BLOCKED_TEXT" }),
    (e) => e.code === "CONTENT_REJECTED",
  );
  await f.call("alice", "meal.review.save", p);
  r = await f.call("chef", "meal.review.read", { meal_id: f.mid });
  assert.equal(r.feedback.length, 1);
  assert.equal(r.feedback[0].note, "谢谢厨师");
  r = await f.call("bob", "meal.review.read", { meal_id: f.mid });
  assert.equal(r.feedback.length, 0);
  assert.equal(r.own.note, "");
  assert.ok(!JSON.stringify(r).includes("谢谢厨师"));
  await assert.rejects(
    f.call("alice", "meal.review.save", p),
    (e) => e.code === "CONFLICT",
  );
  const ex = await f.call("alice", "export.mine");
  assert.equal(ex.kitchens[0].meals[0].own_review.note, "谢谢厨师");
  assert.ok(
    !JSON.stringify(ex.kitchens[0].meals[0].own_review).includes(
      f.actorId("alice"),
    ),
  );
  await f.call("alice", "account.delete");
  r = await f.call("chef", "meal.review.read", { meal_id: f.mid });
  assert.equal(r.feedback.length, 0);
  assert.ok(!f.store.snapshot().meals[f.mid].reviews[f.actorId("alice")]);
  assert.ok(
    Object.values(f.store.snapshot().meals[f.mid].reviews).every(
      (r) => r.actor !== f.actorId("alice"),
    ),
  );
});
test("组合标识使用稳定短摘要，中文、表情与长文本与原生SHA256一致", () => {
  const { sha256 } = require("../shared/hash"),
    crypto = require("node:crypto");
  for (const text of ["", "abc", "番茄炒蛋🍳", "规格小份".repeat(300)])
    assert.equal(
      sha256(text),
      crypto.createHash("sha256").update(text).digest("hex"),
    );
  const row = {
    dish_id: "a".repeat(128),
    variant: "大".repeat(20),
    options: Array.from({ length: 5 }, (_, i) => ({
      name: "口味" + i,
      value: "辣".repeat(20),
    })),
  };
  assert.equal(lineKey(row).length, 32);
  assert.equal(
    lineKey(row),
    lineKey({ ...row, options: row.options.slice().reverse() }),
  );
});
test("制作计划重开会提示采购清单过时，更新后保留手填采购信息", async () => {
  const f = await setup();
  let m = await lockPlan(f, [{ dish_id: f.dishes[0], quantity: 1 }]);
  await f.call("chef", "shopping.generate", {
    meal_id: f.mid,
    expected_revision: 0,
  });
  let s = await f.call("chef", "shopping.read", { meal_id: f.mid });
  const i = s.items[0];
  await f.call("chef", "shopping.update", {
    meal_id: f.mid,
    expected_revision: s.revision,
    item_id: i.id,
    name: i.name,
    amount: "4个",
    note: "买熟一点的",
  });
  await f.call("chef", "meal.unlock", {
    meal_id: f.mid,
    expected_revision: m.revision,
    cutoff_at: f.now() + 3600000,
  });
  s = await f.call("chef", "shopping.read", { meal_id: f.mid });
  assert.equal(s.stale, true);
  assert.equal(s.can_generate, false);
  m = await lockPlan(f, [{ dish_id: f.dishes[0], quantity: 2 }]);
  await f.call("chef", "shopping.generate", {
    meal_id: f.mid,
    expected_revision: s.revision,
  });
  s = await f.call("chef", "shopping.read", { meal_id: f.mid });
  assert.equal(s.stale, false);
  assert.equal(s.items[0].amount, "4个");
  assert.equal(s.items[0].sources[0].quantity, 2);
  assert.equal(s.lines[0].quantity, 2);
  assert.ok(
    !("name" in f.store.snapshot().meals[f.mid].shopping.items[0].sources[0]),
  );
});
test("主厨逐页读取朋友反馈，普通成员不能借页码查看他人留言", async () => {
  const f = await setup();
  for (let n = 0; n < 6; n++)
    await f.call("guest" + n, "invitation.accept", {
      token: f.invitation.token,
    });
  const m = await lockPlan(f, [{ dish_id: f.dishes[0], quantity: 1 }]);
  await step(f, m.items[0], "cooking");
  await step(f, m.items[0], "served");
  for (const [n, a] of [
    "alice",
    "bob",
    ...Array.from({ length: 6 }, (_, i) => "guest" + i),
  ].entries())
    await f.call(a, "meal.review.save", {
      meal_id: f.mid,
      expected_revision: 0,
      note: "朋友反馈" + n,
      items: [{ line_id: m.items[0].line_id, tags: ["刚刚好"], note: "" }],
    });
  const first = await f.call("chef", "meal.review.read", { meal_id: f.mid });
  assert.equal(first.feedback_total, 8);
  assert.equal(first.feedback.length, 5);
  const next = await f.call("chef", "meal.review.read", {
    meal_id: f.mid,
    feedback_offset: 5,
  });
  assert.equal(next.feedback.length, 3);
  assert.equal(
    new Set([...first.feedback, ...next.feedback].map((x) => x.note)).size,
    8,
  );
  assert.ok(!("name" in first.feedback[0].items[0]));
  const own = await f.call("alice", "meal.review.read", {
    meal_id: f.mid,
    feedback_offset: 5,
  });
  assert.equal(own.feedback_total, 0);
  assert.equal(own.feedback.length, 0);
  assert.equal(own.own.note, "朋友反馈0");
  await assert.rejects(
    f.call("chef", "meal.review.read", { meal_id: f.mid, feedback_offset: 31 }),
    (e) => e.code === "INVALID_INPUT",
  );
});
