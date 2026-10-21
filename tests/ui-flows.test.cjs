const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const storage = new Map(),
  files = new Map(),
  toasts = [],
  shares = [];
global.wx = {
  getStorageSync: (k) => storage.get(k),
  setStorageSync: (k, v) => storage.set(k, structuredClone(v)),
  removeStorageSync: (k) => storage.delete(k),
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  showToast: (x) => toasts.push(x.title),
  showModal: async () => ({ confirm: true, content: "测试原因" }),
  showActionSheet: async () => ({ tapIndex: 0 }),
  switchTab: () => {},
  navigateTo: () => {},
  navigateBack: () => {},
  setNavigationBarTitle: () => {},
  showShareMenu: () => {},
  stopPullDownRefresh: () => {},
  setClipboardData: async () => {},
  enableAlertBeforeUnload: () => {},
  disableAlertBeforeUnload: () => {},
  shareFileMessage: async (x) => shares.push(x),
  env: { USER_DATA_PATH: "/local-test-only" },
  getFileSystemManager: () => ({
    writeFile: ({ filePath, data, success }) => {
      files.set(filePath, data);
      success();
    },
    unlinkSync: (p) => files.delete(p),
    readFile: ({ filePath, success, fail }) => {
      if (!files.has(filePath)) {
        fail({ errMsg: "file does not exist" });
        return;
      }
      const v = files.get(filePath),
        b = typeof v === "string" ? Buffer.from(v) : Buffer.from(v);
      success({
        data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
      });
    },
    copyFileSync: (from, to) => {
      if (!files.has(from)) throw Error("Missing source file");
      files.set(to, files.get(from));
    },
    readdirSync: () => [...files.keys()].map((p) => p.split("/").at(-1)),
  }),
};
function page(name) {
  let definition;
  global.Page = (p) => (definition = p);
  const file = path.resolve(
    __dirname,
    "../miniprogram/pages/" + name + "/index.js",
  );
  delete require.cache[file];
  require(file);
  const p = { ...definition, data: structuredClone(definition.data) };
  p.setData = (patch) => {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.replace(/\[(\d+)\]/g, ".$1").split(".");
      let dst = p.data;
      for (const part of parts.slice(0, -1)) dst = dst[part];
      dst[parts.at(-1)] = value;
    }
  };
  return p;
}
const api = require("../miniprogram/services/api"),
  local = require("../miniprogram/services/local");
const event = (data) => ({ currentTarget: { dataset: data } });
let seed;
test("三人示例通过真实业务接口建立，重复载入不新建厨房或增加成员", async () => {
  seed = await local.seedDemo();
  assert.equal(local.actor(), "chef");
  const k = await api.kitchen(seed.kitchenId);
  assert.equal(k.dishes.length, 6);
  assert.equal(k.members.length, 3);
  const m = await api.meal(seed.mealId);
  assert.equal(m.requests.length, 2);
  assert.equal(m.summary.find((d) => d.name === "番茄炒蛋").people, 3);
  const again = await local.seedDemo();
  assert.deepEqual(again, seed);
  assert.equal((await api.profile()).kitchens.length, 1);
});
test("菜品详情改份数保留朋友人数与私人备注，不返回厨师价格", async () => {
  local.selectActor("alice");
  const before = await api.meal();
  const id = before.menu[0].id;
  const p = page("dish");
  await p.onLoad({ id });
  assert.equal(p.data.error, "");
  assert.ok(!("default_price_minor" in p.data.dish));
  p.change(event({ delta: 1 }));
  const draft = api.loadSelection(before.id);
  assert.equal(draft.people, before.selection.people);
  assert.equal(draft.note, before.selection.note);
  assert.equal(draft.items.find((x) => x.dish_id === id).quantity, 2);
  assert.equal(draft.items.length, before.selection.items.length);
  local.selectActor("chef");
});
test("饭局记录展示第七场以后的记录，筛选与打开均使用完整列表", async () => {
  const k = await api.kitchen(seed.kitchenId);
  for (let i = 0; i < 8; i++)
    await api.mutate("meal.publish", {
      kitchen_id: k.id,
      title: "历史列表测试 " + i,
      estimated_people: 4,
      dish_ids: [k.dishes[0].id],
      scheduled_at: Date.now() + 8 * 3600000 + i * 60000,
      cutoff_at: Date.now() + 7 * 3600000,
    });
  const p = page("history");
  await p.refresh();
  assert.equal(p.data.visible.length, 9);
  const ninth = p.data.visible[8];
  p.open(event({ id: ninth.id }));
  assert.equal(api.currentMeal(), ninth.id);
  p.search({ detail: { value: "历史列表测试 7" } });
  assert.equal(p.data.visible.length, 1);
  p.filter(event({ filter: "ended" }));
  assert.equal(p.data.visible.length, 0);
  api.chooseMeal(seed.mealId);
});
test("菜谱文字草稿可恢复但不缓存内部价，按角色隔离", async () => {
  const k = await api.kitchen();
  const p = page("editor");
  await p.onLoad({ id: k.dishes[0].id });
  p.input({
    ...event({ field: "steps" }),
    detail: { value: "尚未保存的小诀窍" },
  });
  p.input({ ...event({ field: "price" }), detail: { value: "99.99" } });
  const draft = [...storage.entries()].find(([key]) =>
    key.startsWith("squiddy-form-v1-chef-editor"),
  );
  assert.ok(draft);
  assert.ok(!("price" in draft[1].fields));
  assert.ok(!JSON.stringify(draft[1]).includes("99.99"));
  const restored = page("editor");
  await restored.onLoad({ id: k.dishes[0].id });
  assert.equal(restored.data.steps, "尚未保存的小诀窍");
  assert.equal(restored.data.price, "12.00");
  local.selectActor("alice");
  const forms = require("../miniprogram/services/forms");
  assert.equal(forms.loadForm("editor", k.dishes[0].id), null);
  local.selectActor("chef");
});
test("未发布饭局的时间和菜单可恢复，复选状态与提交集合一致", async () => {
  const p = page("publish");
  await p.onLoad({});
  p.input({
    ...event({ field: "title" }),
    detail: { value: "还没发布的周末晚饭" },
  });
  const selected = [p.data.dishes[2].id];
  p.select({ detail: { value: selected } });
  const again = page("publish");
  await again.onLoad({});
  assert.equal(again.data.title, "还没发布的周末晚饭");
  assert.deepEqual(again.data.selected, selected);
  assert.equal(again.data.dishes.filter((x) => x.selected).length, 1);
});
test("轮询保留未保存的价格，冲突不会覆盖别人改价，可载入新版本继续保存", async () => {
  const p = page("meal");
  await p.refresh();
  const id = p.data.prices[0].dish_id;
  const revision = p.data.meal.chef_quote.revision;
  p.priceInput({ ...event({ index: 0 }), detail: { value: "15.00" } });
  await api.mutate("price.update", {
    meal_id: seed.mealId,
    dish_id: id,
    unit_price_minor: 2000,
    expected_revision: revision,
  });
  await p.refresh(true);
  assert.equal(p.data.prices[0].value, "15.00");
  assert.equal(p.data.prices[0].expectedRevision, revision);
  await p.priceSave(event({ index: 0 }));
  assert.equal((await api.meal()).chef_prices[0].unit_price_minor, 2000);
  assert.equal(p.data.prices[0].conflict, true);
  await p.resetPrice(event({ index: 0 }));
  assert.equal(p.data.prices[0].value, "20.00");
  p.priceInput({ ...event({ index: 0 }), detail: { value: "18.00" } });
  await p.priceSave(event({ index: 0 }));
  assert.equal((await api.meal()).chef_prices[0].unit_price_minor, 1800);
});
test("推荐偏好修改立即清除旧搭配，进行中的旧请求不能把含忌口的结果填回来", async () => {
  const p = page("recommend");
  await p.onLoad();
  p.setData({ plans: [{ id: "stale", items: [] }] });
  p.input({ ...event({ field: "avoid" }), detail: { value: "鸡蛋" } });
  assert.equal(p.data.plans.length, 0);
  const pending = p.generate();
  p.input({ ...event({ field: "avoid" }), detail: { value: "鸡蛋、小麦" } });
  await pending;
  assert.equal(p.data.plans.length, 0);
  await p.generate();
  const m = await api.meal();
  for (const plan of p.data.plans)
    for (const item of plan.items) {
      const d = m.menu.find((x) => x.id === item.dish_id);
      assert.ok(
        !d.ingredients.concat(d.allergens).some((x) => /鸡蛋|小麦/.test(x)),
      );
    }
});
test("导出文件可以交给微信文件分享界面，离开后清除页面里的文件入口", async () => {
  const p = page("settings");
  await p.exportData();
  await p.shareExport();
  assert.equal(shares.length, 1);
  assert.equal(shares[0].fileName, "鱿鱼须须-我的数据.json");
  assert.ok(files.has(shares[0].filePath));
  p.onHide();
  assert.equal(p.data.exportPath, "");
  await p.shareExport();
  assert.equal(shares.length, 1);
});
test("厨师身份改变时轮询清除内部价、旧计划和邀请状态，切换到成员视图", async () => {
  const p = page("meal");
  await p.refresh();
  p.priceInput({ ...event({ index: 0 }), detail: { value: "88.00" } });
  p.setData({
    inviteToken: "old-private-token",
    publicShareId: "old-share",
    showPrices: true,
  });
  const candidate = p.data.meal.cook_candidates.find((x) => x.name === "阿宁");
  await api.mutate("meal.assignCook", {
    meal_id: seed.mealId,
    member_id: candidate.id,
    expected_revision: p.data.meal.revision,
  });
  await p.refresh(true);
  assert.equal(p.data.meal.role, "member");
  assert.deepEqual(p.data.prices, []);
  assert.deepEqual(p.data.plans, []);
  assert.equal(p.data.total, "");
  assert.equal(p.data.inviteToken, "");
  assert.equal(p.data.publicShareId, "");
  assert.equal(p.data.showPrices, false);
  assert.equal(p.data.panel, "selection");
});

test("厨房详情允许查看未列入本餐的菜谱，但不会把它加入本餐选择", async () => {
  local.selectActor("alice");
  const k = await api.kitchen();
  const p = page("publish");
  local.selectActor("chef");
  await p.onLoad({});
  p.setData({ selected: [k.dishes[0].id], title: "只做一道菜的饭局" });
  await p.publish();
  const d = page("dish");
  await d.onLoad({ id: k.dishes[1].id });
  assert.equal(d.data.error, "");
  assert.equal(d.data.dish.id, k.dishes[1].id);
  assert.equal(d.data.canOrder, false);
});
test("重置演练只清理演练数据，云端选择与其他文件不受影响，可重新开始", async () => {
  storage.set("squiddy-kitchen-wechat", "real-cloud-kitchen");
  storage.set("squiddy-draft-v2-wechat-real", { note: "cloud-draft" });
  const original = await api.profile();
  assert.ok(original.kitchens.length);
  local.resetDemo();
  assert.equal(storage.get("squiddy-kitchen-wechat"), "real-cloud-kitchen");
  assert.equal(storage.get("squiddy-draft-v2-wechat-real").note, "cloud-draft");
  assert.equal((await api.profile()).kitchens.length, 0);
  const fresh = await local.seedDemo();
  assert.notEqual(fresh.kitchenId, seed.kitchenId);
  assert.equal((await api.meal(fresh.mealId)).participant_count, 3);
});

test("重新打开同一厨房保留当前饭局，真正切换厨房时清除旧饭局", async () => {
  const k = api.currentKitchen(),
    m = api.currentMeal();
  api.chooseKitchen(k);
  assert.equal(api.currentMeal(), m);
  api.chooseKitchen("other-kitchen");
  assert.equal(api.currentMeal(), "");
  api.chooseKitchen(k);
  if (m) api.chooseMeal(m);
});
test("丰富菜谱页面贯通：导入预览、分步规格营养编辑、点菜口味提交与厨师明细", async () => {
  local.selectActor("chef");
  await local.seedDemo();
  const k = await api.kitchen();
  const importer = page("import");
  await importer.onLoad();
  importer.setData({
    raw: "长名字的香菇彩椒鸡丁\n食材：鸡肉、香菇、彩椒\n做法：\n1. 洗净切好\n2. 炒熟\nhttps://example.com/original",
  });
  importer.parse();
  assert.equal(importer.data.sourceUrl, "https://example.com/original");
  await importer.save();
  const after = await api.kitchen();
  const d = after.dishes.find((d) => d.name === "长名字的香菇彩椒鸡丁");
  assert.ok(d);
  const editor = page("editor");
  await editor.onLoad({ id: d.id });
  editor.setData({
    variants: "小份、大份",
    attributes: "辣度:不辣、微辣\n加料:加葱、不加葱",
    nutritionVisible: true,
    nutritionSource: "包装标签",
    nutritionBasis: "每100克",
    calories: "120",
  });
  editor.splitSteps();
  assert.equal(editor.data.stepRows.length, 2);
  await editor.save();
  const stored = (await api.kitchen()).dishes.find((x) => x.id === d.id);
  assert.deepEqual(stored.variants, ["小份", "大份"]);
  assert.equal(stored.nutrition.calories, 120);
  assert.equal(stored.nutrition.protein, null);
  const published = await api.mutate("meal.publish", {
    kitchen_id: k.id,
    title: "规格口味验收",
    dish_ids: [d.id],
    scheduled_at: Date.now() + 7200000,
    cutoff_at: Date.now() + 3600000,
  });
  api.chooseMeal(published.id);
  const detail = page("dish");
  await detail.onLoad({ id: d.id });
  detail.variant({ detail: { value: "1" } });
  detail.option({
    detail: { value: "1" },
    currentTarget: { dataset: { index: 0 } },
  });
  detail.change(event({ delta: 1 }));
  const cart = page("meal");
  await cart.refresh();
  assert.match(cart.data.draft[0].name, /大份/);
  assert.match(cart.data.draft[0].name, /微辣/);
  await cart.submit();
  await cart.refresh();
  assert.match(cart.data.requestRows[0].lines[0].label, /大份/);
  assert.match(cart.data.requestRows[0].lines[0].label, /微辣/);
  const menu = page("menu");
  await menu.refresh();
  menu.change(event({ id: d.id, delta: 1 }));
  assert.equal(api.loadSelection(published.id), null);
  const preserved = (await api.meal(published.id)).selection;
  assert.equal(preserved.items[0].variant, "大份");
  assert.equal(preserved.items[0].options[0].value, "微辣");
  cart.onHide?.();
});
test("多规格前端保留两种组合，菜单统计合计、逐项提交并贯通购物与反馈", async () => {
  local.selectActor("chef");
  const k = await api.kitchen();
  const d = k.dishes.find((d) => d.variants?.length === 2);
  assert.ok(d);
  const pub = await api.mutate("meal.publish", {
    kitchen_id: k.id,
    title: "多规格购物与饭后反馈",
    dish_ids: [d.id],
    scheduled_at: Date.now() + 7200000,
    cutoff_at: Date.now() + 3600000,
  });
  api.chooseMeal(pub.id);
  const detail = page("dish");
  await detail.onLoad({ id: d.id });
  detail.change(event({ delta: 1 }));
  detail.variant({ detail: { value: "1" } });
  detail.change(event({ delta: 1 }));
  assert.equal(detail.data.chosen.length, 2);
  assert.equal(detail.data.totalQuantity, 2);
  detail.variant({ detail: { value: "0" } });
  assert.equal(detail.data.quantity, 1);
  const menu = page("menu");
  await menu.refresh();
  assert.equal(menu.data.dishes[0].quantity, 2);
  assert.equal(menu.data.count, 1);
  const cart = page("meal");
  await cart.refresh();
  assert.equal(cart.data.draft.length, 2);
  await cart.submit();
  await cart.action(event({ action: "meal.lock" }));
  await cart.confirmPlan();
  assert.equal(cart.data.meal.items.length, 2);
  assert.equal(new Set(cart.data.meal.items.map((i) => i.line_id)).size, 2);
  const shopping = page("shopping");
  await shopping.refresh();
  await shopping.generate();
  assert.equal(shopping.data.list.items.length, d.ingredients.length);
  assert.equal(shopping.data.list.items[0].sources.length, 2);
  shopping.add();
  shopping.setData({ name: "纸巾", amount: "1包", note: "一起带来" });
  await shopping.save();
  const added = shopping.data.list.items.find((i) => i.name === "纸巾");
  assert.ok(added);
  await shopping.check(event({ id: added.id }));
  assert.equal(
    shopping.data.list.items.find((i) => i.id === added.id).checked,
    true,
  );
  for (const row of cart.data.meal.items) {
    await cart.transition(
      event({ id: row.dish_id, line: row.line_id, status: "cooking" }),
    );
    await cart.transition(
      event({ id: row.dish_id, line: row.line_id, status: "served" }),
    );
  }
  assert.equal(cart.data.meal.status, "completed");
  const review = page("review");
  await review.refresh();
  assert.equal(review.data.rows.length, 2);
  review.tag(event({ index: 1, tag: 0 }));
  review.input({ ...event({}), detail: { value: "谢谢掌勺的人" } });
  await review.save();
  assert.equal(review.data.review.own.note, "谢谢掌勺的人");
  assert.equal(
    review.data.review.own.items[0].line_id,
    review.data.rows[1].line_id,
  );
  assert.equal(review.data.review.feedback.length, 1);
  review.onHide();
  assert.equal(review.data.note, "");
  cart.onHide();
});
test("公开分享卡片与受邀加入卡片分别路由，不混入邀请凭据", () => {
  const p = page("meal");
  p.setData({
    publicShareId: "public123",
    inviteToken: "private-token-only",
    meal: { title: "周末一桌饭" },
  });
  assert.equal(
    p.onShareAppMessage({ target: { dataset: { share: "public" } } }).path,
    "/pages/meal/index?share=public123",
  );
  assert.ok(
    !p
      .onShareAppMessage({ target: { dataset: { share: "public" } } })
      .path.includes("private-token"),
  );
  assert.equal(
    p.onShareAppMessage({ target: { dataset: {} } }).path,
    "/pages/invite/index?token=private-token-only",
  );
});
test("离开购物或反馈页面后，较晚返回的请求不能重新填回私有内容", async () => {
  const original = api.call;
  try {
    for (const name of ["shopping", "review"]) {
      let resume;
      const held = new Promise((resolve) => {
        resume = resolve;
      });
      api.call = async (...args) => {
        const result = await original(...args);
        await held;
        return result;
      };
      const p = page(name),
        pending = p.refresh();
      p.onHide();
      resume();
      await pending;
      assert.equal(p.data[name === "shopping" ? "list" : "review"], null);
      assert.equal(p.data.note, "");
    }
  } finally {
    api.call = original;
  }
});

test("完整备份页执行ZIP导出与校验、调用收藏界面、恢复到新厨房且重复继续不复制", async () => {
  local.selectActor("chef");
  const source = api.currentKitchen();
  const before = await api.kitchen(source);
  const backup = page("backup");
  backup.setData({ includeImages: false });
  await backup.create();
  assert.equal(backup.data.error, "");
  assert.ok(backup.data.files.length > 0);
  const file = backup.data.files.at(-1);
  let favorite;
  wx.addFileToFavorites = async (r) => {
    favorite = r;
  };
  await backup.favorite(event({ index: backup.data.files.length - 1 }));
  assert.equal(favorite.filePath, file.path);
  wx.chooseMessageFile = async () => ({
    tempFiles: [{ path: file.path, size: file.size }],
  });
  await backup.select();
  assert.equal(backup.data.error, "");
  await backup.restore();
  assert.equal(backup.data.error, "");
  const newKitchen = backup.data.restoredKitchen;
  assert.notEqual(newKitchen, source);
  const restored = await api.kitchen(newKitchen);
  assert.equal(restored.dishes.length, before.dishes.length);
  assert.equal(restored.meals.length, 0);
  await backup.restore();
  assert.equal(
    (await api.kitchen(newKitchen)).dishes.length,
    before.dishes.length,
  );
  assert.equal((await api.kitchen(source)).dishes.length, before.dishes.length);
  api.chooseKitchen(source);
});

test("备份图片的实际文件字节往返，恢复重新上传并绑定新厨房图片", async () => {
  local.selectActor("chef");
  const kid = api.currentKitchen(),
    k = await api.kitchen(kid),
    d = k.dishes[0];
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const imagePath = "/local-test-only/source-photo.jpg";
  files.set(
    imagePath,
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  const image = await api.mutate("media.prepare", { kitchen_id: kid });
  await api.completeMedia({ media_id: image.id, local_path: imagePath });
  await api.mutate("dish.save", {
    kitchen_id: kid,
    dish_id: d.id,
    expected_revision: d.revision,
    name: d.name,
    category: d.category,
    category_id: d.category_id,
    ingredients: d.ingredients,
    allergens: d.allergens,
    steps: d.steps,
    minutes: d.minutes,
    image_id: image.id,
    default_serves: d.default_serves,
  });
  const backup = page("backup");
  await backup.create();
  assert.equal(backup.data.error, "");
  const file = backup.data.files.at(-1);
  wx.chooseMessageFile = async () => ({
    tempFiles: [{ path: file.path, size: file.size }],
  });
  await backup.select();
  assert.ok(backup.data.preview.photos > 0);
  await backup.restore();
  assert.equal(backup.data.error, "");
  const recovered = await api.kitchen(backup.data.restoredKitchen);
  const dish = recovered.dishes.find((x) => x.name === d.name);
  assert.ok(dish.image_id);
  assert.notEqual(dish.image_id, image.id);
  const stored = await api.call("media.read", { media_id: dish.image_id });
  assert.deepEqual(Buffer.from(files.get(stored.file_id)), bytes);
  api.chooseKitchen(kid);
});
