import {
  kitchen,
  meal,
  currentMeal,
  loadSelection,
  saveSelection,
  resolveImages,
  failure,
  isLocal,
} from "../../services/api";
import type { Dish, Meal } from "../../services/types";
Page({
  data: {
    local: isLocal,
    loading: true,
    error: "",
    dish: null as Dish | null,
    meal: null as Meal | null,
    quantity: 0,
    canOrder: false,
    steps: [] as string[],
    variantIndex: 0,
    optionIndexes: [] as number[],
    optionLabels: [] as string[],
    allergenText: "",
    nutritionRows: [] as { name: string; value: string }[],
  },
  async onLoad(q: Record<string, string>) {
    try {
      const k = await kitchen();
      const mid = currentMeal();
      const m =
        mid && k.meals.some((x) => x.id === mid) ? await meal(mid) : null;
      const d =
        m?.menu.find((x) => x.id === q.id) ||
        k.dishes.find((x) => x.id === q.id);
      if (!d) throw Error("这道菜已不可查看，请返回菜单刷新");
      const [dish] = await resolveImages([d]);
      const draft = m ? loadSelection(m.id) || m.selection : null;
      this.setData({
        dish,
        allergenText: d.allergens.join("、"),
        variantIndex: Math.max(
          0,
          (d.variants || []).indexOf(
            draft?.items.find((x) => x.dish_id === d.id)?.variant || "",
          ),
        ),
        optionIndexes: (d.attributes || []).map((a) =>
          Math.max(
            0,
            a.options.indexOf(
              draft?.items
                .find((x) => x.dish_id === d.id)
                ?.options?.find((o) => o.name === a.name)?.value || "",
            ),
          ),
        ),
        optionLabels: (d.attributes || []).map(
          (a) =>
            draft?.items
              .find((x) => x.dish_id === d.id)
              ?.options?.find((o) => o.name === a.name)?.value || a.options[0],
        ),
        nutritionRows: d.nutrition?.visible
          ? [
              ["calories", "能量", "kcal"],
              ["protein", "蛋白质", "g"],
              ["fat", "脂肪", "g"],
              ["carbs", "碳水", "g"],
              ["fiber", "膳食纤维", "g"],
            ].map(([key, name, unit]) => ({
              name,
              value:
                d.nutrition![key as "calories"] == null
                  ? "未知"
                  : d.nutrition![key as "calories"] + " " + unit,
            }))
          : [],
        meal: m,
        quantity: draft?.items.find((x) => x.dish_id === d.id)?.quantity || 0,
        canOrder:
          !!m &&
          m.status === "open" &&
          d.active &&
          m.menu.some((x) => x.id === d.id) &&
          Date.now() < m.cutoff_at,
        steps: d.steps
          .split(/\n+/)
          .map((x) => x.trim())
          .filter(Boolean),
      });
      wx.setNavigationBarTitle({ title: d.name });
    } catch (e) {
      this.setData({ error: (e as Error).message });
    } finally {
      this.setData({ loading: false });
    }
  },
  source() {
    if (this.data.dish?.source_url)
      void wx.setClipboardData({ data: this.data.dish.source_url });
  },
  variant(e: WechatMiniprogram.PickerChange) {
    this.setData({ variantIndex: Number(e.detail.value) });
    this.updateOptions();
  },
  option(e: WechatMiniprogram.PickerChange) {
    const i = Number(e.currentTarget.dataset.index),
      n = Number(e.detail.value);
    this.setData({
      ["optionIndexes[" + i + "]"]: n,
      ["optionLabels[" + i + "]"]:
        this.data.dish?.attributes?.[i].options[n] || "",
    });
    this.updateOptions();
  },
  updateOptions() {
    const m = this.data.meal,
      d = this.data.dish;
    if (!m || !d || !this.data.canOrder || Date.now() >= m.cutoff_at) return;
    const old = loadSelection(m.id) || m.selection;
    const items = old.items.map((i) =>
      i.dish_id === d.id ? { ...i, ...this.selectedOptions() } : i,
    );
    saveSelection(m.id, { ...old, items });
  },
  selectedOptions() {
    const d = this.data.dish;
    return {
      ...(d?.variants?.length
        ? { variant: d.variants[this.data.variantIndex] }
        : {}),
      ...(d?.attributes?.length
        ? {
            options: d.attributes.map((a, i) => ({
              name: a.name,
              value: a.options[this.data.optionIndexes[i] || 0],
            })),
          }
        : {}),
    };
  },
  change(e: WechatMiniprogram.TouchEvent) {
    const m = this.data.meal,
      d = this.data.dish;
    if (!m || !d || !this.data.canOrder || Date.now() >= m.cutoff_at) {
      wx.showToast({ title: "本餐已停止点菜", icon: "none" });
      return;
    }
    const delta = Number(e.currentTarget.dataset.delta);
    if (![-1, 1].includes(delta)) return;
    const old = loadSelection(m.id) || m.selection;
    const quantity = Math.max(
      0,
      Math.min(
        20,
        (old.items.find((x) => x.dish_id === d.id)?.quantity || 0) + delta,
      ),
    );
    const items = old.items.filter((x) => x.dish_id !== d.id);
    if (quantity)
      items.push({ dish_id: d.id, quantity, ...this.selectedOptions() });
    if (saveSelection(m.id, { ...old, items })) this.setData({ quantity });
  },
  review() {
    wx.switchTab({ url: "/pages/meal/index" });
  },
  back() {
    wx.navigateBack();
  },
  preview() {
    const url = this.data.dish?.image_url;
    if (url) wx.previewImage({ urls: [url], current: url });
  },
});
