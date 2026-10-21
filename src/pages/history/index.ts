import {
  profile,
  call,
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
    dateIndex: 0,
    dateOptions: ["不限日期", "今天", "近3天", "近7天", "近30天"],
    statusIndex: 0,
    statusOptions: [
      "全部状态",
      "正在点菜",
      "已锁单",
      "正在制作",
      "已完成",
      "已归档",
      "已取消",
    ],
    meals: [] as MealRow[],
    visible: [] as MealRow[],
    activeCount: 0,
    currentId: "",
    nextCursor: "",
    total: 0,
    loadingMore: false,
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
      const result = await call("history.read", {
        kitchen_id: p.kitchens[i].id,
      });
      const meals: MealRow[] = result.items
        .map((m: MealSummary) => ({
          ...m,
          label: statusLabel(m.status, m.served),
          when: dateLabel(m.scheduled_at),
        }))
        .sort((a: MealRow, b: MealRow) => b.scheduled_at - a.scheduled_at);
      this.setData({
        meals,
        nextCursor: result.next_cursor,
        total: result.total,
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
  async loadMore() {
    if (!this.data.nextCursor || this.data.loadingMore) return;
    const kid = this.data.kitchenId;
    this.setData({ loadingMore: true });
    try {
      const r = await call("history.read", {
        kitchen_id: kid,
        cursor: this.data.nextCursor,
      });
      if (kid !== this.data.kitchenId) return;
      const known = new Set(this.data.meals.map((m) => m.id));
      const more = r.items
        .filter((m: MealSummary) => !known.has(m.id))
        .map((m: MealSummary) => ({
          ...m,
          label: statusLabel(m.status, m.served),
          when: dateLabel(m.scheduled_at),
        }));
      this.setData({
        meals: [...this.data.meals, ...more],
        nextCursor: r.next_cursor,
      });
      this.filterRows();
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ loadingMore: false });
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
  dates(e: WechatMiniprogram.PickerChange) {
    this.setData({ dateIndex: Number(e.detail.value) });
    this.filterRows();
  },
  statuses(e: WechatMiniprogram.PickerChange) {
    this.setData({ statusIndex: Number(e.detail.value) });
    this.filterRows();
  },
  filterRows() {
    const q = this.data.search.trim().toLowerCase();
    const now = Date.now(),
      day = Math.floor((now + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
    const days = [0, 1, 3, 7, 30][this.data.dateIndex],
      start = days ? day - (days - 1) * 86400000 : 0;
    const status = [
      "",
      "open",
      "locked",
      "cooking",
      "completed",
      "archived",
      "cancelled",
    ][this.data.statusIndex];
    this.setData({
      activeCount: this.data.meals.filter((m) =>
        ["open", "locked", "cooking"].includes(m.status),
      ).length,
      visible: this.data.meals.filter(
        (m) =>
          (m.title + " " + m.when).toLowerCase().includes(q) &&
          (!days ||
            (m.scheduled_at >= start && m.scheduled_at < day + 86400000)) &&
          (!status || m.status === status) &&
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
