const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const storage = new Map(),
  files = new Map(),
  toasts = [];
global.wx = {
  getStorageSync: (k) => storage.get(k),
  setStorageSync: (k, v) => storage.set(k, structuredClone(v)),
  removeStorageSync: (k) => storage.delete(k),
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  showToast: (x) => toasts.push(x.title),
  showModal: async () => ({ confirm: true, content: "本地测试原因" }),
  showActionSheet: async () => ({ tapIndex: 0 }),
  switchTab: () => {},
  navigateTo: () => {},
  navigateBack: () => {},
  stopPullDownRefresh: () => {},
  showShareMenu: () => {},
  setClipboardData: async () => {},
  env: { USER_DATA_PATH: "/local-test-only" },
  getFileSystemManager: () => ({
    writeFile: ({ filePath, data, success }) => {
      files.set(filePath, data);
      success();
    },
    unlinkSync: (p) => files.delete(p),
  }),
};
function page(name) {
  let definition;
  global.Page = (p) => {
    definition = p;
  };
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
      let target = p.data;
      for (const segment of parts.slice(0, -1)) target = target[segment];
      target[parts.at(-1)] = value;
    }
  };
  return p;
}
const api = require("../miniprogram/services/api"),
  local = require("../miniprogram/services/local");
const event = (data) => ({ currentTarget: { dataset: data } });
test("审核日额度不足时发布页面保留表单和草稿，解除忙碌状态且不显示成功", async () => {
  const forms = require("../miniprogram/services/forms");
  const p = page("publish"),
    original = api.mutate;
  p.setData({
    title: "额度恢复后继续",
    date: "2099-01-01",
    time: "18:30",
    selected: ["quota-dish"],
    estimatedPeople: "4",
  });
  p.remember();
  const draft = forms.loadForm("publish", ""),
    toastCount = toasts.length;
  api.mutate = async () => {
    throw new api.ApiError(
      "CONTENT_RATE_LIMITED",
      "文字审核日额度已用尽，请在额度恢复后重试",
    );
  };
  try {
    await p.publish();
    assert.equal(p.data.busy, false);
    assert.equal(p.data.title, "额度恢复后继续");
    assert.deepEqual(p.data.selected, ["quota-dish"]);
    assert.deepEqual(forms.loadForm("publish", ""), draft);
    assert.deepEqual(toasts.slice(toastCount), [
      "文字审核日额度已用尽，请在额度恢复后重试",
    ]);
  } finally {
    api.mutate = original;
    forms.clearForm("publish", "");
  }
});
test("实际页面处理器全流程：建厨菜谱→三角色邀请→弱网→定份数→完成→复制→导出→注销", async () => {
  const k = page("kitchen");
  k.onLoad({ create: "1" });
  k.setData({ name: "页面测试厨房", description: "本地自动回归" });
  await k.create();
  assert.ok(api.currentKitchen());
  const ids = [];
  for (const [name, categoryIndex] of [
    ["番茄炒蛋", 1],
    ["小炒肉", 0],
    ["莲藕汤", 2],
    ["葱油面", 3],
    ["拍黄瓜", 1],
  ]) {
    const editor = page("editor");
    await editor.onLoad({});
    editor.setData({
      name,
      ingredients: name,
      steps: "洗净后烹饪",
      categoryIndex,
      ingredientComplete: true,
      defaultServes: "2",
      price: "12",
    });
    await editor.save();
  }
  const kitchen = await api.kitchen();
  ids.push(...kitchen.dishes.map((d) => d.id));
  assert.equal(ids.length, 5);
  const pub = page("publish");
  await pub.onLoad({});
  pub.setData({ title: "页面测试晚饭" });
  await pub.publish();
  const mid = api.currentMeal();
  assert.ok(mid);
  const chef = page("meal");
  await chef.refresh();
  await chef.invitation();
  const token = chef.data.inviteToken;
  assert.equal(token.length, 48);
  for (const [actor, people] of [
    ["alice", "2"],
    ["bob", "1"],
  ]) {
    local.selectActor(actor);
    const inv = page("invite");
    inv.onLoad({});
    inv.setData({ token });
    await inv.resolve();
    assert.equal(inv.data.preview.title, "页面测试晚饭");
    await inv.accept();
    const menu = page("menu");
    await menu.refresh();
    menu.change(event({ id: ids[0], delta: 1 }));
    const meal = page("meal");
    await meal.refresh();
    meal.setData({ people, note: actor + "的备注" });
    meal.saveDraft();
    storage.set("squiddy-rehearsal-offline", true);
    await meal.submit();
    assert.ok(api.loadSelection(mid));
    storage.set("squiddy-rehearsal-offline", false);
    await meal.submit();
    assert.equal(api.loadSelection(mid), null);
    assert.equal((await api.meal()).selection.people, Number(people));
    assert.equal((await api.meal()).chef_quote, undefined);
  }
  // Recommendation add merges max, direct replaces other choices while preserving note.
  const rec = page("recommend");
  await rec.onLoad();
  const plan = rec.data.plans.find((p) => p.items.length < 5);
  assert.ok(plan);
  const other = ids.find((id) => !plan.items.some((i) => i.dish_id === id));
  const current = await api.meal();
  api.saveSelection(mid, {
    items: [{ dish_id: other, quantity: 1 }],
    note: "保留备注",
    people: 1,
    revision: current.selection.revision,
  });
  rec.setData({ plans: [plan] });
  await rec.use(event({ index: 0, direct: true }));
  const selected = (await api.meal()).selection;
  assert.ok(!selected.items.some((i) => i.dish_id === other));
  assert.equal(selected.note, "保留备注");
  assert.equal(selected.people, 3);
  // Restore Bob's simple request, then verify two accounts represent three people.
  await api.mutate("selection.replace", {
    meal_id: mid,
    items: [{ dish_id: ids[0], quantity: 1 }],
    note: "bob",
    people: 1,
    expected_revision: selected.revision,
  });
  local.selectActor("chef");
  await chef.refresh();
  assert.equal(chef.data.meal.summary[0].people, 3);
  assert.equal(chef.data.meal.summary[0].requested_quantity, 2);
  await chef.action(event({ action: "meal.lock" }));
  chef.setData({ plans: chef.data.plans.map((p) => ({ ...p, quantity: 2 })) });
  await chef.confirmPlan();
  assert.equal(chef.data.meal.items[0].quantity, 2);
  await chef.transition(event({ id: ids[0], status: "cooking" }));
  await chef.transition(event({ id: ids[0], status: "served" }));
  assert.equal(chef.data.meal.status, "completed");
  assert.equal(chef.data.total, "24.00");
  await chef.undo();
  assert.equal(chef.data.meal.status, "cooking");
  await chef.transition(event({ id: ids[0], status: "served" }));
  await chef.publicShare();
  const publicPage = page("meal");
  publicPage.onLoad({ share: chef.data.publicShareId });
  await publicPage.refresh();
  assert.equal(publicPage.data.publicMode, true);
  assert.equal(publicPage.data.meal, null);
  assert.deepEqual(Object.keys(publicPage.data.publicPreview).sort(), [
    "dishes",
    "title",
  ]);
  await chef.revokePublic();
  await publicPage.refresh();
  assert.match(publicPage.data.error, /失效/);
  assert.equal(publicPage.data.publicPreview, null);
  await chef.action(event({ action: "meal.archive" }));
  assert.equal(chef.data.meal.status, "archived");
  const copy = page("publish");
  await copy.onLoad({ copy: mid });
  assert.equal(copy.data.selected.length, 5);
  await copy.publish();
  assert.notEqual(api.currentMeal(), mid);
  assert.equal((await api.meal(mid)).status, "archived");
  local.selectActor("alice");
  const settings = page("settings");
  await settings.exportData();
  assert.ok(files.size);
  assert.ok(!settings.data.exportText.includes("chef_quote"));
  settings.setData({ feedback: "界面清楚，继续完善" });
  await settings.sendFeedback();
  assert.ok(settings.data.feedbackId);
  await settings.remove();
  assert.equal(settings.data.deletionStatus, "completed");
  assert.equal(files.size, 0);
  assert.equal((await api.call("account.deletionStatus")).status, "completed");
});
test("JSON完整文件与复制不被预览截断，页面最多渲染4096字并在离页清空私有文本", async () => {
  local.selectActor("chef");
  const settings = page("settings");
  await settings.exportData();
  const full = files.get(settings.data.exportPath);
  assert.ok(full.length > 4096);
  assert.equal(settings.data.exportText.length, 4096);
  assert.equal(settings.data.exportTruncated, true);
  assert.equal(JSON.parse(full).kitchens[0].meals.length, 2);
  let copied;
  wx.setClipboardData = async ({ data }) => {
    copied = data;
  };
  await settings.copy();
  assert.equal(copied, full);
  settings.onHide();
  assert.equal(settings._exportText, "");
  assert.equal(settings.data.exportText, "");
  assert.equal(settings.data.exportTruncated, false);
});
test("本地海报真正执行绘制与导出，不生成虚假小程序码", async () => {
  local.selectActor("chef");
  const m = await api.meal();
  const share = await api.mutate("share.create", { meal_id: m.id });
  const texts = [],
    canvas = {
      getContext: () => ({
        scale: () => {},
        fillRect: () => {},
        fillText: (t) => texts.push(t),
        drawImage: () => {
          throw Error("Local poster must not draw a QR");
        },
      }),
    };
  wx.createSelectorQuery = () => ({
    in() {
      return this;
    },
    select() {
      return this;
    },
    fields() {
      return this;
    },
    exec(fn) {
      fn([{ node: canvas }]);
    },
  });
  wx.canvasToTempFilePath = (options) =>
    options.success({ tempFilePath: "/local-test-only/poster.png" });
  const p = page("poster");
  p.onLoad({ share: share.id });
  await p.render();
  assert.equal(p.data.error, "");
  assert.equal(p.data.imagePath, "/local-test-only/poster.png");
  assert.ok(texts.some((t) => t.includes("没有可扫码凭据")));
  assert.ok(!texts.some((t) => /¥|12.00|备注/.test(t)));
});
