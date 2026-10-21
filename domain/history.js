"use strict";
const { getMany } = require("./collections");
const { input } = require("./errors");
const running = new Set(["open", "locked", "cooking"]);
async function activeMealIds(tx, kitchen) {
  if (Array.isArray(kitchen.active_meal_ids)) {
    const rows = await getMany(tx, "meals", kitchen.active_meal_ids);
    return kitchen.active_meal_ids.filter((id) =>
      running.has(rows.get(id)?.status),
    );
  }
  const meals = await getMany(tx, "meals", kitchen.meal_ids);
  return [...meals].filter(([, m]) => running.has(m.status)).map(([id]) => id);
}
async function updateActiveMeal(tx, meal, limit = 40) {
  const k = await tx.get("kitchens", meal.kitchen_id);
  if (!k) return;
  const active = (await activeMealIds(tx, k)).filter((id) => id !== meal.id);
  if (running.has(meal.status)) {
    input(active.length < limit, "同时进行中的饭局已达40场，请先结束一场");
    active.push(meal.id);
  }
  k.active_meal_ids = active;
  await tx.put("kitchens", k.id, k);
}
function historyPage(kitchen, cursor = "", limit = 20) {
  const ids = (kitchen.meal_ids || []).slice().reverse();
  const at = cursor ? ids.indexOf(cursor) : -1;
  input(!cursor || at >= 0, "历史位置已变化，请刷新列表");
  const selected = ids.slice(at + 1, at + 1 + limit);
  return {
    ids: selected,
    next_cursor:
      at + 1 + selected.length < ids.length ? selected.at(-1) || "" : "",
    total: ids.length,
  };
}
module.exports = { activeMealIds, updateActiveMeal, historyPage };
