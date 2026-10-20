import { mode } from "../config/runtime";
import type { Profile, Kitchen, Meal } from "./types";
export const isLocal = mode === "demo";
export function requestId(): string {
  return (
    "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12)
  );
}
export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
export async function call<T = any>(
  action: string,
  data: Record<string, unknown> = {},
): Promise<T> {
  console.info("api.start", { action });
  try {
    if (isLocal) return (await require("./local").localCall(action, data)) as T;
    const response = await wx.cloud.callFunction({
      name: "api",
      data: { action, payload: data },
    });
    const envelope = response.result as {
      ok: boolean;
      data?: T;
      error?: { code: string; message: string };
    };
    if (!envelope?.ok)
      throw new ApiError(
        envelope?.error?.code || "UNAVAILABLE",
        envelope?.error?.message || "服务暂不可用",
      );
    return envelope.data as T;
  } catch (e) {
    console.warn("api.failed", {
      action,
      code: (e as ApiError).code || "NETWORK",
    });
    throw e;
  }
}
function intentKey(action: string, data: Record<string, unknown>) {
  let a = 2166136261,
    b = 5381;
  const text = JSON.stringify(data);
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ text.charCodeAt(i);
  }
  return (
    "squiddy-pending-" +
    scope() +
    "-" +
    action +
    "-" +
    (a >>> 0).toString(16) +
    (b >>> 0).toString(16)
  );
}
export async function mutate<T = any>(
  action: string,
  data: Record<string, unknown> = {},
): Promise<T> {
  const key = intentKey(action, data);
  const stored = wx.getStorageSync(key) as
    { id: string; created: number } | undefined;
  if (stored && Date.now() - stored.created > 86400000)
    throw new ApiError(
      "CHECK_RESULT",
      "上次操作结果未确认，请先核对记录，勿重复提交",
    );
  const id = stored?.id || requestId();
  wx.setStorageSync(key, { id, created: stored?.created || Date.now() });
  try {
    const result = await call<T>(action, { ...data, request_id: id });
    wx.removeStorageSync(key);
    return result;
  } catch (error) {
    const code = (error as ApiError).code;
    if (code && !["NETWORK", "UNAVAILABLE", "TIMEOUT"].includes(code))
      wx.removeStorageSync(key);
    throw error;
  }
}
export function failure(error: unknown) {
  const e = error as Error;
  wx.showToast({
    title: e.message || "操作失败，请稍后重试",
    icon: "none",
    duration: 3500,
  });
}
function scope() {
  return isLocal ? require("./local").actor() : "wechat";
}
export function currentKitchen(): string {
  return wx.getStorageSync("squiddy-kitchen-" + scope()) || "";
}
export function chooseKitchen(id: string) {
  wx.setStorageSync("squiddy-kitchen-" + scope(), id);
  wx.removeStorageSync("squiddy-meal-" + scope());
}
export function currentMeal(): string {
  return wx.getStorageSync("squiddy-meal-" + scope()) || "";
}
export function chooseMeal(id: string) {
  wx.setStorageSync("squiddy-meal-" + scope(), id);
}
export const profile = () => call<Profile>("profile.get");
export const kitchen = (id = currentKitchen()) =>
  call<Kitchen>("kitchen.read", { kitchen_id: id });
export const meal = (id = currentMeal()) =>
  call<Meal>("meal.read", { meal_id: id });
export function draftKey(id: string) {
  return "squiddy-draft-v2-" + scope() + "-" + id;
}
function normalizeSelection(
  v: any,
): {
  items: { dish_id: string; quantity: number }[];
  note: string;
  people: number;
  revision: number;
} | null {
  if (
    !v ||
    !Array.isArray(v.items) ||
    v.items.length > 30 ||
    !Number.isInteger(v.revision) ||
    v.revision < 0
  )
    return null;
  const seen = new Set<string>(),
    items = [];
  for (const i of v.items) {
    if (
      typeof i?.dish_id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(i.dish_id) ||
      seen.has(i.dish_id) ||
      !Number.isInteger(i.quantity) ||
      i.quantity < 1 ||
      i.quantity > 20
    )
      return null;
    seen.add(i.dish_id);
    items.push({ dish_id: i.dish_id, quantity: i.quantity });
  }
  return {
    items,
    people:
      Number.isInteger(v.people) && v.people >= 1 && v.people <= 20
        ? v.people
        : 1,
    note: typeof v.note === "string" ? v.note.slice(0, 150) : "",
    revision: v.revision,
  };
}
export function loadSelection(id: string) {
  try {
    return normalizeSelection(wx.getStorageSync(draftKey(id)));
  } catch {
    return null;
  }
}
export function saveSelection(id: string, value: unknown) {
  try {
    const normalized = normalizeSelection(value);
    if (!normalized) throw Error("Invalid draft");
    wx.setStorageSync(draftKey(id), normalized);
    return true;
  } catch {
    wx.showToast({ title: "草稿保存失败，请勿离开", icon: "none" });
    return false;
  }
}
export function clearSelection(id: string) {
  wx.removeStorageSync(draftKey(id));
}
export async function publicRead(id: string) {
  if (isLocal) return require("./local").localPublicRead(id);
  const r = await wx.cloud.callFunction({
    name: "publicRead",
    data: { share_id: id },
  });
  const e = r.result as any;
  if (!e.ok) throw Error(e.error.message);
  return e.data;
}
export const money = (n: number | null | undefined) =>
  n == null ? "未填写" : (n / 100).toFixed(2);
export function parseMoney(value: string): number | null {
  const s = value.trim();
  if (!s) return null;
  if (!/^(0|[1-9]\d{0,4})(\.\d{1,2})?$/.test(s))
    throw Error("价格最多两位小数，范围0至99999.99");
  const [a, b = ""] = s.split(".");
  return Number(a) * 100 + Number(b.padEnd(2, "0"));
}
export function dateLabel(ms: number) {
  const d = new Date(ms + 8 * 3600000);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
export const statusLabel = (status: string, served = 0): string =>
  ({
    open: "正在点菜",
    locked: "已锁单",
    cooking: "正在制作",
    completed: served ? "已开饭" : "本次未开餐",
    cancelled: "已取消",
    archived: "已归档",
  })[status] || status;
export async function resolveImages(dishes: import("./types").Dish[]) {
  return Promise.all(
    dishes.map(async (d) => {
      if (!d.image_id) return d;
      try {
        const media = await call("media.read", { media_id: d.image_id });
        if (media.status !== "approved") return d;
        if (isLocal) return { ...d, image_url: media.file_id };
        const file = await call("media.url", { media_id: d.image_id });
        return { ...d, image_url: file.url };
      } catch {
        return d;
      }
    }),
  );
}
