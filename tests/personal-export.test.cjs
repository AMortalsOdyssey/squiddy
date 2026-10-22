const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { setup } = require("./helpers/fixture.cjs");

test("JSON导出45场历史每次只读一场，普通成员不获得内部价", async () => {
  const f = await setup(),
    actor = f.actorId("alice");
  await f.store.transaction(async (tx) => {
    const k = await tx.get("kitchens", f.kid),
      m = await tx.get("meals", f.mid);
    for (let i = 0; i < 44; i++) {
      const mid = "export-history-" + i;
      await tx.put("meals", mid, { ...m, id: mid, status: "archived" });
      await tx.put(
        "meal_memberships",
        f.crypt.hash("participant:" + mid + ":" + actor),
        { meal_id: mid, user_id: actor, role: "member", status: "active" },
      );
      k.meal_ids.push(mid);
    }
    await tx.put("kitchens", k.id, k);
  });
  const transact = f.store.transaction.bind(f.store);
  let mealReads = new Set();
  f.store.transaction = (fn) =>
    transact((tx) =>
      fn({
        ...tx,
        get: (table, id) => {
          if (table === "meals") mealReads.add(id);
          return tx.get(table, id);
        },
      }),
    );
  const profile = await f.call("alice", "export.mine", { section: "profile" });
  assert.equal(mealReads.size, 0);
  assert.equal(profile.kitchens.length, 1);
  const items = [];
  let cursor = "";
  do {
    mealReads = new Set();
    const page = await f.call("alice", "export.mine", {
      section: "meals",
      kitchen_id: f.kid,
      cursor,
    });
    assert.equal(page.items.length, 1);
    assert.equal(mealReads.size, 1);
    assert.equal(page.items[0].chef_quote, undefined);
    assert.ok(!JSON.stringify(page).includes("unit_price_minor"));
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(new Set(items.map((x) => x.id)).size, 45);
  await assert.rejects(
    f.call("alice", "export.mine"),
    (e) => e.code === "EXPORT_PAGINATION_REQUIRED",
  );
  await assert.rejects(
    f.call("outsider", "export.mine", { section: "meals", kitchen_id: f.kid }),
    (e) => e.code === "NOT_FOUND",
  );
});

function client(call) {
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(
      require.resolve("../miniprogram/services/personal-export"),
      "utf8",
    ),
    {
      module,
      exports: module.exports,
      require: () => ({ call }),
      console,
      Set,
    },
  );
  return module.exports.exportPersonal;
}
test("客户端将41页汇总为完整JSON，不请求旧的一次性导出", async () => {
  let requests = 0;
  const exportPersonal = client(async (action, p) => {
    assert.equal(action, "export.mine");
    if (p.section === "profile")
      return {
        name: "本人",
        exported_at: 1,
        favorite_recipe_ids: ["one"],
        kitchens: [{ id: "k", name: "厨房", role: "member" }],
      };
    assert.equal(p.section, "meals");
    const n = Number(p.cursor || 0);
    requests++;
    return {
      items: [{ id: "m" + n }],
      next_cursor: n < 40 ? String(n + 1) : "",
    };
  });
  const r = await exportPersonal();
  assert.equal(requests, 41);
  assert.equal(r.kitchens[0].meals.length, 41);
  assert.equal(r.kitchens[0].id, undefined);
  assert.equal(r.favorite_recipe_ids[0], "one");
});
test("离页停止后续分页，异常游标或过大JSON不会交付为完整文件", async () => {
  let stopped = false,
    requests = 0;
  const profile = { kitchens: [{ id: "k" }] };
  const exportPersonal = client(async (_, p) => {
    if (p.section === "profile") return profile;
    requests++;
    stopped = true;
    return { items: [{ id: "m" }], next_cursor: "next" };
  });
  await assert.rejects(
    exportPersonal({ cancelled: () => stopped }),
    /导出已停止/,
  );
  assert.equal(requests, 1);
  for (const large of [true, false]) {
    const run = client(async (_, p) =>
      p.section === "profile"
        ? profile
        : {
            items: [{ text: large ? "x".repeat(2 * 1024 * 1024) : "" }],
            next_cursor: "same",
          },
    );
    await assert.rejects(run(), large ? /JSON记录较大/ : /导出位置异常/);
  }
});
