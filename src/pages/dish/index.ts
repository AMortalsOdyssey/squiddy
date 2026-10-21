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
    if (quantity) items.push({ dish_id: d.id, quantity });
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
