import {
  kitchen,
  meal,
  currentKitchen,
  mutate,
  chooseMeal,
  failure,
  isLocal,
} from "../../services/api";
Page({
  data: {
    local: isLocal,
    loading: true,
    busy: false,
    title: "一起吃顿饭",
    estimatedPeople: "4",
    date: "",
    time: "18:30",
    cutoffMinutes: "30",
    dishes: [] as any[],
    selected: [] as string[],
    error: "",
  },
  async onLoad(q: Record<string, string>) {
    const now = new Date(Date.now() + 86400000 + 8 * 3600000);
    this.setData({ date: now.toISOString().slice(0, 10) });
    try {
      const k = await kitchen();
      if (k.role === "member") throw Error("只有厨房管理员可以发起饭局");
      this.setData({
        dishes: k.dishes
          .filter((d) => d.active)
          .map((d, i) => ({ ...d, selected: i < 30 })),
        selected: k.dishes
          .filter((d) => d.active)
          .slice(0, 30)
          .map((d) => d.id),
      });
      if (q.copy) {
        const old = await meal(q.copy);
        const ids = new Set(old.menu.map((d) => d.id));
        this.setData({
          title: old.title,
          estimatedPeople: String(old.estimated_people),
          selected: k.dishes
            .filter((d) => d.active && ids.has(d.id))
            .map((d) => d.id),
          dishes: this.data.dishes.map((d) => ({
            ...d,
            selected: ids.has(d.id),
          })),
        });
      }
    } catch (e) {
      this.setData({ error: (e as Error).message });
    } finally {
      this.setData({ loading: false });
    }
  },
  input(e: WechatMiniprogram.Input) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  date(e: WechatMiniprogram.PickerChange) {
    this.setData({ date: e.detail.value as string });
  },
  time(e: WechatMiniprogram.PickerChange) {
    this.setData({ time: e.detail.value as string });
  },
  select(e: WechatMiniprogram.CheckboxGroupChange) {
    this.setData({ selected: e.detail.value });
  },
  async publish() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      const scheduled = Date.parse(
        this.data.date + "T" + this.data.time + ":00+08:00",
      );
      const minutes = Number(this.data.cutoffMinutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)
        throw Error("提前截止时间须为1至1440分钟");
      const result = await mutate("meal.publish", {
        kitchen_id: currentKitchen(),
        title: this.data.title,
        estimated_people: Number(this.data.estimatedPeople),
        dish_ids: this.data.selected,
        scheduled_at: scheduled,
        cutoff_at: scheduled - minutes * 60000,
      });
      chooseMeal(result.id);
      wx.switchTab({ url: "/pages/meal/index" });
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
});
