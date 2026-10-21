// Local rehearsal only. Production cloud calls never accept these actor identities.
type DomainService = {
  execute(
    action: string,
    payload: Record<string, unknown>,
    context: Record<string, string>,
  ): Promise<unknown>;
};
type MemoryStore = {
  transaction(fn: (tx: any) => Promise<unknown>): Promise<unknown>;
  snapshot(): Record<string, unknown>;
};
let instance: DomainService | null = null,
  store: MemoryStore | null = null;
const stateKey = "squiddy-rehearsal-v2";
export const actor = (): string =>
  wx.getStorageSync("squiddy-rehearsal-actor") || "chef";
export function selectActor(value: string) {
  if (!["chef", "alice", "bob"].includes(value)) throw Error("未知演练角色");
  wx.setStorageSync("squiddy-rehearsal-actor", value);
}
function hash(s: string): string {
  let a = 2166136261,
    b = 2166136261;
  for (let i = 0; i < s.length; i++) {
    a = Math.imul(a ^ s.charCodeAt(i), 16777619);
    b = Math.imul(b ^ (s.charCodeAt(i) + i), 2246822507);
  }
  return (
    (a >>> 0).toString(16).padStart(8, "0") +
    (b >>> 0).toString(16).padStart(8, "0")
  );
}
function random(n: number) {
  let out = "";
  for (let i = 0; i < n; i++)
    out += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0");
  return out;
}
function init() {
  if (instance) return instance;
  const { createMemoryStore } = require("../domain/store");
  const { createService } = require("../domain/service");
  let initial = {};
  try {
    initial = wx.getStorageSync(stateKey) || {};
  } catch {
    console.warn("local.read_failed");
  }
  store = createMemoryStore(initial, (state: unknown) =>
    wx.setStorageSync(stateKey, state),
  );
  instance = createService({
    store,
    crypto: {
      hash,
      random,
      token: (s: string) =>
        (hash("local-only:" + s) + hash(s) + hash("token:" + s)).slice(0, 48),
    },
    expectedAppId: "local-rehearsal",
    moderate: async (content: string) => {
      if (content.includes("BLOCKED_TEXT"))
        throw Object.assign(Error("演练：内容未通过审核"), {
          code: "CONTENT_REJECTED",
        });
    },
    media: {
      accept: async (payload: any, image: any) => {
        if (!payload.local_path) throw Error("请选择图片");
        const file =
          wx.env.USER_DATA_PATH + "/squiddy-image-" + image.id + ".jpg";
        wx.getFileSystemManager().copyFileSync(payload.local_path, file);
        return { status: "approved", file_id: file, width: 400, height: 400 };
      },
    },
    notificationConfig: { template_id: "local-rehearsal-only" },
  }) as DomainService;
  return instance;
}
export async function localCall(
  action: string,
  payload: Record<string, unknown>,
) {
  if (wx.getStorageSync("squiddy-rehearsal-offline"))
    throw Object.assign(Error("离线演练：请求未送达，草稿已保留"), {
      code: "OFFLINE",
    });
  const service = init();
  return service.execute(action, payload, {
    OPENID: actor(),
    APPID: "local-rehearsal",
  });
}
export async function localPublicRead(id: string) {
  init();
  return require("../domain/maintenance").publicRead(store, id);
}
export async function localCleanup() {
  init();
  const uid = hash("local-rehearsal:" + actor());
  const { cleanupBatch } = require("../domain/maintenance");
  for (let i = 0; i < 40; i++) {
    await drainLocalFiles();
    const result = await cleanupBatch(store, uid, { hash });
    if (result.status === "completed") return result;
  }
  return { status: "running" };
}

export async function localMaintenance() {
  init();
  const { cleanupBatch } = require("../domain/maintenance");
  const snapshot = store!.snapshot() as any;
  for (const id of Object.keys(snapshot.cleanup_jobs || {}))
    for (let i = 0; i < 80; i++) {
      await drainLocalFiles();
      const result = await cleanupBatch(store, id, { hash });
      if (result.status === "completed") break;
    }
  return { done: true };
}

async function drainLocalFiles() {
  const snapshot = store!.snapshot() as any;
  for (const [id, row] of Object.entries(snapshot.file_deletions || {}) as [
    string,
    any,
  ][]) {
    try {
      wx.getFileSystemManager().unlinkSync(row.file_id);
    } catch (e) {
      if (
        !/no such file|not exist|ENOENT/i.test(
          String((e as any).message || (e as any).errMsg || e),
        )
      )
        continue;
    }
    await store!.transaction((tx) => tx.remove("file_deletions", id));
  }
}

let seedInFlight: Promise<{ kitchenId: string; mealId: string }> | null = null;
export function seedDemo() {
  if (seedInFlight) return seedInFlight;
  seedInFlight = seedDemoOnce().finally(() => {
    seedInFlight = null;
  });
  return seedInFlight;
}
async function seedDemoOnce() {
  const previous = actor();
  const run = async (action: string, payload: Record<string, unknown> = {}) =>
    (await localCall(action, {
      ...payload,
      request_id: "demo-" + random(12),
    })) as any;
  try {
    selectActor("chef");
    const saved = wx.getStorageSync("squiddy-demo-seed-v1");
    if (saved) {
      try {
        await run("meal.read", { meal_id: saved.mealId });
        return saved;
      } catch (e) {
        if (!["NOT_FOUND", "CLOSED"].includes((e as any).code)) throw e;
      }
    }
    for (const who of ["chef", "alice", "bob"]) {
      selectActor(who);
      const p = await run("profile.get");
      if (p.kitchens.length >= 5)
        throw Error("演练厨房已满，请先关闭一间不用的演练厨房");
    }
    selectActor("chef");
    await run("profile.update", { name: "须须（掌勺）" });
    const k = await run("kitchen.create", {
      name: "周末的一桌好饭",
      description: "六道拿手菜，三个朋友。慢慢选，慢慢做。",
    });
    const specs = [
      {
        name: "番茄炒蛋",
        category: "vegetable",
        ingredients: ["番茄", "鸡蛋", "食用油", "盐"],
        allergens: ["鸡蛋"],
        steps:
          "鸡蛋加少许盐打散。\n热锅下油，将蛋液炒成块后盛出。\n番茄炒出汁，倒回鸡蛋合炒调味。",
        minutes: 15,
        vegetarian: true,
        spicy: false,
        price: 1200,
      },
      {
        name: "青椒小炒肉",
        category: "protein",
        ingredients: ["猪肉", "青椒", "生抽", "食用油", "盐"],
        allergens: ["大豆", "小麦"],
        steps:
          "肉片用生抽略腌。\n肉片炒至变色，加入青椒翻炒。\n加盐调味，炒熟出锅。",
        minutes: 20,
        vegetarian: false,
        spicy: true,
        price: 2600,
      },
      {
        name: "莲藕排骨汤",
        category: "soup",
        ingredients: ["莲藕", "排骨", "姜", "盐"],
        allergens: [],
        steps:
          "排骨焯水后洗净，莲藕切块。\n加水与姜片炖煮，至排骨和莲藕软熟。\n加盐调味。",
        minutes: 80,
        vegetarian: false,
        spicy: false,
        price: 3200,
      },
      {
        name: "葱油拌面",
        category: "staple",
        ingredients: ["小麦面条", "葱", "生抽", "食用油"],
        allergens: ["小麦", "大豆"],
        steps: "小火把葱段煎香，加生抽煮匀。\n面条煮熟沥水，与葱油拌匀。",
        minutes: 15,
        vegetarian: true,
        spicy: false,
        price: 1600,
      },
      {
        name: "蒜香拍黄瓜",
        category: "vegetable",
        ingredients: ["黄瓜", "蒜", "米醋", "盐", "食用油"],
        allergens: [],
        steps: "黄瓜洗净拍碎，蒜切末。\n与米醋、盐和少许油拌匀，静置入味。",
        minutes: 10,
        vegetarian: true,
        spicy: false,
        price: 800,
      },
      {
        name: "红豆小圆子",
        category: "dessert",
        ingredients: ["红豆", "糯米粉", "白糖", "水"],
        allergens: [],
        steps:
          "红豆提前浸泡，煮至绵软。\n糯米粉加水搓成小圆子，煮熟后加入红豆汤。\n按口味加少许糖。",
        minutes: 60,
        vegetarian: true,
        spicy: false,
        price: 1400,
      },
    ];
    const ids = [];
    for (const d of specs) {
      const { price, ...body } = d;
      const dish = await run("dish.save", {
        ...body,
        kitchen_id: k.id,
        expected_revision: 0,
        default_serves: 2,
        ingredient_complete: true,
        active: true,
        default_price_minor: price,
      });
      ids.push(dish.id);
    }
    const scheduled = Date.now() + 6 * 3600000;
    const m = await run("meal.publish", {
      kitchen_id: k.id,
      title: "周末，来家里吃饭",
      estimated_people: 4,
      dish_ids: ids,
      scheduled_at: scheduled,
      cutoff_at: scheduled - 30 * 60000,
    });
    const invitation = await run("invitation.create", { meal_id: m.id });
    for (const [who, name, people, note] of [
      ["alice", "阿宁", 2, "带一位朋友来，不吃辣。"],
      ["bob", "小林", 1, "想喝一碗热汤。"],
    ] as const) {
      selectActor(who);
      await run("profile.update", { name });
      await run("invitation.accept", { token: invitation.token });
      await run("selection.replace", {
        meal_id: m.id,
        items: [
          { dish_id: ids[0], quantity: 1 },
          { dish_id: who === "alice" ? ids[3] : ids[2], quantity: 1 },
        ],
        people,
        note,
        expected_revision: 0,
      });
      wx.setStorageSync("squiddy-kitchen-" + who, k.id);
      wx.setStorageSync("squiddy-meal-" + who, m.id);
    }
    selectActor("chef");
    wx.setStorageSync("squiddy-kitchen-chef", k.id);
    wx.setStorageSync("squiddy-meal-chef", m.id);
    const result = { kitchenId: k.id, mealId: m.id };
    wx.setStorageSync("squiddy-demo-seed-v1", result);
    return result;
  } finally {
    selectActor(previous);
  }
}

export function resetDemo() {
  if (seedInFlight) throw Error("正在准备演练，请稍后再重置");
  init();
  const snapshot = store!.snapshot() as any;
  const paths = new Set<string>();
  for (const row of [
    ...Object.values(snapshot.media || {}),
    ...Object.values(snapshot.file_deletions || {}),
  ] as any[]) {
    if (
      typeof row.file_id === "string" &&
      row.file_id.startsWith(wx.env.USER_DATA_PATH + "/squiddy-image-")
    )
      paths.add(row.file_id);
  }
  for (const file of paths) {
    try {
      wx.getFileSystemManager().unlinkSync(file);
    } catch (e) {
      if (
        !/no such file|not exist|ENOENT/i.test(
          String((e as any).errMsg || (e as Error).message),
        )
      )
        throw Error("演练图片未能全部清理，请稍后重试");
    }
  }
  for (const key of wx.getStorageInfoSync().keys) {
    if (
      key.startsWith("squiddy-rehearsal-") ||
      key === "squiddy-demo-seed-v1" ||
      ["chef", "alice", "bob"].some(
        (a) =>
          key === "squiddy-kitchen-" + a ||
          key === "squiddy-meal-" + a ||
          key.startsWith("squiddy-draft-v2-" + a + "-") ||
          key.startsWith("squiddy-form-v1-" + a + "-") ||
          key.startsWith("squiddy-pending-" + a + "-"),
      )
    )
      wx.removeStorageSync(key);
  }
  instance = null;
  store = null;
}
