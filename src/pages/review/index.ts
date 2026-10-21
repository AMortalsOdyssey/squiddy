import {
  call,
  mutate,
  currentMeal,
  failure,
  isLocal,
} from "../../services/api";
Page({
  _epoch: 0,
  data: {
    local: isLocal,
    loading: true,
    busy: false,
    error: "",
    review: null as any,
    rows: [] as any[],
    note: "",
    showAll: false,
  },
  onShow() {
    void this.refresh();
  },
  onHide() {
    this._epoch++;
    this.setData({ review: null, rows: [], note: "", showAll: false });
  },
  onUnload() {
    this._epoch++;
  },
  async refresh() {
    const epoch = ++this._epoch,
      mid = currentMeal();
    this.setData({ loading: true, error: "" });
    try {
      const r = await call("meal.review.read", { meal_id: mid });
      if (epoch !== this._epoch || mid !== currentMeal()) return;
      r.feedback = this.feedbackNames(r);
      this.setData({
        review: r,
        note: r.own.note,
        rows: r.served.map((d: any) => {
          const i = r.own.items.find((i: any) => i.line_id === d.line_id);
          return {
            ...d,
            note: i?.note || "",
            tags: r.tags.map((tag: string) => ({
              label: tag,
              selected: !!i?.tags.includes(tag),
            })),
          };
        }),
      });
    } catch (e) {
      if (epoch !== this._epoch || mid !== currentMeal()) return;
      this.setData({
        error: (e as Error).message,
        review: null,
        rows: [],
        note: "",
        showAll: false,
      });
    } finally {
      if (epoch === this._epoch) this.setData({ loading: false });
    }
  },
  tag(e: WechatMiniprogram.TouchEvent) {
    const { index, tag } = e.currentTarget.dataset;
    const row = this.data.rows[Number(index)];
    const t = row.tags[Number(tag)];
    if (!t.selected && row.tags.filter((t: any) => t.selected).length >= 3) {
      failure(Error("每道菜最多选3个标签"));
      return;
    }
    this.setData({
      ["rows[" + index + "].tags[" + tag + "].selected"]: !t.selected,
    });
  },
  input(e: WechatMiniprogram.Input) {
    const i = e.currentTarget.dataset.index;
    if (i === undefined) this.setData({ note: e.detail.value });
    else this.setData({ ["rows[" + Number(i) + "].note"]: e.detail.value });
  },
  feedbackNames(r: any) {
    return r.feedback.map((f: any) => ({
      ...f,
      items: f.items.map((i: any) => ({
        ...i,
        name:
          r.served.find((d: any) => d.line_id === i.line_id)?.name ||
          "已上桌菜品",
      })),
    }));
  },
  async loadMore() {
    if (this.data.busy) return;
    const epoch = this._epoch,
      mid = currentMeal();
    this.setData({ busy: true });
    try {
      const r = await call("meal.review.read", {
        meal_id: mid,
        feedback_offset: this.data.review.feedback.length,
      });
      if (epoch !== this._epoch || mid !== currentMeal()) return;
      this.setData({
        "review.feedback": [
          ...this.data.review.feedback,
          ...this.feedbackNames(r),
        ],
        "review.feedback_total": r.feedback_total,
      });
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
  toggleAll() {
    this.setData({ showAll: !this.data.showAll });
  },
  async save() {
    if (this.data.busy || !this.data.review?.available) return;
    this.setData({ busy: true });
    try {
      await mutate("meal.review.save", {
        meal_id: currentMeal(),
        expected_revision: this.data.review.own.revision,
        note: this.data.note,
        items: this.data.rows
          .filter((r) => r.note.trim() || r.tags.some((t: any) => t.selected))
          .map((r) => ({
            line_id: r.line_id,
            note: r.note,
            tags: r.tags
              .filter((t: any) => t.selected)
              .map((t: any) => t.label),
          })),
      });
      await this.refresh();
      wx.showToast({ title: "心意已经送达", icon: "success" });
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
});
