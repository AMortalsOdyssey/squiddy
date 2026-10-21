"use strict";
const { getMany } = require("./collections");
async function activePeople(tx, kitchenId, actors, hash) {
  const users = await getMany(tx, "users", actors);
  const members = hash
    ? await getMany(
        tx,
        "memberships",
        actors.map((a) => hash("member:" + kitchenId + ":" + a)),
      )
    : null;
  return new Map(
    [...users]
      .filter(
        ([actor, user]) =>
          user.status === "active" &&
          (!members ||
            members.get(hash("member:" + kitchenId + ":" + actor))?.status ===
              "active"),
      )
      .map(([actor, user]) => [
        actor,
        {
          ...user,
          active_membership_epoch:
            members?.get(hash("member:" + kitchenId + ":" + actor))?.epoch || 0,
        },
      ]),
  );
}
async function activeParticipants(tx, meal, hash) {
  const people = await activePeople(
    tx,
    meal.kitchen_id,
    meal.participant_ids,
    hash,
  );
  const parts = await getMany(
    tx,
    "meal_memberships",
    meal.participant_ids.map((a) => hash("participant:" + meal.id + ":" + a)),
  );
  const actors = meal.participant_ids.filter(
    (a) =>
      people.has(a) &&
      parts.get(hash("participant:" + meal.id + ":" + a))?.status ===
        "active" &&
      (parts.get(hash("participant:" + meal.id + ":" + a))?.membership_epoch ||
        0) === (people.get(a)?.active_membership_epoch || 0),
  );
  return { actors, people, parts };
}
module.exports = { activePeople, activeParticipants };
