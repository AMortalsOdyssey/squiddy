"use strict";
const { input, text, keys, id } = require("./errors");
function recipeDetails(p, old = {}) {
  old ||= {};
  const take = (key, fallback) =>
    p[key] === undefined ? (old[key] ?? fallback) : p[key];
  const variantInput = take("variants", []),
    attrInput = take("attributes", []),
    stepInput = take("recipe_steps", []);
  input(Array.isArray(variantInput) && variantInput.length <= 8, "规格最多8种");
  const variants = variantInput.map((v) => text(v, 20, "规格"));
  input(new Set(variants).size === variants.length, "规格不可重复");
  input(Array.isArray(attrInput) && attrInput.length <= 5, "属性最多5组");
  const attributes = attrInput.map((a) => {
    keys(a, ["name", "options"]);
    input(
      Array.isArray(a.options) && a.options.length > 0 && a.options.length <= 8,
      "每组属性须有1至8项",
    );
    const options = a.options.map((v) => text(v, 20, "属性选项"));
    input(new Set(options).size === options.length, "属性选项不可重复");
    return { name: text(a.name, 12, "属性名"), options };
  });
  input(
    new Set(attributes.map((a) => a.name)).size === attributes.length,
    "属性名不可重复",
  );
  input(Array.isArray(stepInput) && stepInput.length <= 15, "步骤最多15项");
  const recipe_steps = stepInput.map((s) => {
    keys(s, ["text", "image_id"]);
    return {
      text: text(s.text, 400, "步骤"),
      image_id: s.image_id ? id(s.image_id) : "",
    };
  });
  const source_url = text(take("source_url", ""), 500, "来源链接", true);
  input(
    !source_url ||
      /^https:\/\/[a-zA-Z0-9][a-zA-Z0-9.-]*(?::443)?(?:[/?#][^\s]*)?$/.test(
        source_url,
      ),
    "来源须为完整的 HTTPS 链接",
  );
  let nutrition = take("nutrition", null);
  if (nutrition) {
    keys(nutrition, [
      "visible",
      "source",
      "basis",
      "calories",
      "protein",
      "fat",
      "carbs",
      "fiber",
    ]);
    const out = {
      visible: nutrition.visible === true,
      source: text(nutrition.source, 100, "营养数据来源"),
      basis: text(nutrition.basis, 60, "营养计量依据"),
    };
    for (const k of ["calories", "protein", "fat", "carbs", "fiber"]) {
      const n = nutrition[k];
      input(
        n === null ||
          (typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 10000),
        "营养数值应为0至10000，未知请留空",
      );
      out[k] = n;
    }
    nutrition = out;
  }
  return {
    subtitle: text(take("subtitle", ""), 80, "副标题", true),
    source_url,
    step_title: text(take("step_title", "跟着这样做"), 30, "做法标题"),
    recipe_steps,
    variants,
    attributes,
    nutrition,
  };
}
function selectionDetails(i, d) {
  const variant = i.variant || "",
    options = i.options || [];
  input(
    typeof variant === "string" &&
      (!variant || (d.variants || []).includes(variant)),
    "规格已变化，请重新选择",
  );
  input(Array.isArray(options) && options.length <= 5, "口味选项不正确");
  const seen = new Set();
  for (const a of options) {
    keys(a, ["name", "value"]);
    input(
      typeof a.name === "string" &&
        typeof a.value === "string" &&
        !seen.has(a.name) &&
        (d.attributes || []).some(
          (g) => g.name === a.name && g.options.includes(a.value),
        ),
      "口味已变化，请重新选择",
    );
    seen.add(a.name);
  }
  return {
    ...(variant ? { variant } : {}),
    ...(options.length ? { options: options.map((a) => ({ ...a })) } : {}),
  };
}
module.exports = { recipeDetails, selectionDetails };
