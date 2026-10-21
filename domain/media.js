"use strict";
const { getMany } = require("./collections");
function dishUses(dish, imageId) {
  return (
    dish?.image_id === imageId ||
    dish?.recipe_steps?.some((s) => s.image_id === imageId)
  );
}
async function referencedByKitchen(tx, imageId, kitchen, media) {
  if (!kitchen || kitchen.status !== "active") return false;
  if (media?.references_version === 1)
    return Object.keys(media.references || {}).length > 0;
  if (kitchen.image_id === imageId) return true;
  for (const dish of (await getMany(tx, "dishes", kitchen.dish_ids)).values())
    if (dishUses(dish, imageId)) return true;
  for (let i = 0; i < (kitchen.meal_ids || []).length; i += 80) {
    for (const meal of (
      await getMany(tx, "meals", kitchen.meal_ids.slice(i, i + 80))
    ).values())
      if (meal.menu?.some((dish) => dishUses(dish, imageId))) return true;
  }
  return false;
}
function imageIds(value) {
  const result = new Set();
  function visit(v) {
    if (v && typeof v === "object")
      for (const [key, item] of Object.entries(v)) {
        if (key === "image_id" && typeof item === "string" && item)
          result.add(item);
        else if (item && typeof item === "object") visit(item);
      }
  }
  visit(value);
  return [...result];
}
async function updateReferences(tx, before, after, referenceKey) {
  const old = new Set(imageIds(before)),
    next = new Set(imageIds(after));
  for (const id of new Set([...old, ...next])) {
    if (old.has(id) === next.has(id)) continue;
    const image = await tx.get("media", id);
    if (!image) continue;
    image.references ||= {};
    if (next.has(id)) image.references[referenceKey] = true;
    else delete image.references[referenceKey];
    // Legacy media retain conservative scans until all historical references are known.
    await tx.put("media", id, image);
  }
}
module.exports = { dishUses, referencedByKitchen, updateReferences, imageIds };
