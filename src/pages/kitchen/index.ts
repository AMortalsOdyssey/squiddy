import {
  kitchen,
  currentKitchen,
  chooseKitchen,
  mutate,
  call,
  failure,
  isLocal,
  money,
  statusLabel,
  chooseMeal,
} from "../../services/api";
import type { Kitchen } from "../../services/types";
Page({
  data: {
    local: isLocal,
    creating: false,
    editing: false,
    imageId: "",
    imageStatus: "",
    imageUrl: "",
    name: "",
    description: "",
    loading: true,
    busy: false,
    error: "",
    kitchen: null as Kitchen | null,
    dishes: [] as any[],
    meals: [] as any[],
  },
  onLoad(q: Record<string, string>) {
    this.setData({ creating: q.create === "1" || !currentKitchen() });
  },
  onShow() {
    if (this.data.creating) this.setData({ loading: false });
    else void this.refresh();
  },
  onHide() {
    this.setData({ dishes: [], kitchen: null });
  },
  async refresh() {
    this.setData({ loading: true, error: "" });
    try {
      const k = await kitchen();
      this.setData({
        kitchen: k,
        name: k.name,
        description: k.description,
        imageId: k.image_id,
        imageStatus: k.image_id ? "approved" : "",
        dishes: k.dishes.map((d) => ({
          ...d,
          price: money(d.default_price_minor),
        })),
        meals: k.meals.map((m) => ({
          ...m,
          label: statusLabel(m.status, m.served),
        })),
      });
    } catch (e) {
      this.setData({ error: (e as Error).message });
    } finally {
      this.setData({ loading: false });
    }
  },
  input(e: WechatMiniprogram.Input) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  async create() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      const r = await mutate("kitchen.create", {
        name: this.data.name,
        description: this.data.description,
      });
      chooseKitchen(r.id);
      wx.switchTab({ url: "/pages/menu/index" });
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
  editKitchen() {
    this.setData({ editing: !this.data.editing });
  },
  async cover() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      const pick = await wx.chooseMedia({
        count: 1,
        mediaType: ["image"],
        sizeType: ["compressed"],
      });
      const file = pick.tempFiles[0];
      if (file.size > 2 * 1024 * 1024) throw Error("图片请控制在2MB以内");
      const t = await mutate("media.prepare", { kitchen_id: currentKitchen() });
      const payload: Record<string, unknown> = { media_id: t.id };
      if (isLocal) payload.local_path = file.tempFilePath;
      else
        payload.base64 = await new Promise<string>((resolve, reject) =>
          wx
            .getFileSystemManager()
            .readFile({
              filePath: file.tempFilePath,
              encoding: "base64",
              success: (r) => resolve(r.data as string),
              fail: reject,
            }),
        );
      const r = await mutate("media.complete", payload);
      this.setData({
        imageId: t.id,
        imageStatus: r.status,
        imageUrl: file.tempFilePath,
      });
    } catch (e) {
      if (!(e as any).errMsg?.includes("cancel")) failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
  async checkCover() {
    try {
      const r = await call("media.read", { media_id: this.data.imageId });
      this.setData({ imageStatus: r.status });
    } catch (e) {
      failure(e);
    }
  },
  clearCover() {
    this.setData({ imageId: "", imageStatus: "", imageUrl: "" });
  },
  async saveKitchen() {
    const k = this.data.kitchen;
    if (!k || this.data.busy) return;
    this.setData({ busy: true });
    try {
      if (this.data.imageId && this.data.imageStatus !== "approved")
        throw Error("封面需审核通过，或先移除封面");
      await mutate("kitchen.update", {
        kitchen_id: k.id,
        expected_revision: k.revision,
        name: this.data.name,
        description: this.data.description,
        image_id: this.data.imageId,
      });
      this.setData({ editing: false });
      await this.refresh();
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
  add() {
    wx.navigateTo({ url: "/pages/editor/index" });
  },
  edit(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({
      url: "/pages/editor/index?id=" + e.currentTarget.dataset.id,
    });
  },
  publish() {
    wx.navigateTo({ url: "/pages/publish/index" });
  },
  open(e: WechatMiniprogram.TouchEvent) {
    chooseMeal(e.currentTarget.dataset.id);
    wx.switchTab({ url: "/pages/meal/index" });
  },
  async member(e: WechatMiniprogram.TouchEvent) {
    const k = this.data.kitchen;
    if (!k) return;
    const target = e.currentTarget.dataset.id;
    try {
      const a = await wx.showActionSheet({
        itemList: ["设为厨房厨师", "设为普通成员", "转让厨房主人", "移出厨房"],
      });
      const options = ["cook", "member", "owner"];
      const confirm = await wx.showModal({
        title: "确认成员调整",
        content: [
          "允许对方管理菜谱和查看厨房默认参考价。本餐接单权限仍需单独交接。",
          "取消菜谱管理与默认参考价权限。本餐接单职责需单独交接。",
          "你将交出厨房管理权，保留厨师身份。",
          "该成员将无法再查看厨房和饭局。",
        ][a.tapIndex],
      });
      if (!confirm.confirm) return;
      await mutate(a.tapIndex === 3 ? "member.remove" : "member.role", {
        kitchen_id: k.id,
        member_id: target,
        ...(a.tapIndex === 3
          ? {}
          : { role: options[a.tapIndex], expected_revision: k.revision }),
      });
      await this.refresh();
    } catch (e) {
      if ((e as any).errMsg?.includes("cancel")) return;
      failure(e);
    }
  },
  async leave() {
    const k = this.data.kitchen;
    if (!k) return;
    const r = await wx.showModal({
      title: k.role === "owner" ? "关闭厨房" : "离开厨房",
      content:
        k.role === "owner"
          ? "所有饭局结束后才能关闭。厨房及相关内容会进入删除队列，其他成员也不能再访问。"
          : "离开后不能继续查看本厨房内容。",
    });
    if (!r.confirm) return;
    try {
      await mutate(k.role === "owner" ? "kitchen.close" : "kitchen.leave", {
        kitchen_id: k.id,
        expected_revision: k.revision,
      });
      if (isLocal) await require("../../services/local").localMaintenance();
      chooseKitchen("");
      wx.switchTab({ url: "/pages/menu/index" });
    } catch (e) {
      failure(e);
    }
  },
});
