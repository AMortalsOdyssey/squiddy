import {
  meal,
  currentMeal,
  kitchen,
  mutate,
  failure,
  isLocal,
  money,
  parseMoney,
  dateLabel,
  statusLabel,
  loadSelection,
  saveSelection,
  clearSelection,
  profile,
  publicRead,
} from "../../services/api";
import type { Meal } from "../../services/types";
let timer: ReturnType<typeof setInterval> | null = null;
Page({
  _epoch: 0,
  data: {
    publicMode: false,
    publicPreview: null as any,
    shareId: "",
    local: isLocal,
    loading: true,
    busy: false,
    error: "",
    meal: null as Meal | null,
    status: "",
    when: "",
    cutoff: "",
    draft: [] as any[],
    note: "",
    people: "1",
    selectionRevision: 0,
    stale: false,
    plans: [] as any[],
    prices: [] as any[],
    total: "",
    unpriced: 0,
    inviteToken: "",
    invitationId: "",
    publicShareId: "",
    notifyAvailable: false,
    templateId: "",
    notificationState: "",
    pollFailed: false,
  },
  onLoad(q: Record<string, string>) {
    if (q.share) {
      this.setData({ publicMode: true, shareId: q.share });
      return;
    }
    if (q.id) require("../../services/api").chooseMeal(q.id);
  },
  onShow() {
    if (this.data.publicMode) {
      void this.loadPublic();
      return;
    }
    void this.refresh();
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (!this.data.busy) void this.refresh(true);
    }, 15000);
  },
  onHide() {
    this._epoch++;
    if (timer) clearInterval(timer);
    timer = null;
    this.setData({ meal: null, prices: [], total: "", unpriced: 0, plans: [] });
  },
  onUnload() {
    this._epoch++;
    if (timer) clearInterval(timer);
    timer = null;
  },
  async loadPublic() {
    this.setData({ publicPreview: null });
    try {
      this.setData({
        publicPreview: await publicRead(this.data.shareId),
        loading: false,
        error: "",
      });
    } catch (e) {
      this.setData({ error: (e as Error).message, loading: false });
    }
  },
  async onPullDownRefresh() {
    await this.refresh();
    wx.stopPullDownRefresh();
  },
  async refresh(poll = false) {
    if (this.data.publicMode) {
      await this.loadPublic();
      return;
    }
    const epoch = ++this._epoch;
    const mid = currentMeal();
    if (!mid) {
      this.setData({ loading: false, meal: null });
      return;
    }
    if (!poll) this.setData({ loading: true, error: "" });
    try {
      const m = await meal(mid);
      if (epoch !== this._epoch) return;
      const local = loadSelection(mid),
        draft = local || m.selection;
      const plans =
        m.summary
          ?.filter((x) => x.people > 0)
          .map((x) => ({
            ...x,
            quantity: Math.min(20, x.requested_quantity),
          })) || [];
      this.setData({
        meal: m,
        status: statusLabel(m.status, m.served),
        when: dateLabel(m.scheduled_at),
        cutoff: dateLabel(m.cutoff_at),
        draft: draft.items.map((i) => ({
          ...i,
          name: m.menu.find((d) => d.id === i.dish_id)?.name || "已不可用菜品",
        })),
        note: draft.note,
        people: String(draft.people || 1),
        selectionRevision: draft.revision,
        stale: !!local && local.revision !== m.selection.revision,
        plans: poll && this.data.plans.length ? this.data.plans : plans,
        prices:
          m.role === "cook"
            ? (m.chef_prices || []).map((p) => ({
                ...p,
                value:
                  p.unit_price_minor == null ? "" : money(p.unit_price_minor),
              }))
            : [],
        total: money(m.chef_quote?.total_known_minor),
        unpriced: m.chef_quote?.unpriced_count || 0,
        pollFailed: false,
      });
      if (!poll) {
        const p = await profile();
        if (epoch !== this._epoch) return;
        this.setData({
          notifyAvailable: p.features.notifications,
          templateId: p.features.template_id,
        });
      }
    } catch (e) {
      if (epoch !== this._epoch) return;
      if (poll) this.setData({ pollFailed: true });
      else this.setData({ error: (e as Error).message });
      this.setData({
        meal: null,
        prices: [],
        plans: [],
        total: "",
        unpriced: 0,
      });
    } finally {
      this.setData({ loading: false });
    }
  },
  peopleInput(e: WechatMiniprogram.Input) {
    this.setData({ people: e.detail.value });
    this.saveDraft();
  },
  removeDraft(e: WechatMiniprogram.TouchEvent) {
    this.setData({
      draft: this.data.draft.filter(
        (_, i) => i !== Number(e.currentTarget.dataset.index),
      ),
    });
    this.saveDraft();
  },
  noteInput(e: WechatMiniprogram.Input) {
    this.setData({ note: e.detail.value });
    this.saveDraft();
  },
  saveDraft() {
    const m = this.data.meal;
    if (m)
      saveSelection(m.id, {
        items: this.data.draft.map((i) => ({
          dish_id: i.dish_id,
          quantity: i.quantity,
        })),
        note: this.data.note,
        people: Number(this.data.people),
        revision: this.data.selectionRevision,
      });
  },
  async restoreServer() {
    const confirm = await wx.showModal({
      title: "载入已提交的选择",
      content: "本机未提交的修改会被替换。",
    });
    if (!confirm.confirm) return;
    clearSelection(currentMeal());
    await this.refresh();
  },
  async submit() {
    const m = this.data.meal;
    if (!m || this.data.busy) return;
    this.saveDraft();
    this.setData({ busy: true });
    try {
      await mutate("selection.replace", {
        meal_id: m.id,
        items: this.data.draft.map((i) => ({
          dish_id: i.dish_id,
          quantity: i.quantity,
        })),
        note: this.data.note,
        people: Number(this.data.people),
        expected_revision: this.data.selectionRevision,
      });
      clearSelection(m.id);
      await this.refresh();
      wx.showToast({
        title: isLocal ? "演练提交成功" : "已发送给厨师",
        icon: "success",
      });
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
  back() {
    wx.switchTab({ url: "/pages/menu/index" });
  },
  manage() {
    wx.navigateTo({ url: "/pages/kitchen/index" });
  },
  recommend() {
    wx.navigateTo({ url: "/pages/recommend/index" });
  },
  async action(e: WechatMiniprogram.TouchEvent) {
    const m = this.data.meal;
    if (!m || this.data.busy) return;
    const action = e.currentTarget.dataset.action as string;
    const descriptions: Record<string, string> = {
      "meal.lock": "锁单后朋友不能再改选择。你还需要确认实际制作份数。",
      "meal.cancel": "取消后本餐将停止接单。",
      "meal.archive": "归档后可以在厨房历史记录中查看。",
      "meal.unlock": "重新开放点菜，截止时间改为当前时间30分钟后。",
    };
    if (!descriptions[action]) return;
    const confirm = await wx.showModal({
      title: "确认操作",
      content: descriptions[action],
    });
    if (!confirm.confirm) return;
    this.setData({ busy: true });
    try {
      await mutate(action, {
        meal_id: m.id,
        expected_revision: m.revision,
        ...(action === "meal.unlock"
          ? { cutoff_at: Math.min(m.scheduled_at, Date.now() + 30 * 60000) }
          : {}),
      });
      await this.refresh();
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
  planInput(e: WechatMiniprogram.Input) {
    const i = Number(e.currentTarget.dataset.index);
    this.setData({ ["plans[" + i + "].quantity"]: e.detail.value });
  },
  async confirmPlan() {
    const m = this.data.meal;
    if (!m || this.data.busy) return;
    const confirm = await wx.showModal({
      title: "确认实际制作份数",
      content: "填0表示明确不做。制作开始前可重新开放，届时需要重新确认份数。",
    });
    if (!confirm.confirm) return;
    this.setData({ busy: true });
    try {
      const items = [];
      for (const i of this.data.plans) {
        let reason = "";
        if (Number(i.quantity) === 0) {
          const r = await wx.showModal({
            title: i.name + "不做的原因",
            editable: true,
            placeholderText: "例如：食材不足",
          });
          if (!r.confirm) return;
          reason = r.content || "";
        }
        items.push({
          dish_id: i.dish_id,
          quantity: Number(i.quantity),
          reason,
        });
      }
      await mutate("plan.confirm", {
        meal_id: m.id,
        expected_revision: m.revision,
        items,
      });
      await this.refresh();
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
  async transition(e: WechatMiniprogram.TouchEvent) {
    const m = this.data.meal;
    if (!m || this.data.busy) return;
    const { id, status } = e.currentTarget.dataset;
    let reason = "";
    if (status === "skipped") {
      const r = await wx.showModal({
        title: "这道菜不做了",
        content: "请说明原因，所有参与者可见。",
        editable: true,
        placeholderText: "例如：食材不足",
      });
      if (!r.confirm) return;
      reason = r.content || "";
    }
    this.setData({ busy: true });
    try {
      await mutate("item.transition", {
        meal_id: m.id,
        dish_id: id,
        status,
        reason,
        expected_revision: m.revision,
      });
      await this.refresh();
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
  priceInput(e: WechatMiniprogram.Input) {
    const i = Number(e.currentTarget.dataset.index);
    this.setData({ ["prices[" + i + "].value"]: e.detail.value });
  },
  async priceSave(e: WechatMiniprogram.TouchEvent) {
    const m = this.data.meal;
    if (!m?.chef_quote || this.data.busy) return;
    const p = this.data.prices[Number(e.currentTarget.dataset.index)];
    this.setData({ busy: true });
    try {
      await mutate("price.update", {
        meal_id: m.id,
        dish_id: p.dish_id,
        unit_price_minor: parseMoney(p.value),
        expected_revision: m.chef_quote.revision,
      });
      await this.refresh();
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
  async invitation() {
    const m = this.data.meal;
    if (!m || this.data.busy) return;
    this.setData({ busy: true });
    try {
      const i = await mutate("invitation.create", { meal_id: m.id });
      this.setData({ inviteToken: i.token, invitationId: i.id });
      if (!isLocal) wx.showShareMenu({ menus: ["shareAppMessage"] });
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
  async copyInvite() {
    if (this.data.inviteToken)
      await wx.setClipboardData({ data: this.data.inviteToken });
  },
  async revokeInvite() {
    if (!this.data.invitationId) return;
    try {
      await mutate("invitation.revoke", {
        invitation_id: this.data.invitationId,
      });
      this.setData({ inviteToken: "", invitationId: "" });
      wx.showToast({ title: "邀请已撤销" });
    } catch (e) {
      failure(e);
    }
  },
  async publicShare() {
    const m = this.data.meal;
    if (!m) return;
    const confirm = await wx.showModal({
      title: "公开这份菜单摘要",
      content:
        "生成的分享只展示饭局标题和菜名，不含成员、时间、点菜记录、邀请口令或价格。持有链接的人可查看。",
    });
    if (!confirm.confirm) return;
    try {
      const s = await mutate("share.create", { meal_id: m.id });
      this.setData({ publicShareId: s.id });
      if (!isLocal)
        wx.showShareMenu({ menus: ["shareAppMessage", "shareTimeline"] });
    } catch (e) {
      failure(e);
    }
  },
  poster() {
    if (this.data.publicShareId)
      wx.navigateTo({
        url: "/pages/poster/index?share=" + this.data.publicShareId,
      });
  },
  async revokePublic() {
    try {
      await mutate("share.revoke", { share_id: this.data.publicShareId });
      this.setData({ publicShareId: "" });
    } catch (e) {
      failure(e);
    }
  },
  onShareAppMessage() {
    return this.data.inviteToken
      ? {
          title: this.data.meal?.title || "一起来点菜",
          path: "/pages/invite/index?token=" + this.data.inviteToken,
        }
      : { title: "一桌好饭，从这里开始", path: "/pages/menu/index" };
  },
  onShareTimeline() {
    return {
      title: this.data.meal?.title || "一桌好饭",
      query: this.data.publicShareId ? "share=" + this.data.publicShareId : "",
    };
  },
  async assign() {
    const m = this.data.meal;
    if (!m) return;
    try {
      const members = m.cook_candidates || [];
      if (!members.length) throw Error("请先邀请其他成员加入本餐");
      const r = await wx.showActionSheet({
        itemList: members.slice(0, 6).map((p) => p.name),
      });
      await mutate("meal.assignCook", {
        meal_id: m.id,
        member_id: members[r.tapIndex].id,
        expected_revision: m.revision,
      });
      await this.refresh();
    } catch (e) {
      if (!(e as any).errMsg?.includes("cancel")) failure(e);
    }
  },
  async undo() {
    const m = this.data.meal;
    if (!m || this.data.busy) return;
    const r = await wx.showModal({
      title: "撤销最近一次制作状态",
      content: "已发出的提醒无法撤回；页面会显示更正后的状态。",
      editable: true,
      placeholderText: "请输入更正原因",
    });
    if (!r.confirm) return;
    try {
      await mutate("item.undo", {
        meal_id: m.id,
        expected_revision: m.revision,
        reason: r.content || "",
      });
      await this.refresh();
    } catch (e) {
      failure(e);
    }
  },
  copyMeal() {
    const m = this.data.meal;
    if (m) wx.navigateTo({ url: "/pages/publish/index?copy=" + m.id });
  },
  async subscribe() {
    const m = this.data.meal;
    if (!m) return;
    try {
      if (!this.data.notifyAvailable)
        throw Error("微信通知模板尚未接入，页面仍可正常查看进度");
      let accepted = true;
      if (!isLocal) {
        const r = await wx.requestSubscribeMessage({
          tmplIds: [this.data.templateId],
        });
        accepted = r[this.data.templateId] === "accept";
      }
      await mutate("notification.optin", { meal_id: m.id, accepted });
      this.setData({
        notificationState: accepted
          ? isLocal
            ? "已记录模拟授权，不会发送微信消息"
            : "已记录提醒选择，送达仍以微信实际结果为准"
          : "未开启提醒，不影响正常点菜",
      });
    } catch (e) {
      failure(e);
    }
  },
});
