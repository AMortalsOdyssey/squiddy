"use strict";
const { selectionDetails } = require("./recipe-details");
const { lineKey, lineLabel, priceKey } = require("../shared/selection");
function selectionRows(menu, items = []) {
  return items.map((i) => {
    const d = menu.find((d) => d.id === i.dish_id);
    if (!d) return { ...i, line_id: i.line_id || lineKey(i) };
    const details = selectionDetails(i, d);
    const row = { dish_id: i.dish_id, quantity: i.quantity, ...details };
    return { ...row, line_id: lineKey(row) };
  });
}
function mealDemand(menu, requests = [], includeEmpty = true) {
  const rows = new Map();
  for (const request of requests) {
    const seen = new Set();
    for (const i of selectionRows(menu, request.items)) {
      const d = menu.find((d) => d.id === i.dish_id);
      if (!d) continue;
      if (!rows.has(i.line_id))
        rows.set(i.line_id, {
          ...i,
          name: lineLabel(d.name, i),
          people: 0,
          requested_quantity: 0,
        });
      const r = rows.get(i.line_id);
      r.requested_quantity += i.quantity;
      if (!seen.has(i.line_id)) {
        r.people += request.people || 1;
        seen.add(i.line_id);
      }
    }
  }
  if (includeEmpty)
    for (const d of menu)
      if (![...rows.values()].some((r) => r.dish_id === d.id)) {
        const r = selectionRows(menu, [{ dish_id: d.id, quantity: 0 }])[0];
        rows.set(r.line_id, {
          ...r,
          name: lineLabel(d.name, r),
          people: 0,
          requested_quantity: 0,
        });
      }
  return [...rows.values()];
}
function unitPrice(quote, row) {
  const prices = quote?.prices || {};
  for (const key of [row.line_id || lineKey(row), priceKey(row), row.dish_id])
    if (Object.prototype.hasOwnProperty.call(prices, key))
      return prices[key] ?? null;
  return null;
}
module.exports = { selectionRows, mealDemand, unitPrice };
