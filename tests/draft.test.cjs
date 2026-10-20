const { test } = require("node:test");
const assert = require("node:assert/strict");
const data = new Map();
global.wx = {
  getStorageSync: (k) => data.get(k),
  setStorageSync: (k, v) => data.set(k, structuredClone(v)),
  removeStorageSync: (k) => data.delete(k),
  showToast: () => {},
};
const api = require("../miniprogram/services/api");
test("实际草稿模块拒绝损坏数量、重复菜品并白名单过滤价格", () => {
  const id = "draft1";
  data.set(api.draftKey(id), {
    items: [{ dish_id: "a", quantity: -1 }],
    revision: 0,
  });
  assert.equal(api.loadSelection(id), null);
  assert.equal(
    api.saveSelection(id, {
      items: [{ dish_id: "a", quantity: 2, price: 999 }],
      note: "不要香菜",
      revision: 0,
      people: 2,
      secret: "x",
    }),
    true,
  );
  assert.deepEqual(api.loadSelection(id), {
    items: [{ dish_id: "a", quantity: 2 }],
    note: "不要香菜",
    people: 2,
    revision: 0,
  });
  assert.equal(
    api.saveSelection(id, {
      items: [
        { dish_id: "a", quantity: 1 },
        { dish_id: "a", quantity: 1 },
      ],
      revision: 0,
    }),
    false,
  );
});
test("草稿按演练身份隔离", () => {
  data.set("squiddy-rehearsal-actor", "alice");
  assert.equal(api.loadSelection("draft1"), null);
  data.set("squiddy-rehearsal-actor", "chef");
  assert.equal(api.loadSelection("draft1").people, 2);
});
test("存储失败不报告草稿保存成功", () => {
  const original = wx.setStorageSync;
  wx.setStorageSync = () => {
    throw Error("full");
  };
  assert.equal(
    api.saveSelection("x", { items: [], note: "", revision: 0, people: 1 }),
    false,
  );
  wx.setStorageSync = original;
});
test("货币转换拒绝指数、负数及三位小数，零与未填不同", () => {
  assert.equal(api.parseMoney(""), null);
  assert.equal(api.parseMoney("0"), 0);
  assert.equal(api.parseMoney("12.30"), 1230);
  for (const v of ["1e2", "-1", "1.234", "100000"])
    assert.throws(() => api.parseMoney(v));
});
