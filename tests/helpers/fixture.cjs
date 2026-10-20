const crypto = require("node:crypto");
const { createService } = require("../../domain/service");
const { createMemoryStore } = require("../../domain/store");
const APP = "wx0000000000000000";
function fixture() {
  let now = 1800000000000;
  const store = createMemoryStore();
  const crypt = {
    hash: (s) => crypto.createHash("sha256").update(s).digest("hex"),
    random: (n) => crypto.randomBytes(n).toString("hex"),
    token: (s) =>
      crypto
        .createHmac("sha256", "test-only-key")
        .update(s)
        .digest("hex")
        .slice(0, 48),
  };
  const service = createService({
    store,
    crypto: crypt,
    expectedAppId: APP,
    clock: () => now,
    moderate: async (content) => {
      if (content.includes("BLOCKED_TEXT"))
        throw Object.assign(new Error("内容未通过审核"), {
          code: "CONTENT_REJECTED",
        });
    },
    media: {
      accept: async (payload, image) => ({
        status: "approved",
        file_id: "local-image-" + image.id,
        width: 400,
        height: 400,
      }),
    },
  });
  let seq = 0;
  const call = (actor, action, payload = {}) =>
    service.execute(
      action,
      {
        ...payload,
        ...(payload.request_id ? {} : { request_id: "req_" + ++seq }),
      },
      { OPENID: actor, APPID: APP },
    );
  const actorId = (a) => crypt.hash(APP + ":" + a);
  return {
    service,
    store,
    call,
    actorId,
    crypt,
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}
async function setup() {
  const f = fixture();
  const { id: kid } = await f.call("chef", "kitchen.create", {
    name: "星期天厨房",
    description: "一起吃好饭",
  });
  const dishes = [];
  for (const [name, category, ingredients, vegetarian] of [
    ["番茄炒蛋", "vegetable", ["番茄", "鸡蛋"], true],
    ["小炒肉", "protein", ["猪肉", "青椒"], false],
    ["莲藕汤", "soup", ["莲藕"], true],
    ["葱油面", "staple", ["面粉", "葱"], true],
    ["拍黄瓜", "vegetable", ["黄瓜", "蒜"], true],
  ]) {
    dishes.push(
      (
        await f.call("chef", "dish.save", {
          kitchen_id: kid,
          name,
          category,
          ingredients,
          allergens: ingredients.includes("鸡蛋") ? ["鸡蛋"] : [],
          ingredient_complete: true,
          default_serves: 2,
          steps: "洗净后烹饪",
          minutes: 15,
          vegetarian,
          spicy: false,
          default_price_minor: 1200,
        })
      ).id,
    );
  }
  const { id: mid } = await f.call("chef", "meal.publish", {
    kitchen_id: kid,
    title: "周末晚饭",
    dish_ids: dishes,
    scheduled_at: f.now() + 7200000,
    cutoff_at: f.now() + 3600000,
  });
  const invitation = await f.call("chef", "invitation.create", {
    meal_id: mid,
  });
  for (const a of ["alice", "bob"])
    await f.call(a, "invitation.accept", { token: invitation.token });
  return { ...f, kid, mid, dishes, invitation };
}
module.exports = { fixture, setup, APP };
