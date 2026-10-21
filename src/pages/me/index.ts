import {
  profile,
  mutate,
  failure,
  isLocal,
  chooseKitchen,
} from "../../services/api";
Page({
  data: {
    local: isLocal,
    name: "",
    kitchens: [] as any[],
    error: "",
    busy: false,
    actor: "",
    offline: false,
    editingName: false,
  },
  onShow() {
    if (isLocal)
      this.setData({
        actor: require("../../services/local").actor(),
        offline: !!wx.getStorageSync("squiddy-rehearsal-offline"),
      });
    void this.refresh();
  },
  async refresh() {
    try {
      const p = await profile();
      this.setData({ name: p.name, kitchens: p.kitchens, error: "" });
    } catch (e) {
      this.setData({ error: (e as Error).message, kitchens: [] });
    }
  },
  input(e: WechatMiniprogram.Input) {
    this.setData({ name: e.detail.value });
  },
  editName() {
    this.setData({ editingName: !this.data.editingName });
  },
  history() {
    wx.navigateTo({ url: "/pages/history/index" });
  },
  async resetDemo() {
    if (!isLocal || this.data.busy) return;
    const answer = await wx.showModal({
      title: "重置本机演练数据？",
      content:
        "清空三个演练角色的厨房、选择和草稿。云端厨房不受影响，可以重新准备一顿示例饭局。",
      confirmText: "重置演练",
    });
    if (!answer.confirm) return;
    try {
      require("../../services/local").resetDemo();
      this.setData({ actor: "chef", offline: false });
      await this.refresh();
      wx.showToast({ title: "演练已重置" });
    } catch (e) {
      failure(e);
    }
  },
  async seed() {
    if (!isLocal || this.data.busy) return;
    this.setData({ busy: true });
    try {
      await require("../../services/local").seedDemo();
      require("../../services/local").selectActor("chef");
      this.setData({ actor: "chef" });
      await this.refresh();
      wx.showToast({ title: "三人演练已准备好", icon: "success" });
      wx.switchTab({ url: "/pages/menu/index" });
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
  async save() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      await mutate("profile.update", { name: this.data.name });
      this.setData({ editingName: false });
      wx.showToast({ title: "昵称已保存" });
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
  open(e: WechatMiniprogram.TouchEvent) {
    chooseKitchen(e.currentTarget.dataset.id);
    wx.navigateTo({ url: "/pages/kitchen/index" });
  },
  create() {
    wx.navigateTo({ url: "/pages/kitchen/index?create=1" });
  },
  invite() {
    wx.navigateTo({ url: "/pages/invite/index" });
  },
  settings() {
    wx.navigateTo({ url: "/pages/settings/index" });
  },
  async switchActor() {
    if (!isLocal) return;
    try {
      const a = await wx.showActionSheet({
        itemList: ["厨师 chef", "朋友 Alice", "朋友 Bob"],
      });
      require("../../services/local").selectActor(
        ["chef", "alice", "bob"][a.tapIndex],
      );
      this.setData({ actor: require("../../services/local").actor() });
      await this.refresh();
    } catch (e) {
      if (!(e as any).errMsg?.includes("cancel")) failure(e);
    }
  },
  offline(e: WechatMiniprogram.SwitchChange) {
    if (!isLocal) return;
    wx.setStorageSync("squiddy-rehearsal-offline", e.detail.value);
    this.setData({ offline: e.detail.value });
    void this.refresh();
  },
});
