"use strict";
const {
  AppError,
  ensure,
  input,
  text,
  integer,
  id,
  revision,
  keys,
} = require("./errors");
const { dishView, mealSummary, quoteView, categoryNames } = require("./views");
const { recommend } = require("./recommend");
const { limits, entitlementForKitchen } = require("./entitlements");
const { getMany } = require("./collections");
const { activeMealIds, updateActiveMeal, historyPage } = require("./history");
const { readBackup } = require("./backup");
const { updateReferences } = require("./media");
const { activePeople, activeParticipants } = require("./people");
const { categories, validateCategories } = require("./categories");
const { recipes, findRecipe } = require("./library");
const { recipeDetails, selectionDetails } = require("./recipe-details");
const { selectionRows, mealDemand, unitPrice } = require("./demand");
const {
  lineKey,
  priceKey,
  lineLabel,
  dishQuantity,
} = require("../shared/selection");
const {
  handleTool,
  shoppingView,
  reviewView,
  clearActor,
  writableTools,
} = require("./meal-tools");
const writable = new Set([
  ...writableTools,
  "feedback.submit",
  "backup.restoreKitchen",
  "backup.restoreDish",
  "item.undo",
  "kitchen.update",
  "profile.update",
  "kitchen.create",
  "kitchen.close",
  "kitchen.leave",
  "member.role",
  "meal.assignCook",
  "member.remove",
  "dish.save",
  "category.save",
  "dish.reorder",
  "library.favorite",
  "library.wish",
  "library.import",
  "meal.publish",
  "invitation.create",
  "invitation.revoke",
  "invitation.revokeAll",
  "invitation.accept",
  "selection.replace",
  "meal.lock",
  "meal.unlock",
  "meal.cancel",
  "plan.confirm",
  "item.transition",
  "price.update",
  "meal.archive",
  "account.delete",
  "notification.optin",
  "media.prepare",
  "media.complete",
  "share.create",
  "share.revoke",
  "share.revokeAll",
]);
function createService({
  store,
  crypto,
  clock = () => Date.now(),
  moderate = async () => {
    throw new AppError("NOT_CONFIGURED", "内容审核尚未配置");
  },
  media = null,
  notificationConfig = null,
  expectedAppId,
}) {
  const key = (...parts) => crypto.hash(parts.join(":"));
  const newId = () => crypto.random(12);
  const load = async (tx, collection, docId) => {
    const value = await tx.get(collection, docId);
    ensure(value, "NOT_FOUND", "内容不存在或无权查看");
    return value;
  };
  const memberKey = (k, a) => key("member", k, a),
    participantKey = (m, a) => key("participant", m, a);
  async function kitchenAccess(tx, kid, actor, roles) {
    const kitchen = await load(tx, "kitchens", id(kid));
    const member = await tx.get("memberships", memberKey(kid, actor));
    ensure(
      kitchen.status === "active" && member?.status === "active",
      "NOT_FOUND",
      "内容不存在或无权查看",
    );
    if (roles)
      ensure(
        roles.includes(member.role),
        "FORBIDDEN",
        "只有厨房管理员可以操作",
      );
    return { kitchen, member };
  }
  async function mealAccess(tx, mid, actor, cook = false) {
    const meal = await load(tx, "meals", id(mid));
    const { kitchen, member } = await kitchenAccess(tx, meal.kitchen_id, actor);
    const participant = await tx.get(
      "meal_memberships",
      participantKey(mid, actor),
    );
    ensure(
      participant?.status === "active" &&
        (participant.membership_epoch || 0) === (member.epoch || 0),
      "NOT_FOUND",
      "内容不存在或无权查看",
    );
    if (cook)
      ensure(
        participant.role === "cook",
        "FORBIDDEN",
        "只有本餐接单厨师可以操作",
      );
    return { meal, kitchen, member, participant };
  }
  async function currentChoices(tx, m) {
    const { actors } = await activeParticipants(tx, m, crypto.hash);
    return [
      ...(
        await getMany(
          tx,
          "selections",
          actors.map((a) => key(m.id, a)),
        )
      ).values(),
    ];
  }
  async function readMeal(tx, mid, actor) {
    const { meal, participant } = await mealAccess(tx, mid, actor);
    if (meal.status === "open" && clock() >= meal.cutoff_at) {
      meal.status = "locked";
      meal.revision++;
      await tx.put("meals", mid, meal);
    }
    const own = await tx.get("selections", key(mid, actor));
    const response = {
      can_undo:
        participant.role === "cook" &&
        !!meal.last_transition &&
        meal.status !== "archived",
      ...mealSummary(meal),
      role: participant.role,
      menu: meal.menu.map(dishView),
      items: meal.items.map((i) => ({
        line_id: i.line_id || lineKey(i),
        ...(i.variant ? { variant: i.variant } : {}),
        ...(i.options ? { options: i.options } : {}),
        dish_id: i.dish_id,
        name: lineLabel(i.name, i),
        quantity: i.quantity,
        status: i.status,
        requested_people: i.requested_people,
        reason: i.reason || "",
      })),
      selection: {
        items: selectionRows(meal.menu, own?.items || []),
        note: own?.note || "",
        people: own?.people || 1,
        revision: own?.revision || 0,
      },
      participant_count: 0,
    };
    const { actors, people, parts } = await activeParticipants(
      tx,
      meal,
      crypto.hash,
    );
    response.participant_count = actors.length;
    if (participant.role === "cook") {
      const selections = [];
      const choices = await getMany(
        tx,
        "selections",
        meal.participant_ids.map((a) => key(mid, a)),
      );
      response.cook_candidates = [];
      for (const a of actors) {
        const p = parts.get(participantKey(mid, a));
        if (p?.status !== "active" || people.get(a)?.status !== "active")
          continue;
        if (a !== actor) {
          const candidate = people.get(a);
          if (candidate?.status === "active")
            response.cook_candidates.push({ id: a, name: candidate.name });
        }
        const s = choices.get(key(mid, a));
        if (s) {
          const user = people.get(a);
          selections.push({
            name: user?.name || "一位朋友",
            items: selectionRows(meal.menu, s.items),
            note: s.note,
            people: s.people || 1,
          });
        }
      }
      const quote = await tx.get("meal_prices", mid);
      response.requests = selections;
      response.chef_quote = quoteView(meal, quote, selections);
      const demand = mealDemand(meal.menu, selections);
      response.chef_prices = demand.map((r) => ({
        line_id: r.line_id,
        dish_id: r.dish_id,
        name: r.name,
        unit_price_minor: unitPrice(quote, r),
      }));
      response.summary = demand;
    }
    return response;
  }
  async function execute(action, payload, context) {
    ensure(expectedAppId, "NOT_CONFIGURED", "服务尚未配置");
    ensure(
      context?.OPENID && context.APPID === expectedAppId && !context.FROM_APPID,
      "UNAUTHORIZED",
      "请使用本小程序登录",
    );
    input(payload && typeof payload === "object" && !Array.isArray(payload));
    const actor = key(expectedAppId, context.OPENID),
      now = clock();
    const req = writable.has(action) ? id(payload.request_id) : "";
    if (action === "account.deletionStatus")
      return store.transaction(async (tx) => ({
        status: (await tx.get("deletion_jobs", actor))?.status || "none",
      }));
    if (action === "media.complete") {
      ensure(media, "NOT_CONFIGURED", "图片服务尚未配置");
      const receiptId = key(actor, action, req),
        fingerprint = key(JSON.stringify(payload));
      const prepared = await store.transaction(async (tx) => {
        const u = await tx.get("users", actor);
        ensure(u?.status === "active", "UNAUTHORIZED", "账号不可用");
        const image = await load(tx, "media", id(payload.media_id));
        await kitchenAccess(tx, image.kitchen_id, actor, ["owner", "cook"]);
        ensure(image.actor === actor, "FORBIDDEN", "图片不属于你");
        const receipt = await tx.get("receipts", receiptId);
        if (receipt) {
          ensure(
            receipt.fingerprint === fingerprint,
            "IDEMPOTENCY_CONFLICT",
            "操作内容已变化",
          );
          return { result: receipt.result };
        }
        if (image.status === "uploading" && image.upload_request === req)
          return { result: { id: image.id, status: "uploading" } };
        ensure(
          image.status === "awaiting_upload" && now < image.expires_at,
          "INVALID_IMAGE",
          "图片上传任务已失效，请重新选择",
        );
        image.status = "uploading";
        image.upload_request = req;
        await tx.put("media", image.id, image);
        return { image };
      });
      if (prepared.result) return prepared.result;
      let uploaded;
      try {
        uploaded = await media.accept(payload, prepared.image, context);
      } catch (error) {
        await store.transaction(async (tx) => {
          const image = await tx.get("media", prepared.image.id);
          if (image?.status === "uploading") {
            image.status = "failed";
            await tx.put("media", image.id, image);
          }
        });
        throw error;
      }
      return store.transaction(async (tx) => {
        const image = await load(tx, "media", prepared.image.id);
        const u = await tx.get("users", actor);
        ensure(u?.status === "active", "UNAUTHORIZED", "账号不可用");
        await kitchenAccess(tx, image.kitchen_id, actor, ["owner", "cook"]);
        ensure(
          image.status === "uploading" && image.upload_request === req,
          "INVALID_STATE",
          "上传状态已变化",
        );
        image.status = uploaded.status === "approved" ? "approved" : "pending";
        Object.assign(image, {
          file_id: uploaded.file_id,
          trace_id: uploaded.trace_id || "",
          width: uploaded.width,
          height: uploaded.height,
        });
        await tx.put("media", image.id, image);
        if (image.trace_id)
          await tx.put("media_traces", image.trace_id, {
            media_id: image.id,
            kitchen_id: image.kitchen_id,
            actor,
            membership_epoch: image.membership_epoch || 0,
          });
        const result = { id: image.id, status: image.status };
        await tx.put("receipts", receiptId, {
          actor,
          action,
          fingerprint,
          result,
          created_at: now,
        });
        return result;
      });
    }
    // Check human text before a transaction; the production adapter fails closed if moderation is unavailable.
    const textByAction = {
      "shopping.add": [payload.name, payload.amount, payload.note],
      "shopping.update": [payload.name, payload.amount, payload.note],
      "meal.review.save": [
        payload.note,
        ...(Array.isArray(payload.items) ? payload.items : []).map(
          (i) => i?.note,
        ),
      ],
      "feedback.submit": [payload.message],
      "item.undo": [payload.reason],
      "item.transition": [payload.reason],
      "plan.confirm": [
        (Array.isArray(payload.items) ? payload.items : [])
          .map((i) => i.reason || "")
          .join("\n"),
      ],
      "kitchen.update": [payload.name, payload.description],
      "profile.update": [payload.name],
      "kitchen.create": [payload.name, payload.description],
      "backup.restoreKitchen": [payload.name, payload.description],
      "category.save": (Array.isArray(payload.categories)
        ? payload.categories
        : []
      ).map((c) => c?.name),
      "dish.save": [
        payload.name,
        payload.subtitle,
        payload.source_url,
        payload.step_title,
        payload.nutrition?.source,
        payload.nutrition?.basis,
        ...(Array.isArray(payload.variants) ? payload.variants : []),
        ...(Array.isArray(payload.attributes)
          ? payload.attributes
          : []
        ).flatMap((a) => [
          a?.name,
          ...(Array.isArray(a?.options) ? a.options : []),
        ]),
        ...(Array.isArray(payload.recipe_steps)
          ? payload.recipe_steps
          : []
        ).map((s) => s?.text),
        payload.steps,
        ...(Array.isArray(payload.ingredients) ? payload.ingredients : []),
        ...(Array.isArray(payload.allergens) ? payload.allergens : []),
      ],
      "meal.publish": [payload.title],
      "selection.replace": [payload.note],
    };
    if (action === "backup.restoreDish")
      textByAction[action] = textByAction["dish.save"];
    if (textByAction[action]) {
      const content = textByAction[action]
        .filter((x) => typeof x === "string" && x.trim())
        .join("\n");
      input(content.length <= 6000, "文字内容过长");
      if (content)
        for (let offset = 0; offset < content.length; offset += 2000)
          await moderate(content.slice(offset, offset + 2200), context.OPENID);
    }
    return store.transaction(async (tx) => {
      let user = await tx.get("users", actor);
      if (!user) {
        user = {
          id: actor,
          name: "厨房朋友",
          kitchen_ids: [],
          status: "active",
          openid: context.OPENID,
          created_at: now,
        };
        await tx.put("users", actor, user);
      }
      ensure(user.status === "active", "ACCOUNT_DELETED", "此账号已注销");
      // Reauthorize even on idempotent replay. A revoked actor cannot replay a privileged receipt.
      if (payload.meal_id)
        await mealAccess(
          tx,
          payload.meal_id,
          actor,
          [
            "invitation.create",
            "invitation.revokeAll",
            "share.revokeAll",
            "meal.lock",
            "meal.unlock",
            "meal.cancel",
            "plan.confirm",
            "item.transition",
            "price.update",
            "meal.archive",
            "share.create",
            "item.undo",
            "shopping.generate",
          ].includes(action),
        );
      else if (payload.kitchen_id && action !== "invitation.accept")
        await kitchenAccess(
          tx,
          payload.kitchen_id,
          actor,
          [
            "kitchen.close",
            "kitchen.update",
            "member.role",
            "member.remove",
          ].includes(action)
            ? ["owner"]
            : [
                  "dish.save",
                  "category.save",
                  "dish.reorder",
                  "library.import",
                ].includes(action)
              ? ["owner", "cook"]
              : undefined,
        );
      const receiptKey = req ? key(actor, action, req) : "";
      const fingerprint = req ? key(JSON.stringify(payload)) : "";
      if (req) {
        const receipt = await tx.get("receipts", receiptKey);
        if (receipt) {
          ensure(
            receipt.fingerprint === fingerprint,
            "IDEMPOTENCY_CONFLICT",
            "这次操作内容已变化，请重新操作",
          );
          return action === "invitation.create"
            ? { ...receipt.result, token: crypto.token(actor + ":" + req) }
            : receipt.result;
        }
      }
      let result;
      switch (action) {
        case "shopping.read":
        case "shopping.generate":
        case "shopping.add":
        case "shopping.update":
        case "shopping.check":
        case "shopping.claim":
        case "shopping.remove":
        case "meal.review.read":
        case "meal.review.save": {
          const { meal: m } = await mealAccess(tx, payload.meal_id, actor);
          result = await handleTool(action, payload, {
            m,
            actor,
            tx,
            now,
            newId,
            hash: crypto.hash,
          });
          break;
        }
        case "library.read": {
          keys(payload, ["request_id", "kitchen_id"]);
          const access = payload.kitchen_id
            ? await kitchenAccess(tx, payload.kitchen_id, actor)
            : null;
          const k = access?.kitchen;
          const wishes = (k?.wishes || []).filter((w) =>
            k.member_ids.includes(w.actor),
          );
          result = {
            can_import: !!access && access.member.role !== "member",
            kitchen_revision: k?.revision || 0,
            recipes: recipes.map((r) => ({
              ...r,
              category_name: categoryNames[r.category],
              favorite: (user.favorite_recipe_ids || []).includes(r.id),
              wished: wishes.some(
                (w) => w.actor === actor && w.recipe_id === r.id,
              ),
              wish_count: wishes.filter((w) => w.recipe_id === r.id).length,
              in_kitchen: !!k?.library_imports?.[r.id],
            })),
          };
          break;
        }
        case "library.favorite": {
          keys(payload, ["request_id", "recipe_id", "favorite"]);
          const r = findRecipe(payload.recipe_id);
          input(!!r && typeof payload.favorite === "boolean", "菜谱不存在");
          user.favorite_recipe_ids = (user.favorite_recipe_ids || []).filter(
            (x) => x !== r.id,
          );
          if (payload.favorite) user.favorite_recipe_ids.push(r.id);
          await tx.put("users", actor, user);
          result = { favorite: payload.favorite };
          break;
        }
        case "library.wish": {
          keys(payload, [
            "request_id",
            "kitchen_id",
            "recipe_id",
            "wished",
            "expected_revision",
          ]);
          const { kitchen: k } = await kitchenAccess(
            tx,
            payload.kitchen_id,
            actor,
          );
          revision(payload.expected_revision, k.revision);
          const r = findRecipe(payload.recipe_id);
          input(!!r && typeof payload.wished === "boolean", "菜谱不存在");
          input(
            !k.library_imports?.[r.id] || !payload.wished,
            "这道菜已经在厨房里了",
          );
          k.wishes = (k.wishes || []).filter(
            (w) => !(w.actor === actor && w.recipe_id === r.id),
          );
          if (payload.wished)
            k.wishes.push({ actor, recipe_id: r.id, created_at: now });
          k.revision++;
          await tx.put("kitchens", k.id, k);
          result = { wished: payload.wished, revision: k.revision };
          break;
        }
        case "library.import": {
          keys(payload, [
            "request_id",
            "kitchen_id",
            "recipe_ids",
            "expected_revision",
          ]);
          const { kitchen: k } = await kitchenAccess(
            tx,
            payload.kitchen_id,
            actor,
            ["owner", "cook"],
          );
          revision(payload.expected_revision, k.revision);
          input(
            Array.isArray(payload.recipe_ids) &&
              payload.recipe_ids.length > 0 &&
              payload.recipe_ids.length <= 20 &&
              new Set(payload.recipe_ids).size === payload.recipe_ids.length,
            "每次请选择1至20道菜",
          );
          const selected = payload.recipe_ids.map((rid) => findRecipe(rid));
          input(selected.every(Boolean), "菜谱不存在");
          k.library_imports = k.library_imports || {};
          const fresh = selected.filter((r) => !k.library_imports[r.id]);
          input(
            k.dish_ids.length + fresh.length <= limits.dishes,
            "厨房最多保存80道菜，请减少本次导入数量",
          );
          const cats = categories(k),
            ids = [];
          for (const r of selected) {
            if (k.library_imports[r.id]) {
              ids.push(k.library_imports[r.id]);
              continue;
            }
            let c = cats.find((c) => c.kind === r.category);
            if (!c) {
              input(cats.length < 20, "请先为导入的菜谱准备对应分类");
              c = {
                id: newId(),
                name: categoryNames[r.category],
                kind: r.category,
                hidden: false,
              };
              if (cats.some((x) => x.name === c.name)) c.name += "家常";
              cats.push(c);
            }
            const did = newId();
            const { id: recipeId, ...data } = r;
            await tx.put("dishes", did, {
              ...data,
              id: did,
              kitchen_id: k.id,
              library_recipe_id: recipeId,
              category: c.kind,
              category_id: c.id,
              category_name: c.name,
              revision: 1,
            });
            k.dish_ids.push(did);
            k.library_imports[r.id] = did;
            ids.push(did);
          }
          k.categories = cats;
          k.wishes = (k.wishes || []).filter(
            (w) => !payload.recipe_ids.includes(w.recipe_id),
          );
          k.revision++;
          await tx.put("kitchens", k.id, k);
          result = {
            dish_ids: ids,
            imported: fresh.length,
            already_present: selected.length - fresh.length,
            revision: k.revision,
          };
          break;
        }
        case "feedback.submit": {
          const fid = newId();
          await tx.put("feedback", fid, {
            id: fid,
            actor,
            message: text(payload.message, 500, "反馈内容"),
            created_at: now,
            status: "received",
            revision: 1,
          });
          user.feedback_ids = [...(user.feedback_ids || []), fid].slice(-100);
          await tx.put("users", actor, user);
          result = { id: fid, status: "received" };
          break;
        }
        case "feedback.read": {
          const ids = payload.feedback_id
            ? [id(payload.feedback_id)]
            : (user.feedback_ids || []).slice(-20).reverse();
          const rows = await getMany(tx, "feedback", ids);
          result = {
            items: ids
              .filter((fid) => rows.get(fid)?.actor === actor)
              .map((fid) => {
                const r = rows.get(fid);
                return {
                  id: fid,
                  message: r.message,
                  status: r.status,
                  reply: r.reply || "",
                  created_at: r.created_at,
                  updated_at: r.updated_at || r.created_at,
                };
              }),
          };
          break;
        }
        case "kitchen.update": {
          const { kitchen: k } = await kitchenAccess(
            tx,
            payload.kitchen_id,
            actor,
            ["owner"],
          );
          revision(payload.expected_revision, k.revision);
          k.name = text(payload.name, 32, "厨房名称");
          k.description = text(
            payload.description || "",
            160,
            "厨房介绍",
            true,
          );
          const imageId = payload.image_id || "";
          if (imageId) {
            const image = await load(tx, "media", id(imageId));
            ensure(
              image.kitchen_id === k.id && image.status === "approved",
              "INVALID_IMAGE",
              "封面尚未审核通过",
            );
          }
          await updateReferences(
            tx,
            { image_id: k.image_id },
            { image_id: imageId },
            key("kitchen", k.id).slice(0, 32),
          );
          k.image_id = imageId;
          k.revision++;
          await tx.put("kitchens", k.id, k);
          result = { revision: k.revision };
          break;
        }
        case "item.undo": {
          const { meal: m } = await mealAccess(
            tx,
            payload.meal_id,
            actor,
            true,
          );
          revision(payload.expected_revision, m.revision);
          ensure(
            m.status !== "archived" && m.last_transition,
            "INVALID_STATE",
            "没有可撤销的制作状态",
          );
          const reason = text(payload.reason, 100, "撤销原因"),
            last = m.last_transition,
            item = m.items.find((i) =>
              last.line_id
                ? (i.line_id || lineKey(i)) === last.line_id
                : i.dish_id === last.dish_id,
            );
          ensure(item, "INVALID_STATE", "菜品状态已变化");
          item.status = last.previous_status;
          item.reason = last.previous_reason;
          m.status = last.previous_meal_status;
          m.revision++;
          delete m.last_transition;
          await tx.put("meals", m.id, m);
          await updateActiveMeal(tx, m, limits.active_meals);
          await tx.put("transition_audits", newId(), {
            actor,
            kitchen_id: m.kitchen_id,
            meal_id: m.id,
            action: "undo",
            reason,
            created_at: now,
          });
          for (const a of (await activeParticipants(tx, m, crypto.hash))
            .actors) {
            const jid = key(m.id, a),
              job = await tx.get("notification_jobs", jid);
            if (job?.status === "pending") {
              job.status = "cancelled";
              await tx.put("notification_jobs", jid, job);
            }
          }
          result = { revision: m.revision };
          break;
        }
        case "profile.get": {
          const kitchens = [];
          for (const kid of user.kitchen_ids) {
            const k = await tx.get("kitchens", kid),
              m = await tx.get("memberships", memberKey(kid, actor));
            if (k?.status === "active" && m?.status === "active")
              kitchens.push({ id: k.id, name: k.name, role: m.role });
          }
          if (!user.display_id) {
            user.display_id = "SQ" + newId();
            await tx.put("users", actor, user);
          }
          result = {
            display_id: user.display_id,
            name: user.name,
            kitchens,
            limits,
            features: {
              paid: false,
              notifications: !!notificationConfig?.template_id,
              template_id: notificationConfig?.template_id || "",
            },
          };
          break;
        }
        case "profile.update": {
          user.name = text(payload.name, 24, "昵称");
          await tx.put("users", actor, user);
          result = { name: user.name };
          break;
        }
        case "backup.restoreKitchen":
        case "kitchen.create": {
          if (action === "backup.restoreKitchen") {
            input(
              typeof payload.backup_group === "string" &&
                /^[a-zA-Z0-9]{16,32}$/.test(payload.backup_group),
              "备份恢复编号无效",
            );
            const oldId = user.restored_kitchens?.[payload.backup_group];
            if (oldId) {
              const old = await tx.get("kitchens", oldId);
              if (old?.status === "active" && old.owner_id === actor) {
                result = { id: oldId, resumed: true };
                break;
              }
            }
          }
          const joined = await getMany(tx, "kitchens", user.kitchen_ids);
          user.kitchen_ids = user.kitchen_ids.filter(
            (id) => joined.get(id)?.status === "active",
          );
          input(user.kitchen_ids.length < limits.kitchens, "最多加入5个厨房");
          const kid = newId();
          const k = {
            id: kid,
            name: text(payload.name, 32, "厨房名称"),
            description: text(payload.description || "", 160, "厨房介绍", true),
            owner_id: actor,
            status: "active",
            member_ids: [actor],
            dish_ids: [],
            meal_ids: [],
            active_meal_ids: [],
            revision: 1,
            created_at: now,
          };
          if (action === "backup.restoreKitchen")
            k.restore_group = payload.backup_group;
          await tx.put("kitchens", kid, k);
          await tx.put("memberships", memberKey(kid, actor), {
            kitchen_id: kid,
            user_id: actor,
            role: "owner",
            cook_access: true,
            status: "active",
          });
          user.kitchen_ids.push(kid);
          if (action === "backup.restoreKitchen") {
            user.restored_kitchens ||= {};
            user.restored_kitchens[payload.backup_group] = kid;
          }
          await tx.put("users", actor, user);
          result = { id: kid };
          break;
        }
        case "kitchen.read": {
          const { kitchen: k, member } = await kitchenAccess(
            tx,
            payload.kitchen_id,
            actor,
          );
          const dishes = [],
            meals = [],
            members = [];
          const dishRows = await getMany(tx, "dishes", k.dish_ids);
          const priceRows =
            member.cook_access === true || member.role === "cook"
              ? await getMany(tx, "dish_prices", k.dish_ids)
              : new Map();
          for (const did of k.dish_ids) {
            const d = dishRows.get(did);
            if (!d) continue;
            const item = dishView(d);
            if (member.cook_access === true || member.role === "cook") {
              const p = priceRows.get(did);
              item.default_price_minor = p?.value ?? null;
              item.default_variant_prices = (p?.variants || []).map((v) => ({
                ...v,
              }));
            }
            if (d.active || member.role !== "member") dishes.push(item);
          }
          const recentIds = [
            ...new Set([
              ...(await activeMealIds(tx, k)),
              ...k.meal_ids.slice(-20),
            ]),
          ].reverse();
          const participants = await getMany(
            tx,
            "meal_memberships",
            recentIds.map((mid) => participantKey(mid, actor)),
          );
          const mealRows = await getMany(tx, "meals", recentIds);
          for (const mid of recentIds) {
            const p = participants.get(participantKey(mid, actor));
            if (
              p?.status === "active" &&
              (p.membership_epoch || 0) === (member.epoch || 0)
            ) {
              const m = mealRows.get(mid);
              if (m) meals.push(mealSummary(m));
            }
          }
          if (member.role === "owner") {
            const users = await getMany(tx, "users", k.member_ids);
            const membershipRows = await getMany(
              tx,
              "memberships",
              k.member_ids.map((a) => memberKey(k.id, a)),
            );
            for (const a of k.member_ids) {
              const u = users.get(a),
                m = membershipRows.get(memberKey(k.id, a));
              if (m?.status === "active" && u?.status === "active")
                members.push({
                  id: a,
                  name: u?.name || "厨房朋友",
                  role: m.role,
                });
            }
          }
          result = {
            entitlement: entitlementForKitchen(k),
            id: k.id,
            name: k.name,
            description: k.description,
            image_id: k.image_id || "",
            role: member.role,
            can_price: member.cook_access === true || member.role === "cook",
            revision: k.revision,
            categories: categories(k),
            dishes,
            meals,
            meal_count: k.meal_ids.length,
            members,
          };
          break;
        }
        case "history.read": {
          const { kitchen: k, member } = await kitchenAccess(
            tx,
            payload.kitchen_id,
            actor,
          );
          const page = historyPage(k, payload.cursor || "");
          const parts = await getMany(
            tx,
            "meal_memberships",
            page.ids.map((mid) => participantKey(mid, actor)),
          );
          const data = await getMany(tx, "meals", page.ids);
          result = {
            items: page.ids
              .filter(
                (mid) =>
                  parts.get(participantKey(mid, actor))?.status === "active" &&
                  (parts.get(participantKey(mid, actor)).membership_epoch ||
                    0) === (member.epoch || 0) &&
                  data.has(mid),
              )
              .map((mid) => mealSummary(data.get(mid))),
            next_cursor: page.next_cursor,
            total: page.total,
          };
          break;
        }
        case "backup.read": {
          keys(payload, ["request_id", "kitchen_id", "section", "cursor"]);
          result = await readBackup(payload, {
            tx,
            actor,
            user,
            kitchenAccess,
            readMeal,
            participantKey,
            hash: crypto.hash,
          });
          break;
        }
        case "category.save": {
          const { kitchen: k } = await kitchenAccess(
            tx,
            payload.kitchen_id,
            actor,
            ["owner", "cook"],
          );
          keys(payload, [
            "request_id",
            "kitchen_id",
            "expected_revision",
            "categories",
          ]);
          revision(payload.expected_revision, k.revision);
          const dishes = [];
          for (const did of k.dish_ids)
            dishes.push(await load(tx, "dishes", did));
          const rows = validateCategories(payload.categories, dishes);
          for (const d of dishes) {
            const c = rows.find((c) => c.id === (d.category_id || d.category));
            if (d.category_name !== c.name || d.category !== c.kind) {
              d.category_name = c.name;
              d.category = c.kind;
              d.revision++;
              await tx.put("dishes", d.id, d);
            }
          }
          k.categories = rows;
          k.revision++;
          await tx.put("kitchens", k.id, k);
          result = { revision: k.revision };
          break;
        }
        case "dish.reorder": {
          const { kitchen: k } = await kitchenAccess(
            tx,
            payload.kitchen_id,
            actor,
            ["owner", "cook"],
          );
          keys(payload, [
            "request_id",
            "kitchen_id",
            "expected_revision",
            "dish_ids",
          ]);
          revision(payload.expected_revision, k.revision);
          input(
            Array.isArray(payload.dish_ids) &&
              payload.dish_ids.length === k.dish_ids.length &&
              new Set(payload.dish_ids).size === k.dish_ids.length &&
              payload.dish_ids.every((d) => k.dish_ids.includes(d)),
            "菜谱列表已有变化，请刷新后排序",
          );
          k.dish_ids = payload.dish_ids.slice();
          k.revision++;
          await tx.put("kitchens", k.id, k);
          result = { revision: k.revision };
          break;
        }
        case "backup.restoreDish":
        case "dish.save": {
          const { kitchen: k, member } = await kitchenAccess(
            tx,
            payload.kitchen_id,
            actor,
            ["owner", "cook"],
          );
          const restoring = action === "backup.restoreDish";
          let sourceKey;
          if (restoring) {
            ensure(
              k.owner_id === actor && k.restore_group === payload.backup_group,
              "FORBIDDEN",
              "只能恢复到本次创建的新厨房",
            );
            id(payload.source_id);
            sourceKey = key(payload.backup_group, payload.source_id).slice(
              0,
              32,
            );
            if (k.restored_dishes?.[sourceKey]) {
              result = {
                id: k.restored_dishes[sourceKey],
                already_present: true,
              };
              break;
            }
            input(!payload.dish_id, "恢复不会覆盖已有菜谱");
          }
          keys(payload, [
            ...(restoring ? ["backup_group", "source_id"] : []),
            "request_id",
            "kitchen_id",
            "dish_id",
            "expected_revision",
            "name",
            "category",
            "category_id",
            "ingredients",
            "steps",
            "minutes",
            "vegetarian",
            "spicy",
            "allergens",
            "image_id",
            "active",
            "default_price_minor",
            "default_serves",
            "ingredient_complete",
            "subtitle",
            "source_url",
            "step_title",
            "recipe_steps",
            "variants",
            "attributes",
            "nutrition",
            "variant_prices",
          ]);
          const did = payload.dish_id ? id(payload.dish_id) : newId();
          const old = payload.dish_id ? await load(tx, "dishes", did) : null;
          if (old) {
            ensure(old.kitchen_id === k.id, "NOT_FOUND", "菜谱不存在");
            revision(payload.expected_revision, old.revision);
          } else input(k.dish_ids.length < limits.dishes, "最多保存80道菜");
          const chosenCategory = categories(k).find(
            (c) => c.id === (payload.category_id || payload.category),
          );
          input(!!chosenCategory, "请选择菜谱分类");
          input(
            Array.isArray(payload.ingredients) &&
              payload.ingredients.length > 0 &&
              payload.ingredients.length <= 30,
            "请填写1至30项食材",
          );
          input(
            Array.isArray(payload.allergens) && payload.allergens.length <= 20,
          );
          const imageId = payload.image_id || "";
          if (imageId) {
            const image = await load(tx, "media", id(imageId));
            ensure(
              image.kitchen_id === k.id && image.status === "approved",
              "INVALID_IMAGE",
              "图片尚未审核通过",
            );
          }
          const details = recipeDetails(payload, old);
          for (const step of details.recipe_steps) {
            if (!step.image_id) continue;
            const image = await load(tx, "media", id(step.image_id));
            ensure(
              image.kitchen_id === k.id && image.status === "approved",
              "INVALID_IMAGE",
              "步骤图片尚未审核通过",
            );
          }
          const d = {
            ...details,
            ...(old?.library_recipe_id
              ? {
                  library_recipe_id: old.library_recipe_id,
                  source_label: old.source_label,
                }
              : {}),
            default_serves: integer(
              payload.default_serves ?? 2,
              1,
              20,
              "一份供餐人数",
            ),
            ingredient_complete: payload.ingredient_complete === true,
            id: did,
            kitchen_id: k.id,
            name: text(payload.name, 40, "菜名"),
            category: chosenCategory.kind,
            category_id: chosenCategory.id,
            category_name: chosenCategory.name,
            ingredients: payload.ingredients.map((v) => text(v, 30, "食材")),
            steps: text(payload.steps || "", 1200, "做法", true),
            minutes: integer(payload.minutes, 1, 480, "时间"),
            vegetarian: payload.vegetarian === true,
            spicy: payload.spicy === true,
            allergens: payload.allergens.map((v) => text(v, 20, "过敏原")),
            image_id: imageId,
            active: payload.active !== false,
            revision: (old?.revision || 0) + 1,
          };
          const canPrice =
            member.cook_access === true || member.role === "cook";
          ensure(
            canPrice ||
              !Object.prototype.hasOwnProperty.call(
                payload,
                "default_price_minor",
              ),
            "FORBIDDEN",
            "只有厨房厨师可以修改内部价格",
          );
          ensure(
            canPrice || payload.variant_prices === undefined,
            "FORBIDDEN",
            "只有厨房厨师可以修改内部价格",
          );
          await updateReferences(tx, old, d, key("dish", did).slice(0, 32));
          await tx.put("dishes", did, d);
          if (canPrice) {
            const price =
              payload.default_price_minor === undefined && old
                ? ((await tx.get("dish_prices", did))?.value ?? null)
                : (payload.default_price_minor ?? null);
            if (price !== null) integer(price, 0, 9999999, "内部参考价");
            const variantPrices =
              payload.variant_prices === undefined
                ? (await tx.get("dish_prices", did))?.variants || []
                : payload.variant_prices;
            input(
              Array.isArray(variantPrices) && variantPrices.length <= 8,
              "规格参考价最多8项",
            );
            const seenVariants = new Set();
            const vp = variantPrices
              .filter((v) => d.variants.includes(v.variant))
              .map((v) => {
                keys(v, ["variant", "unit_price_minor"]);
                input(!seenVariants.has(v.variant), "规格参考价不可重复");
                seenVariants.add(v.variant);
                if (v.unit_price_minor !== null)
                  integer(v.unit_price_minor, 0, 9999999, "规格参考价");
                return {
                  variant: v.variant,
                  unit_price_minor: v.unit_price_minor,
                };
              });
            input(
              payload.variant_prices === undefined ||
                vp.length === variantPrices.length,
              "规格已变化，请核对参考价",
            );
            await tx.put("dish_prices", did, {
              variants: vp,
              kitchen_id: k.id,
              value: price,
              revision: d.revision,
            });
          }
          if (!old) k.dish_ids.push(did);
          if (restoring) {
            k.restored_dishes ||= {};
            k.restored_dishes[sourceKey] = did;
          }
          if (old && d.active !== old.active) {
            for (const mid of await activeMealIds(tx, k)) {
              const m = await tx.get("meals", mid);
              if (m?.status === "open") {
                const entry = m.menu.find((x) => x.id === did);
                if (entry) {
                  entry.active = d.active;
                  m.revision++;
                  await tx.put("meals", mid, m);
                }
              }
            }
          }
          k.revision++;
          await tx.put("kitchens", k.id, k);
          result = { id: did, revision: d.revision };
          break;
        }
        case "meal.publish": {
          const { kitchen: k, member } = await kitchenAccess(
            tx,
            payload.kitchen_id,
            actor,
            ["owner", "cook"],
          );
          k.active_meal_ids = await activeMealIds(tx, k);
          input(
            k.active_meal_ids.length < limits.active_meals,
            "同时进行中的饭局已达40场，请先结束一场",
          );
          input(
            Array.isArray(payload.dish_ids) &&
              payload.dish_ids.length > 0 &&
              payload.dish_ids.length <= limits.menu,
            "请选择1至30道菜",
          );
          input(new Set(payload.dish_ids).size === payload.dish_ids.length);
          integer(
            payload.scheduled_at,
            now + 60000,
            now + 90 * 86400000,
            "用餐时间",
          );
          integer(
            payload.cutoff_at,
            now + 30000,
            payload.scheduled_at,
            "截止时间",
          );
          const mid = newId(),
            menu = [],
            prices = {};
          payload.dish_ids.forEach(id);
          const dishRows = await getMany(tx, "dishes", payload.dish_ids),
            priceRows = await getMany(tx, "dish_prices", payload.dish_ids);
          for (const did of payload.dish_ids) {
            const d = dishRows.get(did);
            ensure(d, "NOT_FOUND", "菜谱不存在");
            ensure(
              d.kitchen_id === k.id && d.active,
              "INVALID_INPUT",
              "包含不可用的菜品",
            );
            menu.push(dishView(d));
            const price = priceRows.get(did);
            prices[did] = price?.value ?? null;
            for (const v of price?.variants || [])
              if (d.variants?.includes(v.variant))
                prices[priceKey({ dish_id: did, variant: v.variant })] =
                  v.unit_price_minor;
          }
          const m = {
            id: mid,
            kitchen_id: k.id,
            title: text(payload.title, 40, "饭局标题"),
            estimated_people: integer(
              payload.estimated_people ?? 4,
              1,
              20,
              "预计人数",
            ),
            status: "open",
            scheduled_at: payload.scheduled_at,
            cutoff_at: payload.cutoff_at,
            revision: 1,
            menu,
            items: [],
            participant_ids: [actor],
            cook_id: actor,
            plan_confirmed: false,
            created_at: now,
          };
          await updateReferences(
            tx,
            null,
            { menu },
            key("meal", mid).slice(0, 32),
          );
          await tx.put("meals", mid, m);
          await tx.put("meal_memberships", participantKey(mid, actor), {
            meal_id: mid,
            user_id: actor,
            role: "cook",
            status: "active",
            membership_epoch: member.epoch || 0,
          });
          await tx.put("meal_prices", mid, {
            kitchen_id: k.id,
            prices,
            revision: 1,
          });
          k.meal_ids.push(mid);
          k.active_meal_ids.push(mid);
          k.revision++;
          await tx.put("kitchens", k.id, k);
          result = { id: mid };
          break;
        }
        case "meal.read":
          result = await readMeal(tx, payload.meal_id, actor);
          break;
        case "invitation.create": {
          const { meal: m } = await mealAccess(
            tx,
            payload.meal_id,
            actor,
            true,
          );
          ensure(
            m.status === "open" && now < m.cutoff_at,
            "CLOSED",
            "点菜已截止",
          );
          const token = crypto.token(actor + ":" + req),
            tokenHash = key("invite", token),
            inviteId = newId();
          const invite = {
            id: inviteId,
            creator: actor,
            epoch: m.invite_epoch || 0,
            token_hash: tokenHash,
            kitchen_id: m.kitchen_id,
            meal_id: m.id,
            expires_at: Math.min(m.cutoff_at, now + 7 * 86400000),
            revoked: false,
            accepted: [],
            max_uses: limits.members,
          };
          await tx.put("invitations", tokenHash, invite);
          await tx.put("invite_refs", inviteId, {
            token_hash: tokenHash,
            meal_id: m.id,
            kitchen_id: m.kitchen_id,
            creator: actor,
          });
          result = { id: inviteId, token, expires_at: invite.expires_at };
          break;
        }
        case "invitation.revokeAll": {
          const { meal: m } = await mealAccess(
            tx,
            payload.meal_id,
            actor,
            true,
          );
          m.invite_epoch = (m.invite_epoch || 0) + 1;
          m.revision++;
          await tx.put("meals", m.id, m);
          result = { revoked: true };
          break;
        }
        case "invitation.revoke": {
          const ref = await load(tx, "invite_refs", id(payload.invitation_id));
          await mealAccess(tx, ref.meal_id, actor, true);
          const invite = await load(tx, "invitations", ref.token_hash);
          invite.revoked = true;
          await tx.put("invitations", ref.token_hash, invite);
          result = { revoked: true };
          break;
        }
        case "invitation.resolve":
        case "invitation.accept": {
          const token = text(payload.token, 64, "邀请口令");
          input(/^[a-f0-9]{48}$/.test(token), "邀请口令无效");
          const tokenHash = key("invite", token),
            invite = await load(tx, "invitations", tokenHash);
          ensure(
            !invite.revoked && now < invite.expires_at,
            "INVITATION_EXPIRED",
            "邀请已过期或被撤销",
          );
          const k = await load(tx, "kitchens", invite.kitchen_id),
            m = await load(tx, "meals", invite.meal_id);
          ensure(
            k.status === "active" && m.status === "open" && now < m.cutoff_at,
            "CLOSED",
            "饭局已停止接受点菜",
          );
          ensure(
            (invite.epoch || 0) === (m.invite_epoch || 0),
            "INVITATION_EXPIRED",
            "邀请已过期或被撤销",
          );
          if (action === "invitation.resolve") {
            result = {
              kitchen_name: k.name,
              title: m.title,
              scheduled_at: m.scheduled_at,
              cutoff_at: m.cutoff_at,
              dishes: m.menu.map((d) => ({
                name: d.name,
                category_name: d.category_name || categoryNames[d.category],
              })),
            };
            break;
          }
          const oldMember = await tx.get("memberships", memberKey(k.id, actor));
          ensure(
            oldMember?.status !== "revoked",
            "FORBIDDEN",
            "当前邀请不能恢复已撤销的成员资格",
          );
          if (!invite.accepted.includes(actor)) {
            input(invite.accepted.length < invite.max_uses, "邀请名额已满");
            invite.accepted.push(actor);
          }
          if (!k.member_ids.includes(actor)) {
            input(k.member_ids.length < limits.members, "厨房人数已满");
            k.member_ids.push(actor);
          }
          if (!user.kitchen_ids.includes(k.id)) {
            const live = await getMany(tx, "kitchens", user.kitchen_ids);
            user.kitchen_ids = user.kitchen_ids.filter(
              (id) => live.get(id)?.status === "active",
            );
            input(user.kitchen_ids.length < limits.kitchens, "最多加入5个厨房");
            user.kitchen_ids.push(k.id);
          }
          m.participant_ids = (
            await activeParticipants(tx, m, crypto.hash)
          ).actors;
          if (!m.participant_ids.includes(actor)) {
            input(m.participant_ids.length < limits.members, "饭局人数已满");
            m.participant_ids.push(actor);
          }
          await tx.put("memberships", memberKey(k.id, actor), {
            kitchen_id: k.id,
            user_id: actor,
            role: oldMember?.role || "member",
            cook_access: oldMember?.cook_access === true,
            status: "active",
            epoch: oldMember?.epoch || 0,
          });
          const oldPart = await tx.get(
            "meal_memberships",
            participantKey(m.id, actor),
          );
          ensure(
            oldPart?.status !== "revoked" &&
              (!oldPart ||
                (oldPart.membership_epoch || 0) === (oldMember?.epoch || 0)),
            "FORBIDDEN",
            "当前邀请不能恢复本餐资格",
          );
          await tx.put("meal_memberships", participantKey(m.id, actor), {
            meal_id: m.id,
            user_id: actor,
            role: oldPart?.role || "member",
            status: "active",
            membership_epoch: oldMember?.epoch || 0,
          });
          k.revision++;
          m.revision++;
          await tx.put("kitchens", k.id, k);
          await tx.put("meals", m.id, m);
          await tx.put("users", actor, user);
          await tx.put("invitations", tokenHash, invite);
          result = { kitchen_id: k.id, meal_id: m.id };
          break;
        }
        case "selection.replace": {
          keys(payload, [
            "request_id",
            "meal_id",
            "items",
            "note",
            "people",
            "expected_revision",
          ]);
          const { meal: m } = await mealAccess(tx, payload.meal_id, actor);
          ensure(
            m.status === "open" && now < m.cutoff_at,
            "CLOSED",
            "点菜已截止，草稿仍保留在本机",
          );
          input(
            Array.isArray(payload.items) &&
              payload.items.length <= limits.selection_lines,
          );
          const selected = new Set();
          const items = payload.items.map((i) => {
            keys(i, ["dish_id", "quantity", "variant", "options", "line_id"]);
            id(i.dish_id);
            const d = m.menu.find((d) => d.id === i.dish_id && d.active);
            input(d, "菜品已下架，请调整选择");
            const row = {
              dish_id: i.dish_id,
              quantity: integer(i.quantity, 1, 20, "请求份数"),
              ...selectionDetails(i, d),
            };
            const lid = lineKey(row);
            input(!i.line_id || i.line_id === lid, "规格组合编号已变化");
            input(!selected.has(lid), "规格组合重复");
            selected.add(lid);
            return { ...row, line_id: lid };
          });
          for (const did of new Set(items.map((i) => i.dish_id)))
            input(dishQuantity(items, did) <= 20, "同一道菜的合计请求最多20份");
          const globalLines = new Set(items.map((i) => i.line_id));
          const participants = (
            await activeParticipants(tx, m, crypto.hash)
          ).actors.filter((a) => a !== actor);
          for (const choice of (
            await getMany(
              tx,
              "selections",
              participants.map((a) => key(m.id, a)),
            )
          ).values())
            for (const i of selectionRows(m.menu, choice.items || []))
              globalLines.add(i.line_id);
          input(
            globalLines.size <= limits.meal_lines,
            "本餐规格组合已达80项，请与厨师确认后调整",
          );
          const sid = key(m.id, actor),
            old = await tx.get("selections", sid);
          revision(payload.expected_revision, old?.revision || 0);
          await tx.put("selections", sid, {
            meal_id: m.id,
            user_id: actor,
            items,
            people: integer(payload.people ?? 1, 1, 20, "代表人数"),
            note: text(payload.note || "", 150, "备注", true),
            revision: (old?.revision || 0) + 1,
            updated_at: now,
          });
          m.revision++;
          await tx.put("meals", m.id, m);
          result = { revision: (old?.revision || 0) + 1, meal_id: m.id };
          break;
        }
        case "meal.lock":
        case "meal.unlock":
        case "meal.cancel":
        case "meal.archive": {
          const { meal: m } = await mealAccess(
            tx,
            payload.meal_id,
            actor,
            true,
          );
          revision(payload.expected_revision, m.revision);
          if (action === "meal.lock") {
            ensure(m.status === "open", "INVALID_STATE", "当前不能锁单");
            m.status = "locked";
          }
          if (action === "meal.unlock") {
            ensure(
              m.status === "locked" &&
                m.items.every(
                  (i) => i.status === "planned" || i.status === "skipped",
                ),
              "INVALID_STATE",
              "制作开始后不能重新开放",
            );
            integer(
              payload.cutoff_at,
              now + 30000,
              Math.max(m.scheduled_at, now + 30000),
              "新截止时间",
            );
            m.status = "open";
            m.plan_confirmed = false;
            m.items = [];
            delete m.last_transition;
            m.cutoff_at = payload.cutoff_at;
          }
          if (action === "meal.cancel") {
            ensure(
              ["open", "locked"].includes(m.status),
              "INVALID_STATE",
              "制作开始后不能取消整餐",
            );
            m.status = "cancelled";
          }
          if (action === "meal.archive") {
            ensure(
              ["completed", "cancelled"].includes(m.status),
              "INVALID_STATE",
              "只能归档已结束饭局",
            );
            m.final_status = m.status;
            m.status = "archived";
          }
          m.revision++;
          await tx.put("meals", m.id, m);
          await updateActiveMeal(tx, m, limits.active_meals);
          result = { id: m.id, status: m.status, revision: m.revision };
          break;
        }
        case "plan.confirm": {
          const { meal: m } = await mealAccess(
            tx,
            payload.meal_id,
            actor,
            true,
          );
          revision(payload.expected_revision, m.revision);
          ensure(
            m.status === "locked" && !m.plan_confirmed,
            "INVALID_STATE",
            "请先锁单，且制作计划只能确认一次",
          );
          input(
            Array.isArray(payload.items) &&
              payload.items.length <= limits.meal_lines,
          );
          const requests = await currentChoices(tx, m);
          const demand = mealDemand(m.menu, requests),
            seen = new Set();
          const items = payload.items.map((i) => {
            keys(i, [
              "dish_id",
              "line_id",
              "variant",
              "options",
              "quantity",
              "reason",
            ]);
            const d = m.menu.find((d) => d.id === i.dish_id);
            input(d, "菜品不在菜单");
            let row;
            if (i.line_id)
              row = demand.find(
                (r) => r.line_id === i.line_id && r.dish_id === i.dish_id,
              );
            else {
              const matches = demand.filter((r) => r.dish_id === i.dish_id);
              input(
                matches.length === 1,
                "同菜有多种规格，请使用新版制作计划逐项确认",
              );
              row = matches[0];
            }
            input(row, "规格组合不在需求列表");
            input(!seen.has(row.line_id), "制作规格组合重复");
            seen.add(row.line_id);
            const q = integer(i.quantity, 0, 20, "制作份数");
            input(d.active || q === 0, "已下架菜品请明确不做");
            return {
              line_id: row.line_id,
              dish_id: d.id,
              ...(row.variant ? { variant: row.variant } : {}),
              ...(row.options ? { options: row.options } : {}),
              name: d.name,
              quantity: q,
              reason: q === 0 ? text(i.reason, 100, "不做原因") : "",
              status: q === 0 ? "skipped" : "planned",
              requested_people: row.people || 0,
            };
          });
          input(
            demand
              .filter((r) => r.requested_quantity > 0)
              .every((r) => seen.has(r.line_id)),
            "请为每个有人点的规格填写份数，或填0明确不做",
          );
          for (const did of new Set(items.map((i) => i.dish_id)))
            input(
              dishQuantity(items, did) <= 20,
              "同一道菜的实际制作合计最多20份",
            );
          input(items.length > 0, "请填写制作计划");
          m.items = items;
          m.plan_confirmed = true;
          if (items.every((i) => i.status === "skipped"))
            m.status = "completed";
          m.revision++;
          await tx.put("meals", m.id, m);
          await updateActiveMeal(tx, m, limits.active_meals);
          result = { id: m.id, revision: m.revision };
          break;
        }
        case "item.transition": {
          const { meal: m } = await mealAccess(
            tx,
            payload.meal_id,
            actor,
            true,
          );
          revision(payload.expected_revision, m.revision);
          ensure(
            m.plan_confirmed && ["locked", "cooking"].includes(m.status),
            "INVALID_STATE",
            "当前不能更新制作进度",
          );
          const matches = m.items.filter((i) => i.dish_id === payload.dish_id);
          input(
            payload.line_id || matches.length === 1,
            "请按规格更新制作进度",
          );
          const item = matches.find(
            (i) =>
              !payload.line_id || (i.line_id || lineKey(i)) === payload.line_id,
          );
          input(item, "菜品不在制作计划");
          const allowed = {
            planned: ["cooking", "skipped"],
            cooking: ["served", "skipped"],
            served: [],
            skipped: [],
          };
          ensure(
            allowed[item.status].includes(payload.status),
            "INVALID_STATE",
            "不允许这样更改制作进度",
          );
          m.last_transition = {
            line_id: item.line_id || lineKey(item),
            dish_id: item.dish_id,
            previous_status: item.status,
            previous_meal_status: m.status,
            previous_reason: item.reason || "",
            actor,
            at: now,
          };
          if (payload.status === "skipped")
            item.reason = text(payload.reason, 100, "不做原因");
          item.status = payload.status;
          m.status = m.items.every((i) =>
            ["served", "skipped"].includes(i.status),
          )
            ? "completed"
            : "cooking";
          m.revision++;
          await tx.put("meals", m.id, m);
          await updateActiveMeal(tx, m, limits.active_meals);
          if (
            m.status === "completed" &&
            m.items.some((i) => i.status === "served")
          )
            for (const a of (await activeParticipants(tx, m, crypto.hash))
              .actors) {
              const p = await tx.get("notification_preferences", key(m.id, a));
              if (
                p?.accepted &&
                !(await tx.get("notification_jobs", key(m.id, a)))
              )
                await tx.put("notification_jobs", key(m.id, a), {
                  id: key(m.id, a),
                  actor: a,
                  meal_id: m.id,
                  kitchen_id: m.kitchen_id,
                  title: m.title,
                  status: "pending",
                  created_at: now,
                });
            }
          result = { id: m.id, revision: m.revision };
          break;
        }
        case "price.update": {
          const { meal: m } = await mealAccess(
            tx,
            payload.meal_id,
            actor,
            true,
          );
          ensure(
            m.status === "open" && now < m.cutoff_at,
            "CLOSED",
            "锁单或截止后不能改本餐价格",
          );
          const q = await load(tx, "meal_prices", m.id);
          revision(payload.expected_revision, q.revision);
          input(
            m.menu.some((d) => d.id === payload.dish_id),
            "菜品不存在",
          );
          const price = payload.unit_price_minor;
          if (price !== null) integer(price, 0, 9999999, "内部参考价");
          let pk = payload.dish_id;
          if (payload.line_id) {
            const requests = await currentChoices(tx, m);
            const row = mealDemand(m.menu, requests).find(
              (r) =>
                r.line_id === payload.line_id && r.dish_id === payload.dish_id,
            );
            input(row, "规格组合已变化，请刷新");
            pk = row.line_id;
          }
          q.prices[pk] = price;
          q.revision++;
          await tx.put("meal_prices", m.id, q);
          result = { revision: q.revision };
          break;
        }
        case "recommend": {
          const { meal: m } = await mealAccess(tx, payload.meal_id, actor);
          const { kitchen: k } = await kitchenAccess(tx, m.kitchen_id, actor);
          const recent = [];
          for (const mid of k.meal_ids.slice(-6)) {
            if (mid === m.id) continue;
            const p = await tx.get(
              "meal_memberships",
              participantKey(mid, actor),
            );
            if (p?.status !== "active") continue;
            const old = await tx.get("meals", mid);
            if (old && ["completed", "archived"].includes(old.status))
              for (const i of old.items)
                if (i.status === "served") recent.push(i.dish_id);
          }
          result = recommend(
            m.menu,
            { ...payload, seed: crypto.random(4) },
            recent,
          );
          break;
        }
        case "member.role": {
          const { kitchen: k } = await kitchenAccess(
            tx,
            payload.kitchen_id,
            actor,
            ["owner"],
          );
          revision(payload.expected_revision, k.revision);
          const target = id(payload.member_id);
          input(
            k.member_ids.includes(target) && target !== actor,
            "请选择其他成员",
          );
          input(["cook", "member", "owner"].includes(payload.role));
          const member = await load(tx, "memberships", memberKey(k.id, target));
          ensure(member.status === "active", "NOT_FOUND", "成员不在厨房");
          member.role = payload.role;
          if (payload.role === "cook") member.cook_access = true;
          if (payload.role === "member") member.cook_access = false;
          if (payload.role === "owner") {
            const own = await load(tx, "memberships", memberKey(k.id, actor));
            own.role = "cook";
            await tx.put("memberships", memberKey(k.id, actor), own);
            k.owner_id = target;
          }
          await tx.put("memberships", memberKey(k.id, target), member);
          k.revision++;
          await tx.put("kitchens", k.id, k);
          result = { revision: k.revision };
          break;
        }
        case "meal.assignCook": {
          const {
            meal: m,
            kitchen: k,
            participant,
          } = await mealAccess(tx, payload.meal_id, actor);
          ensure(
            k.owner_id === actor || participant.role === "cook",
            "FORBIDDEN",
            "只有主人或本餐厨师可以交接",
          );
          revision(payload.expected_revision, m.revision);
          ensure(
            ["open", "locked"].includes(m.status) && !m.plan_confirmed,
            "INVALID_STATE",
            "确认计划后不能更换厨师",
          );
          const target = id(payload.member_id);
          ensure(
            (await tx.get("users", target))?.status === "active",
            "NOT_FOUND",
            "成员账号不可用",
          );
          const member = await tx.get("memberships", memberKey(k.id, target)),
            part = await tx.get(
              "meal_memberships",
              participantKey(m.id, target),
            );
          ensure(
            member?.status === "active" && part?.status === "active",
            "NOT_FOUND",
            "请先让新厨师加入本餐",
          );
          const previous = await load(
            tx,
            "meal_memberships",
            participantKey(m.id, m.cook_id),
          );
          previous.role = "member";
          await tx.put(
            "meal_memberships",
            participantKey(m.id, m.cook_id),
            previous,
          );
          part.role = "cook";
          await tx.put("meal_memberships", participantKey(m.id, target), part);
          m.cook_id = target;
          m.revision++;
          await tx.put("meals", m.id, m);
          result = { revision: m.revision };
          break;
        }
        case "member.remove":
        case "kitchen.leave": {
          const { kitchen: k, member: own } = await kitchenAccess(
            tx,
            payload.kitchen_id,
            actor,
            action === "member.remove" ? ["owner"] : undefined,
          );
          const target =
            action === "kitchen.leave" ? actor : id(payload.member_id);
          input(target !== k.owner_id, "主人请先转让厨房或关闭厨房");
          input(k.member_ids.includes(target), "成员不存在");
          const active = await getMany(tx, "meals", await activeMealIds(tx, k));
          for (const m of active.values())
            ensure(
              m.cook_id !== target,
              "ACTIVE_COOK",
              "该成员还有负责的饭局，请先结束饭局",
            );
          const member = await load(tx, "memberships", memberKey(k.id, target));
          member.epoch = (member.epoch || 0) + 1;
          const jobId = key("member-cleanup", k.id, target, String(now));
          await tx.put("cleanup_jobs", jobId, {
            id: jobId,
            kind: "member",
            actor: target,
            kitchen_id: k.id,
            membership_id: memberKey(k.id, target),
            membership_epoch: member.epoch,
            status: "pending",
            table: 0,
            cursor: "",
            created_at: now,
          });
          member.status = action === "member.remove" ? "revoked" : "left";
          await tx.put("memberships", memberKey(k.id, target), member);
          k.member_ids = k.member_ids.filter((a) => a !== target);
          k.wishes = (k.wishes || []).filter((w) => w.actor !== target);
          k.revision++;
          await tx.put("kitchens", k.id, k);
          const targetUser = await load(tx, "users", target);
          targetUser.kitchen_ids = targetUser.kitchen_ids.filter(
            (i) => i !== k.id,
          );
          await tx.put("users", target, targetUser);
          result = { left: true };
          break;
        }
        case "kitchen.close": {
          const { kitchen: k } = await kitchenAccess(
            tx,
            payload.kitchen_id,
            actor,
            ["owner"],
          );
          revision(payload.expected_revision, k.revision);
          ensure(
            (await activeMealIds(tx, k)).length === 0,
            "ACTIVE_MEAL",
            "请先结束所有饭局",
          );
          await tx.put("cleanup_jobs", "kitchen-" + k.id, {
            id: "kitchen-" + k.id,
            kind: "kitchen",
            kitchen_id: k.id,
            dish_ids: k.dish_ids,
            meal_ids: k.meal_ids,
            status: "pending",
            table: 0,
            cursor: "",
            created_at: now,
          });
          k.status = "closed";
          k.revision++;
          await tx.put("kitchens", k.id, k);
          user.kitchen_ids = user.kitchen_ids.filter((id) => id !== k.id);
          await tx.put("users", actor, user);
          result = { closed: true };
          break;
        }
        case "account.delete": {
          const kitchens = await getMany(tx, "kitchens", user.kitchen_ids);
          for (const k of kitchens.values()) {
            if (k.status !== "active") continue;
            ensure(
              k.owner_id !== actor,
              "OWNER_TRANSFER_REQUIRED",
              "请先转让或关闭你创建的厨房",
            );
            const active = await getMany(
              tx,
              "meals",
              await activeMealIds(tx, k),
            );
            for (const m of active.values())
              ensure(m.cook_id !== actor, "ACTIVE_COOK", "请先结束负责的饭局");
          }
          for (const [kid, k] of kitchens) {
            k.member_ids = k.member_ids.filter((a) => a !== actor);
            k.wishes = (k.wishes || []).filter((w) => w.actor !== actor);
            k.revision++;
            await tx.put("kitchens", kid, k);
          }
          const job = {
            id: actor,
            kind: "account",
            status: "pending",
            actor,
            kitchen_ids: user.kitchen_ids.slice(),
            table: 0,
            cursor: "",
            created_at: now,
          };
          user.status = "deleted";
          user.name = "已注销";
          user.kitchen_ids = [];
          user.favorite_recipe_ids = [];
          await tx.put("users", actor, user);
          await tx.put("deletion_jobs", actor, job);
          await tx.put("cleanup_jobs", actor, job);
          result = {
            status: "pending",
            message: "账号已停用，个人内容进入删除队列",
          };
          break;
        }
        case "export.mine": {
          if (payload.section === "meals") {
            keys(payload, ["request_id", "section", "kitchen_id", "cursor"]);
            result = await readBackup(
              { ...payload, section: "meals" },
              {
                tx,
                actor,
                user,
                kitchenAccess,
                readMeal,
                participantKey,
                hash: crypto.hash,
              },
            );
            break;
          }
          keys(payload, ["request_id", "section"]);
          input(
            !payload.section || payload.section === "profile",
            "未知导出内容",
          );
          if (payload.section === "profile") {
            const rows = await getMany(tx, "kitchens", user.kitchen_ids);
            const members = await getMany(
              tx,
              "memberships",
              user.kitchen_ids.map((kid) => memberKey(kid, actor)),
            );
            result = {
              name: user.name,
              exported_at: now,
              favorite_recipe_ids: (user.favorite_recipe_ids || []).slice(),
              kitchens: user.kitchen_ids
                .filter(
                  (kid) =>
                    rows.get(kid)?.status === "active" &&
                    members.get(memberKey(kid, actor))?.status === "active",
                )
                .map((kid) => ({
                  id: kid,
                  name: rows.get(kid).name,
                  role: members.get(memberKey(kid, actor)).role,
                })),
            };
            break;
          }
          const oldKitchens = await getMany(tx, "kitchens", user.kitchen_ids);
          ensure(
            [...oldKitchens.values()].reduce(
              (n, k) => n + (k.meal_ids?.length || 0),
              0,
            ) <= 1,
            "EXPORT_PAGINATION_REQUIRED",
            "记录较多，请使用最新版分批导出或完整厨房备份",
          );
          const kitchens = [];
          for (const kid of user.kitchen_ids) {
            const { kitchen: k, member } = await kitchenAccess(tx, kid, actor);
            const meals = [];
            for (const mid of k.meal_ids) {
              const p = await tx.get(
                "meal_memberships",
                participantKey(mid, actor),
              );
              if (
                p?.status === "active" &&
                (p.membership_epoch || 0) === (member.epoch || 0)
              ) {
                const m = await tx.get("meals", mid);
                meals.push({
                  ...(await readMeal(tx, mid, actor)),
                  shopping: await shoppingView(m, actor, tx, crypto.hash),
                  own_review: (await reviewView(m, actor, tx, 0, crypto.hash))
                    .own,
                });
              }
            }
            kitchens.push({ name: k.name, role: member.role, meals });
          }
          result = {
            name: user.name,
            exported_at: now,
            favorite_recipe_ids: (user.favorite_recipe_ids || []).slice(),
            kitchens,
          };
          break;
        }
        case "share.create": {
          const { meal: m } = await mealAccess(
            tx,
            payload.meal_id,
            actor,
            true,
          );
          const sid = crypto.random(12);
          await tx.put("public_shares", sid, {
            id: sid,
            epoch: m.share_epoch || 0,
            creator: actor,
            kitchen_id: m.kitchen_id,
            meal_id: m.id,
            title: m.title,
            dishes: m.menu.map((d) => ({
              name: d.name,
              category_name: d.category_name || categoryNames[d.category],
            })),
            expires_at: Math.min(m.scheduled_at + 86400000, now + 7 * 86400000),
            revoked: false,
          });
          result = { id: sid };
          break;
        }
        case "share.ownerRead": {
          const share = await load(tx, "public_shares", id(payload.share_id));
          const { meal: m } = await mealAccess(tx, share.meal_id, actor, true);
          ensure(
            (share.epoch || 0) === (m.share_epoch || 0) &&
              !share.revoked &&
              share.expires_at > now,
            "NOT_FOUND",
            "分享已失效",
          );
          result = { id: share.id, title: share.title, dishes: share.dishes };
          break;
        }
        case "share.revokeAll": {
          const { meal: m } = await mealAccess(
            tx,
            payload.meal_id,
            actor,
            true,
          );
          m.share_epoch = (m.share_epoch || 0) + 1;
          m.revision++;
          await tx.put("meals", m.id, m);
          result = { revoked: true };
          break;
        }
        case "share.revoke": {
          const share = await load(tx, "public_shares", id(payload.share_id));
          await mealAccess(tx, share.meal_id, actor, true);
          share.revoked = true;
          await tx.put("public_shares", share.id, share);
          result = { revoked: true };
          break;
        }
        case "media.prepare": {
          const { kitchen: k, member } = await kitchenAccess(
            tx,
            payload.kitchen_id,
            actor,
            ["owner", "cook"],
          );
          const mid = newId();
          await tx.put("media", mid, {
            id: mid,
            kitchen_id: k.id,
            actor,
            membership_epoch: member.epoch || 0,
            status: "awaiting_upload",
            created_at: now,
            expires_at: now + 86400000,
            references_version: 1,
            references: {},
          });
          result = { id: mid };
          break;
        }
        case "media.read": {
          const image = await load(tx, "media", id(payload.media_id));
          await kitchenAccess(tx, image.kitchen_id, actor);
          ensure(
            image.status === "approved" || image.actor === actor,
            "NOT_FOUND",
            "图片不可用",
          );
          result = { id: image.id, status: image.status };
          if (image.status === "approved") result.file_id = image.file_id;
          break;
        }
        case "notification.optin": {
          const { meal: m } = await mealAccess(tx, payload.meal_id, actor);
          await tx.put("notification_preferences", key(m.id, actor), {
            meal_id: m.id,
            user_id: actor,
            accepted: payload.accepted === true,
            updated_at: now,
          });
          result = { saved: true };
          break;
        }
        default:
          throw new AppError("INVALID_ACTION", "暂不支持这个操作");
      }
      if (req) {
        const storedResult = { ...result };
        delete storedResult.token;
        await tx.put("receipts", receiptKey, {
          actor,
          action,
          fingerprint,
          result: storedResult,
          created_at: now,
        });
        await tx.put("audit_events", receiptKey, {
          actor,
          action,
          resource: payload.meal_id || payload.kitchen_id || result.id || "",
          created_at: now,
        });
      }
      return result;
    });
  }
  return { execute, limits };
}
module.exports = { createService, limits };
