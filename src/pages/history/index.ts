import {
  profile,
  kitchen,
  currentKitchen,
  currentMeal,
  chooseKitchen,
  chooseMeal,
  statusLabel,
  dateLabel,
  failure,
  isLocal,
} from "../../services/api";
import type { KitchenSummary, MealSummary } from "../../services/types";
type MealRow = MealSummary & { label: string; when: string };
Page({
  data: {
    local: isLocal,
    loading: true,
    error: "",
    kitchens: [] as KitchenSummary[],
    kitchenIndex: 0,
    kitchenId: "",
    search: "",
    filter: "all",
    meals: [] as MealRow[],
    visible: [] as MealRow[],
    activeCount: 0,
    currentId: "",
  },
  onShow() {
    void this.refresh();
  },
  async onPullDownRefresh() {
    await this.refresh();
    wx.stopPullDownRefresh();
  },
  async refresh() {
    this.setData({ loading: true, error: "", meals: [], visible: [] });
    try {
      const p = await profile();
      const id = this.data.kitchenId || currentKitchen();
      const i = Math.max(
        0,
        p.kitchens.findIndex((k) => k.id === id),
      );
      this.setData({
        kitchens: p.kitchens,
        kitchenIndex: i,
        kitchenId: p.kitchens[i]?.id || "",
        currentId: currentMeal(),
      });
      if (!p.kitchens.length) return;
      const k = await kitchen(p.kitchens[i].id);
      const meals = k.meals
        .map((m) => ({
          ...m,
          label: statusLabel(m.status, m.served),
          when: dateLabel(m.scheduled_at),
        }))
        .sort((a, b) => b.scheduled_at - a.scheduled_at);
      this.setData({
        meals,
        activeCount: meals.filter((m) =>
          ["open", "locked", "cooking"].includes(m.status),
        ).length,
      });
      this.filterRows();
    } catch (e) {
      this.setData({ error: (e as Error).message });
    } finally {
      this.setData({ loading: false });
    }
  },
  search(e: WechatMiniprogram.Input) {
    this.setData({ search: e.detail.value });
    this.filterRows();
  },
  filter(e: WechatMiniprogram.TouchEvent) {
    this.setData({ filter: e.currentTarget.dataset.filter });
    this.filterRows();
  },
  filterRows() {
    const q = this.data.search.trim().toLowerCase();
    this.setData({
      visible: this.data.meals.filter(
        (m) =>
          (m.title + " " + m.when).toLowerCase().includes(q) &&
          (this.data.filter === "all" ||
            (this.data.filter === "active"
              ? ["open", "locked", "cooking"].includes(m.status)
              : ["completed", "archived", "cancelled"].includes(m.status))),
      ),
    });
  },
  async switchKitchen(e: WechatMiniprogram.PickerChange) {
    const i = Number(e.detail.value);
    const k = this.data.kitchens[i];
    if (k) {
      this.setData({ kitchenId: k.id, kitchenIndex: i });
      await this.refresh();
    }
  },
  open(e: WechatMiniprogram.TouchEvent) {
    const m = this.data.meals.find((x) => x.id === e.currentTarget.dataset.id);
    if (!m) return;
    chooseKitchen(m.kitchen_id);
    chooseMeal(m.id);
    wx.switchTab({ url: "/pages/meal/index" });
  },
  create() {
    if (this.data.kitchenId) {
      chooseKitchen(this.data.kitchenId);
      wx.navigateTo({ url: "/pages/publish/index" });
    } else wx.navigateTo({ url: "/pages/kitchen/index?create=1" });
  },
});
