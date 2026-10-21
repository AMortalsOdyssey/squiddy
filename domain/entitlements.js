"use strict";
// Kitchen-scoped policy boundary; no payment provider or paid order is active.
const limits = Object.freeze({
  kitchens: 5,
  members: 30,
  dishes: 80,
  active_meals: 40,
  menu: 30,
  selection_lines: 60,
  meal_lines: 80,
  shopping_items: 200,
});
function entitlementForKitchen() {
  return { plan: "free", paid: false, limits: { ...limits } };
}
module.exports = { limits, entitlementForKitchen };
