import {
  saveForm,
  loadForm,
  clearForm,
  warnUnsaved,
  clearUnsavedWarning,
} from "../../services/forms";
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
    draftSaved: false,
    copyId: "",
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
    this.setData({ copyId: q.copy || "" });
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
      const draft = loadForm("publish", q.copy || "");
      if (draft) {
        const answer = await wx.showModal({
          title: "继续上次安排的饭局？",
          content: "恢复未发布的时间、人数与菜单，发布前可以继续调整。",
          confirmText: "继续安排",
          cancelText: "放弃草稿",
        });
        if (answer.confirm) {
          const selected = ((draft.fields.selected as string[]) || []).filter(
            (id) => this.data.dishes.some((d) => d.id === id),
          );
          this.setData({
            ...draft.fields,
            selected,
            dishes: this.data.dishes.map((d) => ({
              ...d,
              selected: selected.includes(d.id),
            })),
            draftSaved: true,
          });
          warnUnsaved();
        } else clearForm("publish", q.copy || "");
      }
    } catch (e) {
      this.setData({ error: (e as Error).message });
    } finally {
      this.setData({ loading: false });
    }
  },
  onUnload() {
    clearUnsavedWarning();
  },
  remember() {
    this.setData({
      draftSaved: saveForm("publish", this.data.copyId, this.data),
    });
    warnUnsaved();
  },
  input(e: WechatMiniprogram.Input) {
    const field = e.currentTarget.dataset.field;
    if (!["title", "estimatedPeople", "cutoffMinutes"].includes(field)) return;
    this.setData({ [field]: e.detail.value });
    this.remember();
  },
  date(e: WechatMiniprogram.PickerChange) {
    this.setData({ date: e.detail.value as string });
    this.remember();
  },
  time(e: WechatMiniprogram.PickerChange) {
    this.setData({ time: e.detail.value as string });
    this.remember();
  },
  select(e: WechatMiniprogram.CheckboxGroupChange) {
    const selected = e.detail.value;
    this.setData({
      selected,
      dishes: this.data.dishes.map((d) => ({
        ...d,
        selected: selected.includes(d.id),
      })),
    });
    this.remember();
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
      clearForm("publish", this.data.copyId);
      clearUnsavedWarning();
      chooseMeal(result.id);
      wx.switchTab({ url: "/pages/meal/index" });
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
});
