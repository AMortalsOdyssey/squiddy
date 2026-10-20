"use strict";
const { input, integer } = require("./errors");
function recommend(menu, options, recent = []) {
  const people = integer(options.people, 1, 20, "用餐人数");
  input(
    Array.isArray(options.avoid) && options.avoid.length <= 20,
    "忌口最多20项",
  );
  const parse = (v) => {
    input(typeof v === "string" && v.trim().length > 0 && v.length <= 20);
    return v.trim().toLowerCase();
  };
  const avoid = options.avoid.map(parse),
    likes = (options.likes || []).map(parse);
  input(likes.length <= 20);
  const max = integer(options.max_minutes ?? 480, 1, 480, "单道菜耗时上限");
  const text = (d) =>
    (
      d.name +
      "," +
      d.ingredients.join(",") +
      "," +
      (d.allergens || []).join(",")
    ).toLowerCase();
  const eligible = menu
    .filter(
      (d) =>
        d.active &&
        d.minutes <= max &&
        (!avoid.length || d.ingredient_complete === true) &&
        !avoid.some((a) => text(d).includes(a)),
    )
    .filter((d) => !options.vegetarian || d.vegetarian === true)
    .filter((d) => !options.mild || !d.spicy);
  if (eligible.length < 2)
    return {
      plans: [],
      message:
        "符合条件且食材信息完整的菜太少，请补充菜谱或调整偏好；不会用忌口菜凑数。",
    };
  let seed = 0;
  for (const c of String(options.seed || "local"))
    seed = (Math.imul(seed, 31) + c.charCodeAt(0)) >>> 0;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const target = Math.min(8, Math.max(3, Math.ceil(people / 2) + 2)),
    seen = new Set(),
    plans = [];
  for (let attempt = 0; attempt < 30 && plans.length < 3; attempt++) {
    const rank = (d) =>
      (recent.includes(d.id) ? 4 : 0) -
      (likes.some((l) => text(d).includes(l)) ? 3 : 0) +
      d.minutes / 120 +
      random() * 7;
    const sorted = eligible
      .map((d) => ({ d, score: rank(d) }))
      .sort((a, b) => a.score - b.score)
      .map((x) => x.d);
    const count = Math.max(
        2,
        Math.min(sorted.length, target) - (attempt % 3 === 2 ? 1 : 0),
      ),
      picked = [];
    for (const cat of [
      "vegetable",
      ...(!options.vegetarian ? ["protein"] : []),
      "soup",
      "staple",
    ]) {
      const d = sorted.find((d) => d.category === cat);
      if (d && picked.length < count) picked.push(d);
    }
    for (const d of sorted)
      if (picked.length < count && !picked.includes(d)) picked.push(d);
    const fingerprint = picked
      .map((d) => d.id)
      .sort()
      .join(",");
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    plans.push({
      id: "plan-" + (plans.length + 1),
      name: ["省心家常桌", "慢慢吃一桌", "换个口味"][plans.length],
      items: picked.map((d) => ({
        dish_id: d.id,
        name: d.name,
        quantity: Math.min(20, Math.ceil(people / (d.default_serves || 2))),
      })),
      reason: `${picked.length}道菜，按菜谱标注的一份供餐人数建议份量；单道菜最长${Math.max(...picked.map((d) => d.minutes))}分钟，整桌耗时需厨师结合备菜与灶具安排。`,
      warning:
        "按菜类做日常搭配，不是精确营养建议；过敏者需与厨师核实食材及交叉接触。",
    });
  }
  return {
    plans,
    message:
      plans.length < 2
        ? "当前候选只能形成一套不同组合，补充菜谱后会有更多选择。"
        : "",
  };
}
module.exports = { recommend };
