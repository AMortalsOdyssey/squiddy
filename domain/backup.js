"use strict";
const { input } = require("./errors");
const { getMany } = require("./collections");
const { historyPage } = require("./history");
const { dishView } = require("./views");
async function readBackup(
  p,
  { tx, actor, user, kitchenAccess, readMeal, participantKey, hash },
) {
  const { kitchen: k, member } = await kitchenAccess(tx, p.kitchen_id, actor);
  const section = p.section || "kitchen";
  if (section === "kitchen")
    return {
      format: "squiddy-kitchen-backup-v1",
      exported_at: Date.now(),
      personal: {
        name: user.name,
        favorite_recipe_ids: (user.favorite_recipe_ids || []).slice(),
      },
      kitchen: {
        source_id: k.id,
        name: k.name,
        description: k.description,
        categories: k.categories || [],
        image_id: k.image_id || "",
        revision: k.revision,
      },
      counts: { dishes: k.dish_ids.length, meals: k.meal_ids.length },
      scope: {
        role: member.role,
        prices: member.cook_access === true || member.role === "cook",
        history:
          "Only meals you can currently access; no member credentials or invitation tokens",
      },
    };
  if (section === "dishes") {
    const at = p.cursor ? k.dish_ids.indexOf(p.cursor) : -1;
    input(!p.cursor || at >= 0, "菜谱已变化，请重新备份");
    const ids = k.dish_ids.slice(at + 1, at + 11);
    const data = await getMany(tx, "dishes", ids);
    const canPrice = member.cook_access === true || member.role === "cook";
    const prices = canPrice ? await getMany(tx, "dish_prices", ids) : new Map();
    return {
      items: ids
        .filter(
          (id) =>
            data.has(id) && (data.get(id).active || member.role !== "member"),
        )
        .map((id) => {
          const dish = dishView(data.get(id));
          if (canPrice) {
            dish.default_price_minor = prices.get(id)?.value ?? null;
            dish.default_variant_prices = prices.get(id)?.variants || [];
          }
          return dish;
        }),
      next_cursor:
        at + 1 + ids.length < k.dish_ids.length ? ids.at(-1) || "" : "",
    };
  }
  input(section === "meals", "未知备份内容");
  const page = historyPage(k, p.cursor || "", 1);
  const items = [];
  for (const mid of page.ids) {
    const part = await tx.get("meal_memberships", participantKey(mid, actor));
    if (
      part?.status === "active" &&
      (part.membership_epoch || 0) === (member.epoch || 0)
    ) {
      const meal = await tx.get("meals", mid);
      if (!meal) continue;
      items.push({
        ...(await readMeal(tx, mid, actor)),
        shopping: await require("./meal-tools").shoppingView(
          meal,
          actor,
          tx,
          hash,
        ),
        own_review: (
          await require("./meal-tools").reviewView(meal, actor, tx, 0, hash)
        ).own,
      });
    }
  }
  return { items, next_cursor: page.next_cursor };
}
module.exports = { readBackup };
