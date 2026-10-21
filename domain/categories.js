"use strict";
const { input, id, text, keys } = require("./errors");
const names = {
  protein: "荤菜",
  vegetable: "素菜",
  soup: "汤羹",
  staple: "主食",
  dessert: "甜点",
};
function categories(k) {
  return (
    k.categories ||
    Object.entries(names).map(([id, name]) => ({
      id,
      name,
      kind: id,
      hidden: false,
    }))
  ).map((c) => ({ ...c }));
}
function validateCategories(value, dishes) {
  input(
    Array.isArray(value) && value.length > 0 && value.length <= 20,
    "请保留1至20个分类",
  );
  const ids = new Set(),
    labels = new Set();
  const rows = value.map((c) => {
    keys(c, ["id", "name", "kind", "hidden"]);
    const cid = id(c.id),
      name = text(c.name, 12, "分类名称");
    input(
      cid !== "all" && !ids.has(cid) && !labels.has(name),
      "分类编号与名称不能重复",
    );
    input(
      Object.prototype.hasOwnProperty.call(names, c.kind),
      "请选择分类对应的菜类",
    );
    ids.add(cid);
    labels.add(name);
    return { id: cid, name, kind: c.kind, hidden: c.hidden === true };
  });
  input(
    dishes.every((d) => ids.has(d.category_id || d.category)),
    "分类里还有菜，请先移动菜谱再删除",
  );
  return rows;
}
module.exports = { categories, validateCategories };
