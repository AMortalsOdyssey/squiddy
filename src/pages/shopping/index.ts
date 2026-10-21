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
    list: null as any,
    editing: "",
    name: "",
    amount: "",
    note: "",
  },
  onShow() {
    void this.refresh();
  },
  onHide() {
    this._epoch++;
    this.setData({ list: null, editing: "", name: "", amount: "", note: "" });
  },
  onUnload() {
    this._epoch++;
  },
  async onPullDownRefresh() {
    await this.refresh();
    wx.stopPullDownRefresh();
  },
  async refresh() {
    const epoch = ++this._epoch,
      mid = currentMeal();
    this.setData({ loading: true, error: "" });
    try {
      const list = await call("shopping.read", { meal_id: mid });
      if (epoch !== this._epoch || mid !== currentMeal()) return;
      list.items = list.items.map((i: any) => ({
        ...i,
        sources: i.sources.map((s: any) => ({
          ...s,
          name:
            list.lines.find((l: any) => l.line_id === s.line_id)?.name ||
            "原制作项目",
        })),
      }));
      this.setData({ list });
    } catch (e) {
      if (epoch !== this._epoch || mid !== currentMeal()) return;
      this.setData({ error: (e as Error).message, list: null });
    } finally {
      if (epoch === this._epoch) this.setData({ loading: false });
    }
  },
  input(e: WechatMiniprogram.Input) {
    const f = e.currentTarget.dataset.field;
    if (["name", "amount", "note"].includes(f))
      this.setData({ [f]: e.detail.value });
  },
  add() {
    this.setData({ editing: "new", name: "", amount: "", note: "" });
  },
  edit(e: WechatMiniprogram.TouchEvent) {
    const i = this.data.list.items.find(
      (i: any) => i.id === e.currentTarget.dataset.id,
    );
    if (i?.can_edit)
      this.setData({
        editing: i.id,
        name: i.name,
        amount: i.amount,
        note: i.note,
      });
  },
  cancel() {
    this.setData({ editing: "", name: "", amount: "", note: "" });
  },
  async run(action: string, payload: Record<string, unknown> = {}) {
    if (this.data.busy || !this.data.list) return false;
    this.setData({ busy: true });
    try {
      await mutate(action, {
        meal_id: currentMeal(),
        expected_revision: this.data.list.revision,
        ...payload,
      });
      await this.refresh();
      return true;
    } catch (e) {
      failure(e);
      return false;
    } finally {
      this.setData({ busy: false });
    }
  },
  async generate() {
    const r = await wx.showModal({
      title: "按实际制作计划更新清单",
      content:
        "合并名称完全一致的食材，保留现有勾选、认领、手填用量和手动项目。已不在计划中的自动项目会移除；用量请与厨师确认。",
    });
    if (r.confirm) await this.run("shopping.generate");
  },
  async save() {
    const p = {
      name: this.data.name,
      amount: this.data.amount,
      note: this.data.note,
      ...(this.data.editing === "new" ? {} : { item_id: this.data.editing }),
    };
    if (
      await this.run(
        this.data.editing === "new" ? "shopping.add" : "shopping.update",
        p,
      )
    )
      this.cancel();
  },
  check(e: WechatMiniprogram.TouchEvent) {
    const i = this.data.list.items.find(
      (i: any) => i.id === e.currentTarget.dataset.id,
    );
    if (i)
      return this.run("shopping.check", { item_id: i.id, checked: !i.checked });
  },
  claim(e: WechatMiniprogram.TouchEvent) {
    const i = this.data.list.items.find(
      (i: any) => i.id === e.currentTarget.dataset.id,
    );
    if (i)
      return this.run("shopping.claim", {
        item_id: i.id,
        claimed: !i.claimed_name,
      });
  },
  async remove(e: WechatMiniprogram.TouchEvent) {
    const r = await wx.showModal({
      title: "移除这项采购",
      content: "自动项目下次按计划更新时可能再次出现。",
    });
    if (r.confirm)
      await this.run("shopping.remove", {
        item_id: e.currentTarget.dataset.id,
      });
  },
});
