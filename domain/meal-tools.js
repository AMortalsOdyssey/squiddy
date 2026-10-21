"use strict";
const {
  input,
  ensure,
  text,
  keys,
  revision,
  id,
  integer,
} = require("./errors");
const { lineKey, lineLabel } = require("../shared/selection");
const { activePeople, activeParticipants } = require("./people");
const reviewTags = [
  "下次还想吃",
  "刚刚好",
  "淡一点",
  "辣一点",
  "少辣一点",
  "量少一点",
  "量多一点",
];
const writableTools = [
  "shopping.generate",
  "shopping.add",
  "shopping.update",
  "shopping.check",
  "shopping.claim",
  "shopping.remove",
  "meal.review.save",
];
function planSignature(m, hash) {
  return hash(
    JSON.stringify(
      (m.items || [])
        .filter((i) => i.status !== "skipped" && i.quantity > 0)
        .map((i) => [i.line_id || lineKey(i), i.quantity])
        .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    ),
  );
}
function clearActor(m, actor) {
  if (m.reviews)
    for (const [key, r] of Object.entries(m.reviews))
      if ((r.actor || key) === actor) delete m.reviews[key];
  if (m.shopping)
    for (const i of m.shopping.items) {
      if (i.claimed_by === actor) i.claimed_by = "";
      if (i.created_by === actor) i.created_by = "";
    }
  if (m.shopping) m.shopping.revision++;
}
async function shoppingView(m, actor, tx, hash) {
  const s = m.shopping || { revision: 0, items: [], signature: "" };
  const names = new Map();
  const visible = hash ? await activeParticipants(tx, m, hash) : null;
  for (const a of new Set(s.items.map((i) => i.claimed_by).filter(Boolean))) {
    if (visible && !visible.actors.includes(a)) continue;
    const user = visible ? visible.people.get(a) : await tx.get("users", a);
    if (user?.status === "active") names.set(a, user.name || "厨房朋友");
  }
  return {
    revision: s.revision,
    can_change: m.status !== "cancelled" && m.final_status !== "cancelled",
    can_generate:
      m.cook_id === actor &&
      m.plan_confirmed &&
      !["cancelled"].includes(m.status) &&
      m.final_status !== "cancelled",
    stale:
      !!s.signature &&
      (!m.plan_confirmed || s.signature !== planSignature(m, hash)),
    generated: !!s.signature,
    lines: s.lines || [
      ...new Map(
        s.items.flatMap((i) => (i.sources || []).map((r) => [r.line_id, r])),
      ).values(),
    ],
    items: s.items.map((i) => ({
      id: i.id,
      name: i.name,
      amount: i.amount,
      note: i.note,
      checked: i.checked,
      manual: i.manual,
      sources: (i.sources || []).map((r) => ({
        line_id: r.line_id,
        quantity: r.quantity,
      })),
      claimed_name: names.get(i.claimed_by) || "",
      claimed_by_me: i.claimed_by === actor,
      can_edit: m.cook_id === actor || i.created_by === actor,
      can_release: m.cook_id === actor || i.claimed_by === actor,
    })),
  };
}
async function reviewView(m, actor, tx, offset = 0, hash) {
  const served = m.items
    .filter((i) => i.status === "served")
    .map((i) => ({
      line_id: i.line_id || lineKey(i),
      name: lineLabel(i.name, i),
      quantity: i.quantity,
    }));
  const available =
    ["completed", "archived"].includes(m.status) &&
    m.final_status !== "cancelled" &&
    served.length > 0;
  const entries = Object.entries(m.reviews || {}).map(([key, r]) => [
    r.actor || key,
    r,
  ]);
  const own = entries.find(([a]) => a === actor)?.[1] || {
    revision: 0,
    note: "",
    items: [],
  };
  const feedback = [];
  const visible = hash ? await activeParticipants(tx, m, hash) : null;
  const people =
    visible?.people ||
    (await activePeople(
      tx,
      m.kitchen_id,
      entries.map(([a]) => a),
    ));
  const submitted = entries.filter(([a]) =>
    visible
      ? visible.actors.includes(a)
      : m.participant_ids.includes(a) && people.has(a),
  );
  if (m.cook_id === actor)
    for (const [a, r] of submitted.slice(offset, offset + 5)) {
      if (!m.participant_ids.includes(a)) continue;
      feedback.push({
        name: people.get(a)?.name || "厨房朋友",
        note: r.note,
        items: r.items
          .filter((i) => served.some((d) => d.line_id === i.line_id))
          .map((i) => ({ ...i })),
      });
    }
  return {
    available,
    can_read_all: m.cook_id === actor,
    tags: reviewTags,
    served,
    own: {
      revision: own.revision,
      note: own.note,
      items: own.items.filter((i) =>
        served.some((d) => d.line_id === i.line_id),
      ),
    },
    feedback,
    feedback_total: m.cook_id === actor ? submitted.length : 0,
  };
}
async function handleTool(action, p, { m, actor, tx, now, newId, hash }) {
  if (action === "shopping.read") {
    keys(p, ["meal_id", "request_id"]);
    return shoppingView(m, actor, tx, hash);
  }
  if (action === "meal.review.read") {
    keys(p, ["meal_id", "request_id", "feedback_offset"]);
    const offset =
      p.feedback_offset === undefined
        ? 0
        : integer(p.feedback_offset, 0, 30, "反馈页码");
    return reviewView(m, actor, tx, offset, hash);
  }
  if (action === "meal.review.save") {
    keys(p, ["meal_id", "request_id", "expected_revision", "note", "items"]);
    const view = await reviewView(m, actor, tx, 0, hash);
    ensure(
      view.available,
      "INVALID_STATE",
      "饭局结束且有菜上桌后，才能留下饭后反馈",
    );
    revision(p.expected_revision, view.own.revision);
    input(Array.isArray(p.items) && p.items.length <= 80, "反馈条目过多");
    const seen = new Set();
    const items = p.items.map((i) => {
      keys(i, ["line_id", "tags", "note"]);
      input(
        view.served.some((d) => d.line_id === i.line_id) &&
          !seen.has(i.line_id),
        "只能评价本餐已上桌的菜，且不可重复",
      );
      seen.add(i.line_id);
      input(
        Array.isArray(i.tags) &&
          i.tags.length <= 3 &&
          new Set(i.tags).size === i.tags.length &&
          i.tags.every((t) => reviewTags.includes(t)),
        "每道菜最多选择3个反馈标签",
      );
      return {
        line_id: i.line_id,
        tags: i.tags.slice(),
        note: text(i.note || "", 60, "单菜反馈", true),
      };
    });
    m.reviews = m.reviews || {};
    delete m.reviews[actor]; // Compatibility with the early development shape.
    m.reviews[actor.slice(0, 32)] = {
      actor,
      revision: view.own.revision + 1,
      note: text(p.note || "", 300, "饭后留言", true),
      items,
      updated_at: now,
    };
    await tx.put("meals", m.id, m);
    return { revision: view.own.revision + 1 };
  }
  if (!action.startsWith("shopping.")) return undefined;
  const s = m.shopping || { revision: 0, items: [], signature: "" };
  revision(p.expected_revision, s.revision);
  ensure(
    m.status !== "cancelled" && m.final_status !== "cancelled",
    "INVALID_STATE",
    "已取消的饭局不能修改购物清单",
  );
  const cook = m.cook_id === actor;
  if (action === "shopping.generate") {
    keys(p, ["meal_id", "request_id", "expected_revision"]);
    ensure(cook, "FORBIDDEN", "只有接单厨师可按制作计划生成清单");
    ensure(
      m.plan_confirmed,
      "INVALID_STATE",
      "请先确认实际制作计划，再生成采购清单",
    );
    const groups = new Map();
    for (const i of m.items.filter(
      (i) => i.quantity > 0 && i.status !== "skipped",
    )) {
      const d = m.menu.find((d) => d.id === i.dish_id);
      for (const ingredient of d?.ingredients || []) {
        const name = ingredient.trim().replace(/\s+/g, " ");
        if (!groups.has(name)) groups.set(name, []);
        const sources = groups.get(name);
        const lid = i.line_id || lineKey(i);
        if (!sources.some((s) => s.line_id === lid))
          sources.push({ line_id: lid, quantity: i.quantity });
      }
    }
    const items = [...groups].map(([name, sources]) => {
      const old = s.items.find((i) => !i.manual && i.name === name);
      return {
        ...(old || {
          id: newId(),
          amount: "",
          note: "",
          checked: false,
          claimed_by: "",
          created_by: actor,
        }),
        name,
        sources,
        manual: false,
      };
    });
    items.push(...s.items.filter((i) => i.manual));
    input(items.length <= 200, "采购项目超过200项，请减少菜单或手动整理");
    s.items = items;
    s.lines = m.items
      .filter((i) => i.quantity > 0 && i.status !== "skipped")
      .map((i) => ({
        line_id: i.line_id || lineKey(i),
        name: lineLabel(i.name, i),
        quantity: i.quantity,
      }));
    s.signature = planSignature(m, hash);
  } else if (action === "shopping.add") {
    keys(p, [
      "meal_id",
      "request_id",
      "expected_revision",
      "name",
      "amount",
      "note",
    ]);
    input(s.items.length < 200, "购物清单最多200项");
    s.items.push({
      id: newId(),
      name: text(p.name, 80, "食材"),
      amount: text(p.amount || "", 40, "采购量", true),
      note: text(p.note || "", 100, "采购备注", true),
      checked: false,
      manual: true,
      sources: [],
      claimed_by: "",
      created_by: actor,
    });
  } else {
    const i = s.items.find((i) => i.id === id(p.item_id));
    input(i, "采购项目已不存在，请刷新");
    if (action === "shopping.update") {
      keys(p, [
        "meal_id",
        "request_id",
        "expected_revision",
        "item_id",
        "name",
        "amount",
        "note",
      ]);
      ensure(
        cook || i.created_by === actor,
        "FORBIDDEN",
        "仅接单厨师或添加者能编辑此项目",
      );
      if (i.manual) i.name = text(p.name, 80, "食材");
      else input(p.name === i.name, "自动生成的食材名称请在菜谱中调整");
      i.amount = text(p.amount || "", 40, "采购量", true);
      i.note = text(p.note || "", 100, "采购备注", true);
    } else if (action === "shopping.check") {
      keys(p, [
        "meal_id",
        "request_id",
        "expected_revision",
        "item_id",
        "checked",
      ]);
      input(typeof p.checked === "boolean");
      i.checked = p.checked;
    } else if (action === "shopping.claim") {
      keys(p, [
        "meal_id",
        "request_id",
        "expected_revision",
        "item_id",
        "claimed",
      ]);
      input(typeof p.claimed === "boolean");
      if (
        i.claimed_by &&
        !(await activeParticipants(tx, m, hash)).actors.includes(i.claimed_by)
      )
        i.claimed_by = "";
      ensure(
        !i.claimed_by || i.claimed_by === actor || (cook && !p.claimed),
        "CONFLICT",
        "这项已有朋友认领，请刷新",
      );
      i.claimed_by = p.claimed ? actor : "";
    } else if (action === "shopping.remove") {
      keys(p, ["meal_id", "request_id", "expected_revision", "item_id"]);
      ensure(
        cook || i.created_by === actor,
        "FORBIDDEN",
        "仅接单厨师或添加者能移除此项目",
      );
      s.items = s.items.filter((x) => x.id !== i.id);
    } else input(false, "不支持的清单操作");
  }
  s.revision++;
  m.shopping = s;
  await tx.put("meals", m.id, m);
  return { revision: s.revision };
}
module.exports = {
  handleTool,
  shoppingView,
  reviewView,
  clearActor,
  writableTools,
};
