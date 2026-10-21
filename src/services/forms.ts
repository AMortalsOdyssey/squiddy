import { scope, currentKitchen } from "./api";
const fields: Record<string, string[]> = {
  editor: [
    "name",
    "ingredients",
    "allergens",
    "steps",
    "minutes",
    "defaultServes",
    "ingredientComplete",
    "categoryIndex",
    "vegetarian",
    "spicy",
    "active",
  ],
  publish: [
    "title",
    "estimatedPeople",
    "date",
    "time",
    "cutoffMinutes",
    "selected",
  ],
};
function key(kind: string, id: string) {
  return (
    "squiddy-form-v1-" +
    scope() +
    "-" +
    kind +
    "-" +
    currentKitchen() +
    "-" +
    (id || "new")
  );
}
function allowed(kind: string, data: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const name of fields[kind] || []) {
    const v = data[name];
    if (
      (typeof v === "string" && v.length <= 5000) ||
      typeof v === "boolean" ||
      (typeof v === "number" && Number.isFinite(v))
    )
      out[name] = v;
    else if (
      name === "selected" &&
      Array.isArray(v) &&
      v.length <= 30 &&
      v.every((x) => typeof x === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(x))
    )
      out[name] = v.slice();
  }
  return out;
}
export function saveForm(
  kind: string,
  id: string,
  data: Record<string, unknown>,
  revision = 0,
) {
  try {
    wx.setStorageSync(key(kind, id), {
      fields: allowed(kind, data),
      revision,
      updated: Date.now(),
    });
    return true;
  } catch {
    return false;
  }
}
export function loadForm(
  kind: string,
  id: string,
): { fields: Record<string, unknown>; revision: number } | null {
  try {
    const v = wx.getStorageSync(key(kind, id));
    if (
      !v ||
      !v.fields ||
      typeof v.fields !== "object" ||
      !Number.isInteger(v.revision) ||
      !Number.isFinite(v.updated) ||
      Date.now() - v.updated > 7 * 86400000 ||
      v.updated > Date.now() + 60000
    )
      return null;
    return { fields: allowed(kind, v.fields), revision: v.revision };
  } catch {
    return null;
  }
}
export function clearForm(kind: string, id: string) {
  wx.removeStorageSync(key(kind, id));
}
export function warnUnsaved() {
  try {
    if (typeof wx.enableAlertBeforeUnload === "function")
      void Promise.resolve(
        wx.enableAlertBeforeUnload({
          message: "还有未保存的修改。文字已暂存，图片与内部价格请先保存。",
        }),
      ).catch(() => {});
  } catch {}
}
export function clearUnsavedWarning() {
  try {
    if (typeof wx.disableAlertBeforeUnload === "function")
      void Promise.resolve(wx.disableAlertBeforeUnload()).catch(() => {});
  } catch {}
}
