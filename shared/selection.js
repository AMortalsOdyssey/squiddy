"use strict";
// Pure helpers shared by the cloud domain and the native client.
const { sha256 } = require("./hash");
function orderedOptions(options = []) {
  return options
    .map((o) => ({ name: o.name, value: o.value }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
function lineKey(i) {
  const options = orderedOptions(i.options || []),
    variant = i.variant || "";
  return !variant && !options.length
    ? i.dish_id
    : "l" +
        sha256(
          JSON.stringify([
            i.dish_id,
            variant,
            options.map((o) => [o.name, o.value]),
          ]),
        ).slice(0, 31);
}
function priceKey(i) {
  return lineKey({ dish_id: i.dish_id, variant: i.variant || "" });
}
function lineLabel(name, i) {
  const parts = [
    i.variant,
    ...(i.options || []).map((o) => o.name + "：" + o.value),
  ].filter(Boolean);
  return name + (parts.length ? "（" + parts.join("，") + "）" : "");
}
function dishQuantity(items, id) {
  return items
    .filter((i) => i.dish_id === id)
    .reduce((n, i) => n + i.quantity, 0);
}
module.exports = { lineKey, priceKey, lineLabel, orderedOptions, dishQuantity };
