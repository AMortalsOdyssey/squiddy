import {
  profile,
  kitchen,
  currentKitchen,
  chooseKitchen,
  chooseMeal,
  statusLabel,
  dateLabel,
  failure,
  isLocal,
} from "../../services/api";
Page({
  data: {
    local: isLocal,
    version: "0.3.0",
    loading: true,
    notify: false,
    stats: { dishes: 0, meals: 0, members: 0 },
    updates: [] as any[],
    error: "",
  },
  async onLoad() {
    try {
      const p = await profile();
      this.setData({ notify: p.features.notifications });
      const k =
        p.kitchens.find((k) => k.id === currentKitchen()) || p.kitchens[0];
      if (k) {
        const d = await kitchen(k.id);
        this.setData({
          stats: {
            dishes: d.dishes.length,
            meals: d.meals.length,
            members: d.members.length,
          },
          updates: d.meals
            .slice(0, 10)
            .map((m) => ({
              ...m,
              when: dateLabel(m.scheduled_at),
              label: statusLabel(m.status, m.served),
            })),
        });
      }
    } catch (e) {
      this.setData({ error: (e as Error).message });
    } finally {
      this.setData({ loading: false });
    }
  },
  open(e: WechatMiniprogram.TouchEvent) {
    const m = this.data.updates.find(
      (m) => m.id === e.currentTarget.dataset.id,
    );
    if (m) {
      chooseKitchen(m.kitchen_id);
      chooseMeal(m.id);
      wx.switchTab({ url: "/pages/meal/index" });
    }
  },
  async settings() {
    try {
      await wx.openSetting({ withSubscriptions: true });
    } catch (e) {
      failure(e);
    }
  },
  feedback() {
    wx.navigateTo({ url: "/pages/settings/index" });
  },
});
