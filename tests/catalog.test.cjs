const test = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./helpers/fixture.cjs");
const reject = (p, code) => assert.rejects(p, (e) => e.code === code);
test("分类支持旧数据、改名与顺序；已发布菜单保持快照，成员不能修改", async () => {
  const f = await setup();
  const k = await f.call("chef", "kitchen.read", { kitchen_id: f.kid });
  assert.equal(k.categories.length, 5);
  const old = await f.call("alice", "meal.read", { meal_id: f.mid });
  const rows = k.categories
    .map((c) =>
      c.id === "vegetable" ? { ...c, name: "家常素菜", hidden: true } : c,
    )
    .reverse();
  const payload = {
    kitchen_id: f.kid,
    expected_revision: k.revision,
    categories: rows,
  };
  await reject(f.call("alice", "category.save", payload), "FORBIDDEN");
  await f.call("chef", "category.save", payload);
  const after = await f.call("chef", "kitchen.read", { kitchen_id: f.kid });
  assert.equal(after.categories[0].id, "dessert");
  assert.equal(after.dishes[0].category_name, "家常素菜");
  assert.equal(after.dishes[0].category, "vegetable");
  assert.equal(after.dishes[0].default_price_minor, 1200);
  assert.equal(
    (await f.call("alice", "meal.read", { meal_id: f.mid })).menu[0]
      .category_name,
    old.menu[0].category_name,
  );
  await reject(f.call("chef", "category.save", payload), "CONFLICT");
  await reject(
    f.call("chef", "category.save", {
      ...payload,
      expected_revision: after.revision,
      categories: rows.filter((c) => c.id !== "vegetable"),
    }),
    "INVALID_INPUT",
  );
  await reject(
    f.call("chef", "category.save", {
      ...payload,
      expected_revision: after.revision,
      categories: [
        ...rows,
        { id: "custom", name: "BLOCKED_TEXT", kind: "soup", hidden: false },
      ],
    }),
    "CONTENT_REJECTED",
  );
});
test("自定义分类保存菜谱，空分类可删除；排序列表必须完整且不允许跨厨房编号", async () => {
  const f = await setup();
  let k = await f.call("chef", "kitchen.read", { kitchen_id: f.kid });
  await f.call("chef", "category.save", {
    kitchen_id: f.kid,
    expected_revision: k.revision,
    categories: [
      ...k.categories,
      { id: "custom", name: "私房小炒", kind: "protein", hidden: false },
    ],
  });
  const created = await f.call("chef", "dish.save", {
    kitchen_id: f.kid,
    category_id: "custom",
    name: "香菇炒鸡丁",
    ingredients: ["香菇", "鸡肉"],
    allergens: [],
    steps: "炒熟",
    minutes: 20,
  });
  k = await f.call("chef", "kitchen.read", { kitchen_id: f.kid });
  const d = k.dishes.find((x) => x.id === created.id);
  assert.equal(d.category, "protein");
  assert.equal(d.category_name, "私房小炒");
  const ids = k.dishes.map((d) => d.id).reverse();
  await reject(
    f.call("chef", "dish.reorder", {
      kitchen_id: f.kid,
      expected_revision: k.revision,
      dish_ids: ids.slice(1),
    }),
    "INVALID_INPUT",
  );
  await reject(
    f.call("alice", "dish.reorder", {
      kitchen_id: f.kid,
      expected_revision: k.revision,
      dish_ids: ids,
    }),
    "FORBIDDEN",
  );
  await f.call("chef", "dish.reorder", {
    kitchen_id: f.kid,
    expected_revision: k.revision,
    dish_ids: ids,
  });
  k = await f.call("chef", "kitchen.read", { kitchen_id: f.kid });
  assert.deepEqual(
    k.dishes.map((d) => d.id),
    ids,
  );
  await f.call("chef", "category.save", {
    kitchen_id: f.kid,
    expected_revision: k.revision,
    categories: k.categories.filter((c) => c.id !== "dessert"),
  });
});

test("收藏按账号隔离，朋友想吃跨成员汇总，批量导入幂等且不改变既有饭局", async () => {
  const f = await setup();
  let lib = await f.call("alice", "library.read", { kitchen_id: f.kid });
  assert.equal(lib.recipes.length, 12);
  assert.equal(lib.can_import, false);
  await f.call("alice", "library.favorite", {
    recipe_id: "pepper-chicken",
    favorite: true,
  });
  assert.equal(
    (await f.call("alice", "library.read")).recipes.find(
      (r) => r.id === "pepper-chicken",
    ).favorite,
    true,
  );
  assert.equal(
    (await f.call("bob", "library.read")).recipes.find(
      (r) => r.id === "pepper-chicken",
    ).favorite,
    false,
  );
  await f.call("alice", "library.wish", {
    kitchen_id: f.kid,
    recipe_id: "pepper-chicken",
    wished: true,
    expected_revision: lib.kitchen_revision,
  });
  lib = await f.call("bob", "library.read", { kitchen_id: f.kid });
  await f.call("bob", "library.wish", {
    kitchen_id: f.kid,
    recipe_id: "pepper-chicken",
    wished: true,
    expected_revision: lib.kitchen_revision,
  });
  lib = await f.call("chef", "library.read", { kitchen_id: f.kid });
  assert.equal(
    lib.recipes.find((r) => r.id === "pepper-chicken").wish_count,
    2,
  );
  const payload = {
    kitchen_id: f.kid,
    recipe_ids: ["pepper-chicken", "corn-potato"],
    expected_revision: lib.kitchen_revision,
  };
  await reject(f.call("alice", "library.import", payload), "FORBIDDEN");
  const r = await f.call("chef", "library.import", payload);
  assert.equal(r.imported, 2);
  const again = await f.call("chef", "library.import", {
    ...payload,
    expected_revision: r.revision,
  });
  assert.equal(again.imported, 0);
  assert.deepEqual(again.dish_ids, r.dish_ids);
  assert.equal(
    (await f.call("chef", "kitchen.read", { kitchen_id: f.kid })).dishes.length,
    7,
  );
  assert.equal(
    (await f.call("alice", "meal.read", { meal_id: f.mid })).menu.length,
    5,
  );
  lib = await f.call("chef", "library.read", { kitchen_id: f.kid });
  assert.equal(
    lib.recipes.find((r) => r.id === "pepper-chicken").wish_count,
    0,
  );
  await reject(
    f.call("chef", "library.import", {
      ...payload,
      recipe_ids: ["__proto__"],
      expected_revision: lib.kitchen_revision,
    }),
    "INVALID_INPUT",
  );
  const backup = await f.call("alice", "export.mine");
  assert.deepEqual(backup.favorite_recipe_ids, ["pepper-chicken"]);
});
test("离开厨房后移除想吃记录，旧导入请求不能被撤权成员重放", async () => {
  const f = await setup();
  let lib = await f.call("alice", "library.read", { kitchen_id: f.kid });
  await f.call("alice", "library.wish", {
    kitchen_id: f.kid,
    recipe_id: "red-bean",
    wished: true,
    expected_revision: lib.kitchen_revision,
  });
  await f.call("alice", "kitchen.leave", { kitchen_id: f.kid });
  lib = await f.call("chef", "library.read", { kitchen_id: f.kid });
  assert.equal(lib.recipes.find((r) => r.id === "red-bean").wish_count, 0);
  await reject(
    f.call("alice", "library.read", { kitchen_id: f.kid }),
    "NOT_FOUND",
  );
});
test("完整菜谱字段受审核和图片权限约束，编辑兼容旧字段，发布保持快照", async () => {
  const f = await setup();
  const k = await f.call("chef", "kitchen.read", { kitchen_id: f.kid });
  const original = k.dishes[0];
  const base = {
    kitchen_id: f.kid,
    dish_id: original.id,
    expected_revision: original.revision,
    name: original.name,
    category: original.category,
    ingredients: original.ingredients,
    allergens: original.allergens,
    steps: original.steps,
    minutes: original.minutes,
  };
  const details = {
    subtitle: "两人份的家常味",
    source_url: "https://example.com/recipe",
    step_title: "一起做",
    recipe_steps: [
      { text: "洗净食材", image_id: "" },
      { text: "翻炒至熟", image_id: "" },
    ],
    variants: ["小份", "大份"],
    attributes: [{ name: "辣度", options: ["不辣", "微辣"] }],
    nutrition: {
      visible: true,
      source: "包装标签",
      basis: "每100克",
      calories: 120,
      protein: 3,
      fat: null,
      carbs: 20,
      fiber: 1,
    },
  };
  await reject(
    f.call("chef", "dish.save", {
      ...base,
      ...details,
      subtitle: "BLOCKED_TEXT",
    }),
    "CONTENT_REJECTED",
  );
  await reject(
    f.call("chef", "dish.save", {
      ...base,
      ...details,
      source_url: "javascript:alert(1)",
    }),
    "INVALID_INPUT",
  );
  await reject(
    f.call("chef", "dish.save", {
      ...base,
      ...details,
      nutrition: { ...details.nutrition, source: "" },
    }),
    "INVALID_INPUT",
  );
  await reject(
    f.call("chef", "dish.save", {
      ...base,
      ...details,
      recipe_steps: [{ text: "步骤", image_id: "missing" }],
    }),
    "NOT_FOUND",
  );
  const saved = await f.call("chef", "dish.save", { ...base, ...details });
  const after = (await f.call("chef", "kitchen.read", { kitchen_id: f.kid }))
    .dishes[0];
  assert.equal(after.subtitle, details.subtitle);
  assert.deepEqual(after.recipe_steps, details.recipe_steps);
  assert.deepEqual(after.nutrition, details.nutrition);
  await f.call("chef", "dish.save", {
    ...base,
    expected_revision: saved.revision,
    name: "新菜名",
  });
  assert.equal(
    (await f.call("chef", "kitchen.read", { kitchen_id: f.kid })).dishes[0]
      .subtitle,
    details.subtitle,
  );
  assert.equal(
    (await f.call("alice", "meal.read", { meal_id: f.mid })).menu[0].subtitle,
    "",
  );
  const mid = (
    await f.call("chef", "meal.publish", {
      kitchen_id: f.kid,
      title: "丰富的菜单",
      dish_ids: [original.id],
      scheduled_at: f.now() + 3600000,
      cutoff_at: f.now() + 1800000,
    })
  ).id;
  const m = await f.call("chef", "meal.read", { meal_id: mid });
  assert.equal(m.menu[0].step_title, "一起做");
  await f.call("chef", "selection.replace", {
    meal_id: mid,
    expected_revision: 0,
    items: [
      {
        dish_id: original.id,
        quantity: 2,
        variant: "大份",
        options: [{ name: "辣度", value: "微辣" }],
      },
    ],
  });
  const r = await f.call("chef", "meal.read", { meal_id: mid });
  assert.equal(r.requests[0].items[0].variant, "大份");
  assert.equal(r.requests[0].items[0].options[0].value, "微辣");
  assert.equal(r.summary[0].requested_quantity, 2);
  assert.equal(r.chef_quote.total_known_minor, 2400);
  await reject(
    f.call("chef", "selection.replace", {
      meal_id: mid,
      expected_revision: 1,
      items: [{ dish_id: original.id, quantity: 1, variant: "不存在" }],
    }),
    "INVALID_INPUT",
  );
  await reject(
    f.call("chef", "selection.replace", {
      meal_id: mid,
      expected_revision: 1,
      items: [
        {
          dish_id: original.id,
          quantity: 1,
          options: [{ name: "辣度", value: "BLOCKED_TEXT" }],
        },
      ],
    }),
    "INVALID_INPUT",
  );
});
test("分享文字只做本地结构整理，链接不被抓取，不从空链接伪造食谱", () => {
  const { parseRecipeText } = require("../src/services/import-recipe");
  assert.deepEqual(
    parseRecipeText(
      "香菇炒鸡丁\n食材：鸡肉、香菇\n做法：\n1. 切好\n2. 炒熟\nhttps://www.xiaohongshu.com/explore/example",
    ),
    {
      name: "香菇炒鸡丁",
      source_url: "https://www.xiaohongshu.com/explore/example",
      ingredients: "鸡肉、香菇",
      steps: "1. 切好\n2. 炒熟",
    },
  );
  assert.equal(parseRecipeText("https://xhslink.com/example").ingredients, "");
  assert.equal(parseRecipeText("https://xhslink.com/example").steps, "");
});
