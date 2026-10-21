const { lineKey } = require("../../shared/selection");
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
  _panelMealId: "",
  _panelRole: "",
  data: {
    panel: "selection",
    showRequests: false,
    requestSearch: "",
    requestRows: [] as any[],
    showPrices: false,
    respondedAccounts: 0,
    representedPeople: 0,
    finishedItems: 0,
    totalItems: 0,
    progressPercent: 0,
    stageTip: "",
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
    this.setData({
      meal: null,
      prices: [],
      total: "",
      unpriced: 0,
      plans: [],
      inviteToken: "",
      invitationId: "",
      publicShareId: "",
      showPrices: false,
      showRequests: false,
    });
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
      const sameRole = this._panelMealId === m.id && this._panelRole === m.role;
      const panel = sameRole
        ? this.data.panel
        : m.role === "cook"
          ? "kitchen"
          : m.status === "open"
            ? "selection"
            : "progress";
      const oldPrices = sameRole ? this.data.prices : [];
      this._panelMealId = m.id;
      this._panelRole = m.role;
      const finishedItems = m.items.filter((x) =>
        ["served", "skipped"].includes(x.status),
      ).length;
      this.setData({
        panel,
        inviteToken: sameRole ? this.data.inviteToken : "",
        invitationId: sameRole ? this.data.invitationId : "",
        publicShareId: sameRole ? this.data.publicShareId : "",
        showPrices: sameRole ? this.data.showPrices : false,
        showRequests: sameRole ? this.data.showRequests : false,
        requestRows: (m.requests || [])
          .filter((r) => r.name.includes(this.data.requestSearch))
          .map((r) => ({
            ...r,
            lines: r.items.map((i) => ({
              label:
                (m.menu.find((d) => d.id === i.dish_id)?.name || "菜品") +
                [
                  i.variant,
                  ...(i.options || []).map((o) => o.name + "：" + o.value),
                ]
                  .filter(Boolean)
                  .map((x) => " · " + x)
                  .join(""),
              quantity: i.quantity,
            })),
          })),
        respondedAccounts: m.requests?.length || 0,
        representedPeople:
          m.requests?.reduce((sum, x) => sum + (x.people || 1), 0) || 0,
        finishedItems,
        totalItems: m.items.length,
        progressPercent: m.items.length
          ? Math.round((finishedItems / m.items.length) * 100)
          : 0,
        stageTip:
          (
            {
              open: "先告诉厨师你想吃什么，截止前都可以调整。",
              locked: m.plan_confirmed
                ? "菜单已确认，等厨师开始做。"
                : "大家的选择已锁定，厨师正在安排实际份数。",
              cooking: "锅里正热闹，做好一道，就上桌一道。",
              completed: m.served
                ? "这一顿，已经可以开饭了。"
                : "这一顿暂未开餐，换个时间再约。",
              archived: "一顿好饭，已经收进回忆里。",
              cancelled: "计划有变，期待下一次相聚。",
            } as Record<string, string>
          )[m.status] || "",
        meal: m,
        status: statusLabel(m.status, m.served),
        when: dateLabel(m.scheduled_at),
        cutoff: dateLabel(m.cutoff_at),
        draft: draft.items.map((i) => ({
          ...i,
          line_id: lineKey(i),
          name:
            (m.menu.find((d) => d.id === i.dish_id)?.name || "已不可用菜品") +
            ([
              i.variant,
              ...(i.options || []).map((o) => o.name + "：" + o.value),
            ].filter(Boolean).length
              ? "（" +
                [
                  i.variant,
                  ...(i.options || []).map((o) => o.name + "：" + o.value),
                ]
                  .filter(Boolean)
                  .join("，") +
                "）"
              : ""),
        })),
        note: draft.note,
        people: String(draft.people || 1),
        selectionRevision: draft.revision,
        stale: !!local && local.revision !== m.selection.revision,
        plans:
          m.role === "cook"
            ? poll && sameRole && this.data.plans.length
              ? this.data.plans
              : plans
            : [],
        prices:
          m.role === "cook"
            ? (m.chef_prices || []).map((p) => ({
                ...p,
                value: oldPrices.find((x) => x.line_id === p.line_id)?.dirty
                  ? oldPrices.find((x) => x.line_id === p.line_id).value
                  : p.unit_price_minor == null
                    ? ""
                    : money(p.unit_price_minor),
                dirty: !!oldPrices.find((x) => x.line_id === p.line_id)?.dirty,
                conflict: !!oldPrices.find((x) => x.line_id === p.line_id)
                  ?.conflict,
                expectedRevision: oldPrices.find((x) => x.line_id === p.line_id)
                  ?.dirty
                  ? oldPrices.find((x) => x.line_id === p.line_id)
                      .expectedRevision
                  : m.chef_quote?.revision,
              }))
            : [],
        total: m.role === "cook" ? money(m.chef_quote?.total_known_minor) : "",
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
  choosePanel(e: WechatMiniprogram.TouchEvent) {
    const panel = e.currentTarget.dataset.panel;
    const allowed =
      this.data.meal?.role === "cook"
        ? ["kitchen", "selection", "more"]
        : ["selection", "progress"];
    if (allowed.includes(panel)) this.setData({ panel });
  },
  requestSearch(e: WechatMiniprogram.Input) {
    this.setData({ requestSearch: e.detail.value });
    const m = this.data.meal;
    this.setData({
      requestRows: (m?.requests || [])
        .filter((r) => r.name.includes(e.detail.value))
        .map((r) => ({
          ...r,
          lines: r.items.map((i) => ({
            label:
              (m?.menu.find((d) => d.id === i.dish_id)?.name || "菜品") +
              [
                i.variant,
                ...(i.options || []).map((o) => o.name + "：" + o.value),
              ]
                .filter(Boolean)
                .map((x) => " · " + x)
                .join(""),
            quantity: i.quantity,
          })),
        })),
    });
  },
  async notificationSettings() {
    try {
      await wx.openSetting({ withSubscriptions: true });
    } catch (e) {
      failure(e);
    }
  },
  toggleRequests() {
    this.setData({ showRequests: !this.data.showRequests });
  },
  togglePrices() {
    this.setData({ showPrices: !this.data.showPrices });
  },
  history() {
    wx.navigateTo({ url: "/pages/history/index" });
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
    if (
      m &&
      Number.isInteger(Number(this.data.people)) &&
      Number(this.data.people) >= 1 &&
      Number(this.data.people) <= 20
    )
      return saveSelection(m.id, {
        items: this.data.draft.map((i) => ({
          line_id: i.line_id || lineKey(i),
          dish_id: i.dish_id,
          quantity: i.quantity,
          ...(i.variant ? { variant: i.variant } : {}),
          ...(i.options?.length ? { options: i.options } : {}),
        })),
        note: this.data.note,
        people: Number(this.data.people),
        revision: this.data.selectionRevision,
      });
    return false;
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
    const people = Number(this.data.people);
    if (!Number.isInteger(people) || people < 1 || people > 20) {
      failure(Error("请填写1至20位用餐人数"));
      return;
    }
    if (!this.saveDraft()) return;
    this.setData({ busy: true });
    try {
      await mutate("selection.replace", {
        meal_id: m.id,
        items: this.data.draft.map((i) => ({
          line_id: i.line_id || lineKey(i),
          dish_id: i.dish_id,
          quantity: i.quantity,
          ...(i.variant ? { variant: i.variant } : {}),
          ...(i.options?.length ? { options: i.options } : {}),
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
  shopping() {
    wx.navigateTo({ url: "/pages/shopping/index" });
  },
  feedback() {
    wx.navigateTo({ url: "/pages/review/index" });
  },
  editLine(e: WechatMiniprogram.TouchEvent) {
    const i = this.data.draft[Number(e.currentTarget.dataset.index)];
    if (i)
      wx.navigateTo({
        url:
          "/pages/dish/index?id=" +
          i.dish_id +
          "&line=" +
          encodeURIComponent(i.line_id),
      });
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
          line_id: i.line_id || lineKey(i),
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
    const { id, line, status } = e.currentTarget.dataset;
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
        line_id: line,
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
    const row = this.data.prices[i];
    if (!row) return;
    this.setData({
      ["prices[" + i + "].value"]: e.detail.value,
      ["prices[" + i + "].dirty"]: true,
      ["prices[" + i + "].expectedRevision"]: row.dirty
        ? row.expectedRevision
        : this.data.meal?.chef_quote?.revision,
    });
  },
  async priceSave(e: WechatMiniprogram.TouchEvent) {
    const m = this.data.meal;
    if (!m?.chef_quote || this.data.busy) return;
    const priceIndex = Number(e.currentTarget.dataset.index);
    const p = this.data.prices[priceIndex];
    if (!p) return;
    this.setData({ busy: true });
    try {
      await mutate("price.update", {
        meal_id: m.id,
        dish_id: p.dish_id,
        line_id: p.line_id,
        unit_price_minor: parseMoney(p.value),
        expected_revision: p.expectedRevision ?? m.chef_quote.revision,
      });
      this.setData({ ["prices[" + priceIndex + "].dirty"]: false });
      await this.refresh();
    } catch (e) {
      if ((e as { code?: string }).code === "CONFLICT")
        this.setData({ ["prices[" + priceIndex + "].conflict"]: true });
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
  async resetPrice(e: WechatMiniprogram.TouchEvent) {
    const i = Number(e.currentTarget.dataset.index),
      old = this.data.prices[i];
    if (!old) return;
    await this.refresh(true);
    const m = this.data.meal;
    if (m?.role !== "cook") return;
    const latest = m.chef_prices?.find((p) => p.line_id === old.line_id);
    if (!latest) return;
    const index = this.data.prices.findIndex((p) => p.line_id === old.line_id);
    if (index < 0) return;
    this.setData({
      ["prices[" + index + "].value"]:
        latest.unit_price_minor == null ? "" : money(latest.unit_price_minor),
      ["prices[" + index + "].dirty"]: false,
      ["prices[" + index + "].conflict"]: false,
      ["prices[" + index + "].expectedRevision"]: m.chef_quote?.revision,
    });
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
  async revokeAll(e: WechatMiniprogram.TouchEvent) {
    const m = this.data.meal;
    if (!m || this.data.busy) return;
    const kind = e.currentTarget.dataset.kind;
    if (!["invitation", "share"].includes(kind)) return;
    const answer = await wx.showModal({
      title:
        kind === "invitation" ? "撤销本餐所有邀请？" : "撤销本餐所有公开摘要？",
      content:
        kind === "invitation"
          ? "此前发出的口令与邀请卡片都会失效，已加入的朋友不受影响。"
          : "此前生成的所有公开链接和扫码入口都会失效。已保存的图片无法从他人设备中收回。",
    });
    if (!answer.confirm) return;
    this.setData({ busy: true });
    try {
      await mutate(kind + ".revokeAll", { meal_id: m.id });
      this.setData(
        kind === "invitation"
          ? { inviteToken: "", invitationId: "" }
          : { publicShareId: "" },
      );
      await this.refresh();
      wx.showToast({ title: "此前链接已全部失效" });
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
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
  onShareAppMessage(e: any) {
    if (e?.target?.dataset?.share === "public" && this.data.publicShareId)
      return {
        title: this.data.meal?.title || "一桌好饭",
        path: "/pages/meal/index?share=" + this.data.publicShareId,
      };
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
  async assignPicker(e: WechatMiniprogram.PickerChange) {
    const m = this.data.meal;
    const candidate = m?.cook_candidates?.[Number(e.detail.value)];
    if (!m || !candidate || this.data.busy) return;
    const answer = await wx.showModal({
      title: "交给" + candidate.name + "掌勺？",
      content:
        "对方会接手本餐工作台和内部参考价。交接后你将不能再查看本餐内部金额。",
    });
    if (!answer.confirm) return;
    this.setData({ busy: true });
    try {
      await mutate("meal.assignCook", {
        meal_id: m.id,
        member_id: candidate.id,
        expected_revision: m.revision,
      });
      this.setData({
        prices: [],
        total: "",
        plans: [],
        inviteToken: "",
        invitationId: "",
        publicShareId: "",
      });
      await this.refresh();
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
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
        if (!accepted) {
          const choice = await wx.showModal({
            title: "提醒尚未开启",
            content: "可以在微信设置中检查订阅消息权限，返回后再点击开启提醒。",
            confirmText: "去设置",
          });
          if (choice.confirm) await wx.openSetting({ withSubscriptions: true });
        }
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
