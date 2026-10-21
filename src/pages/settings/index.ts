import {
  call,
  mutate,
  failure,
  isLocal,
  chooseKitchen,
  clearMediaFiles,
} from "../../services/api";
Page({
  data: {
    local: isLocal,
    busy: false,
    privacyExpanded: false,
    exportPath: "",
    feedback: "",
    feedbackId: "",
    exportText: "",
    deletionStatus: "",
    privacy:
      "我们使用微信提供的小程序身份识别你，保存昵称、厨房成员关系、菜谱和饭局选择。点菜备注和饭后反馈只给本人和本餐接单厨师查看；购物清单、采购备注和认领昵称对同餐成员可见；内部参考价只给有权限的厨师查看，不用于收款。选择图片时才访问相机或相册，上传内容须经平台审核。订阅消息须由你主动同意，拒绝不影响点菜。公开摘要仅包含你确认公开的饭局标题和菜名。你可以导出可访问的数据、离开厨房，并在转让或关闭自己管理的厨房后注销账号。注销立即停用账号，后台分批删除个人记录；共享厨房菜谱与饭局记录按厨房的生命周期保留，不再展示已注销成员的个人选择与饭后反馈，并清除采购认领身份。",
  },
  async onShow() {
    await this.status();
  },
  onHide() {
    this.setData({ exportText: "", exportPath: "" });
  },
  togglePrivacy() {
    this.setData({ privacyExpanded: !this.data.privacyExpanded });
  },
  async shareExport() {
    if (!this.data.exportPath) return;
    try {
      if (typeof wx.shareFileMessage !== "function")
        throw Error("当前微信暂不支持发送文件，可复制下方内容备份");
      await wx.shareFileMessage({
        filePath: this.data.exportPath,
        fileName: "鱿鱼须须-我的数据.json",
      });
    } catch (e) {
      if (!(e as any).errMsg?.includes("cancel")) failure(e);
    }
  },
  async status() {
    try {
      const r = await call("account.deletionStatus");
      this.setData({ deletionStatus: r.status });
    } catch (e) {
      failure(e);
    }
  },
  async exportData() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      const r = await call("export.mine");
      const text = JSON.stringify(r, null, 2);
      const path = wx.env.USER_DATA_PATH + "/squiddy-export.json";
      await new Promise<void>((resolve, reject) =>
        wx.getFileSystemManager().writeFile({
          filePath: path,
          data: text,
          encoding: "utf8",
          success: () => resolve(),
          fail: reject,
        }),
      );
      this.setData({ exportText: text, exportPath: path });
      wx.showToast({ title: "导出文件已保存" });
      await wx.showModal({
        title: "导出已准备好",
        content:
          "已保存到小程序本地文件 squiddy-export.json，也可复制下方内容另存备份。导出可能包含你有权查看的备注和内部价格，请妥善保管。",
        showCancel: false,
      });
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
  feedbackInput(e: WechatMiniprogram.Input) {
    this.setData({ feedback: e.detail.value });
  },
  async sendFeedback() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      const r = await mutate("feedback.submit", {
        message: this.data.feedback,
      });
      this.setData({ feedbackId: r.id, feedback: "" });
      wx.showToast({ title: isLocal ? "演练反馈已记录" : "反馈已记录" });
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
  async copy() {
    if (this.data.exportText)
      await wx.setClipboardData({ data: this.data.exportText });
  },
  async remove() {
    const c = await wx.showModal({
      title: "注销鱿鱼须须账号",
      content:
        "账号会立即停用，个人记录进入删除队列。请先导出需要的数据；主人需先转让或关闭厨房。此操作不能撤销。",
      confirmText: "确认注销",
      confirmColor: "#A44832",
    });
    if (!c.confirm || this.data.busy) return;
    this.setData({ busy: true });
    try {
      await mutate("account.delete");
      clearMediaFiles();
      chooseKitchen("");
      const keys = wx.getStorageInfoSync().keys;
      const actor = isLocal
        ? require("../../services/local").actor()
        : "wechat";
      for (const key of keys)
        if (
          key.startsWith("squiddy-draft-v2-" + actor + "-") ||
          key.startsWith("squiddy-pending-" + actor + "-") ||
          key.startsWith("squiddy-form-v1-" + actor + "-")
        )
          wx.removeStorageSync(key);
      try {
        wx.getFileSystemManager().unlinkSync(
          wx.env.USER_DATA_PATH + "/squiddy-export.json",
        );
      } catch {}
      this.setData({ exportText: "", exportPath: "" });
      if (isLocal) await require("../../services/local").localCleanup();
      await this.status();
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
});
