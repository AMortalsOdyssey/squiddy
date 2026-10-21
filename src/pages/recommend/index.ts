import {
  call,
  meal,
  currentMeal,
  loadSelection,
  saveSelection,
  clearSelection,
  mutate,
  failure,
  isLocal,
} from "../../services/api";
import type { Recommendation, Meal } from "../../services/types";
Page({
  _criteriaEpoch: 0,
  data: {
    local: isLocal,
    advanced: false,
    people: "3",
    avoid: "",
    likes: "",
    maxMinutes: "60",
    vegetarian: false,
    mild: true,
    loading: false,
    busy: false,
    plans: [] as Recommendation[],
    message: "",
    meal: null as Meal | null,
  },
  async onLoad() {
    try {
      this.setData({ meal: await meal() });
      await this.generate();
    } catch (e) {
      failure(e);
    }
  },
  input(e: WechatMiniprogram.Input) {
    this._criteriaEpoch++;
    this.setData({
      [e.currentTarget.dataset.field]: e.detail.value,
      plans: [],
      message: "偏好已调整，重新搭配后再选择。",
    });
  },
  toggle(e: WechatMiniprogram.SwitchChange) {
    this._criteriaEpoch++;
    this.setData({
      [e.currentTarget.dataset.field]: e.detail.value,
      plans: [],
      message: "偏好已调整，重新搭配后再选择。",
    });
  },
  toggleAdvanced() {
    this.setData({ advanced: !this.data.advanced });
  },
  async generate() {
    if (this.data.loading) return;
    const epoch = this._criteriaEpoch;
    this.setData({ loading: true, plans: [], message: "" });
    try {
      const r = await call("recommend", {
        meal_id: currentMeal(),
        people: Number(this.data.people),
        avoid: this.data.avoid
          .split(/[、,，\n]/)
          .map((x) => x.trim())
          .filter(Boolean),
        vegetarian: this.data.vegetarian,
        mild: this.data.mild,
        likes: this.data.likes
          .split(/[、,，\n]/)
          .map((x) => x.trim())
          .filter(Boolean),
        max_minutes: Number(this.data.maxMinutes),
      });
      if (epoch !== this._criteriaEpoch) return;
      this.setData({ plans: r.plans, message: r.message });
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ loading: false });
    }
  },
  async use(e: WechatMiniprogram.TouchEvent) {
    const m = this.data.meal,
      p = this.data.plans[Number(e.currentTarget.dataset.index)];
    if (!m || !p || this.data.busy) return;
    const direct = e.currentTarget.dataset.direct === true;
    this.setData({ busy: true });
    try {
      if (m.status !== "open" || Date.now() >= m.cutoff_at)
        throw Error("本餐已停止点菜");
      const old = loadSelection(m.id) || m.selection;
      const combined = new Map(
        (direct ? [] : old.items).map((i) => [i.dish_id, i.quantity]),
      );
      for (const i of p.items)
        combined.set(
          i.dish_id,
          Math.max(combined.get(i.dish_id) || 0, i.quantity),
        );
      const draft = {
        items: Array.from(combined, ([dish_id, quantity]) => ({
          dish_id,
          quantity,
        })),
        note: old.note,
        people: Number(this.data.people),
        revision: old.revision,
      };
      if (!saveSelection(m.id, draft)) return;
      if (direct) {
        await mutate("selection.replace", {
          meal_id: m.id,
          items: draft.items,
          note: draft.note,
          people: draft.people,
          expected_revision: draft.revision,
        });
        clearSelection(m.id);
      }
      wx.showToast({
        title: direct
          ? isLocal
            ? "演练提交成功"
            : "已发送给厨师"
          : "整套已加入选择",
      });
      wx.switchTab({ url: "/pages/meal/index" });
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
});
