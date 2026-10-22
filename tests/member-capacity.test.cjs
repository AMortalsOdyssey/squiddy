const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./helpers/fixture.cjs");

test("30名成员同时点菜，31人被拒绝且事务不残留；离开后名额释放且私人选择立即隐藏", async () => {
  const f = await setup();
  const actors = [
    "alice",
    "bob",
    ...Array.from({ length: 27 }, (_, i) => "capacity" + i),
  ];
  for (const actor of actors.slice(2))
    await f.call(actor, "invitation.accept", { token: f.invitation.token });
  for (const actor of actors)
    await f.call(actor, "selection.replace", {
      meal_id: f.mid,
      expected_revision: 0,
      items: [{ dish_id: f.dishes[0], quantity: 1 }],
      people: 1,
      note: "capacity-private-" + actor,
    });
  let meal = await f.call("chef", "meal.read", { meal_id: f.mid });
  assert.equal(meal.participant_count, 30);
  assert.equal(meal.requests.length, 29);
  assert.equal(meal.summary[0].requested_quantity, 29);
  await assert.rejects(
    f.call("thirtyone", "invitation.accept", { token: f.invitation.token }),
    (e) => e.code === "INVALID_INPUT" && /厨房人数已满/.test(e.message),
  );
  assert.equal(f.store.snapshot().users[f.actorId("thirtyone")], undefined);
  assert.equal(
    (await f.call("chef", "kitchen.read", { kitchen_id: f.kid })).members
      .length,
    30,
  );
  await f.call("alice", "kitchen.leave", { kitchen_id: f.kid });
  meal = await f.call("chef", "meal.read", { meal_id: f.mid });
  assert.equal(meal.participant_count, 29);
  assert.equal(meal.requests.length, 28);
  assert.ok(!JSON.stringify(meal).includes("capacity-private-alice"));
  await f.call("thirtyone", "invitation.accept", { token: f.invitation.token });
  assert.equal(
    (await f.call("chef", "kitchen.read", { kitchen_id: f.kid })).members
      .length,
    30,
  );
  assert.equal(
    (await f.call("chef", "meal.read", { meal_id: f.mid })).participant_count,
    30,
  );
});
