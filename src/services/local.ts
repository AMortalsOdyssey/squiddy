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
    const result = await cleanupBatch(store, uid);
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
      const result = await cleanupBatch(store, id);
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
