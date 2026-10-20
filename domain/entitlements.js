"use strict";
// Kitchen-scoped policy boundary; no payment provider or paid order is active.
const limits = Object.freeze({
  kitchens: 5,
  members: 30,
  dishes: 80,
  meals: 40,
  menu: 30,
});
function entitlementForKitchen() {
  return { plan: "free", paid: false, limits: { ...limits } };
}
module.exports = { limits, entitlementForKitchen };
