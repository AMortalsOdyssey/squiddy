"use strict";
const { mealDemand, unitPrice } = require("./demand");
const { lineKey } = require("../shared/selection");
const categoryNames = {
  protein: "荤菜",
  vegetable: "素菜",
  soup: "汤羹",
  staple: "主食",
  dessert: "甜点",
};
function dishView(d) {
  return {
    subtitle: d.subtitle || "",
    source_url: d.source_url || "",
    source_label: d.source_label || "",
    step_title: d.step_title || "跟着这样做",
    recipe_steps: (d.recipe_steps || []).map((s) => ({ ...s })),
    variants: (d.variants || []).slice(),
    attributes: (d.attributes || []).map((a) => ({
      name: a.name,
      options: a.options.slice(),
    })),
    nutrition: d.nutrition ? { ...d.nutrition } : null,
    default_serves: d.default_serves || 2,
    ingredient_complete: d.ingredient_complete === true,
    id: d.id,
    name: d.name,
    category: d.category,
    category_id: d.category_id || d.category,
    category_name: d.category_name || categoryNames[d.category],
    ingredients: d.ingredients.slice(),
    steps: d.steps,
    minutes: d.minutes,
    vegetarian: d.vegetarian,
    spicy: d.spicy,
    allergens: d.allergens.slice(),
    image_id: d.image_id || "",
    active: d.active,
    revision: d.revision,
  };
}
function mealSummary(m) {
  return {
    estimated_people: m.estimated_people || 4,
    id: m.id,
    kitchen_id: m.kitchen_id,
    title: m.title,
    status: m.status,
    scheduled_at: m.scheduled_at,
    cutoff_at: m.cutoff_at,
    revision: m.revision,
    plan_confirmed: m.plan_confirmed,
    served: m.items.filter((x) => x.status === "served").length,
  };
}
function quoteView(m, quote, requests = []) {
  let total = 0,
    unknown = 0;
  const items = m.plan_confirmed
    ? m.items
    : mealDemand(m.menu, requests, false).map((r) => ({
        ...r,
        quantity: r.requested_quantity,
        status: "planned",
      }));
  const lines = items
    .filter((x) => x.status !== "skipped" && x.quantity > 0)
    .map((item) => {
      const p = unitPrice(quote, item);
      const subtotal = p === null ? null : p * item.quantity;
      if (subtotal === null) unknown++;
      else total += subtotal;
      return {
        line_id: item.line_id || lineKey(item),
        dish_id: item.dish_id,
        unit_price_minor: p,
        subtotal_minor: subtotal,
      };
    });
  return {
    lines,
    total_known_minor: total,
    unpriced_count: unknown,
    revision: quote?.revision || 0,
  };
}
module.exports = { dishView, mealSummary, quoteView, categoryNames };
