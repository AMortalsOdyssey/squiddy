import {
  currentKitchen,
  chooseKitchen,
  isLocal,
  failure,
} from "../../services/api";
import {
  exportKitchen,
  savedBackups,
  loadBackup,
  restoreBackup,
  BackupFile,
  removeLocalBackup,
} from "../../services/backup";
Page({
  _epoch: 0,
  _visible: true,
  _archive: null as any,
  data: {
    local: isLocal,
    busy: false,
    includeImages: true,
    textOnly: false,
    progress: "",
    error: "",
    files: [] as BackupFile[],
    preview: null as any,
    restoredKitchen: "",
    historyExpanded: false,
    history: [] as { title: string; dishes: string; note: string }[],
  },
  async onShow() {
    this._visible = true;
    const epoch = this._epoch;
    try {
      const files = await savedBackups();
      if (this._visible && epoch === this._epoch) this.setData({ files });
    } catch (e) {
      if (this._visible && epoch === this._epoch) failure(e);
    }
  },
  onHide() {
    this._visible = false;
    this._epoch++;
    this._archive = null;
    this.setData({
      preview: null,
      history: [],
      historyExpanded: false,
      files: [],
    });
  },
  onUnload() {
    this.onHide();
  },
  images(e: WechatMiniprogram.SwitchChange) {
    this.setData({ includeImages: e.detail.value });
  },
  textOnly(e: WechatMiniprogram.SwitchChange) {
    this.setData({ textOnly: e.detail.value });
  },
  async create() {
    if (this.data.busy) return;
    if (!currentKitchen()) {
      this.setData({ error: "请先选择要备份的厨房" });
      return;
    }
    const epoch = ++this._epoch;
    this.setData({
      busy: true,
      error: "",
      progress: "正在准备备份，请留在此页…",
    });
    try {
      const files = await exportKitchen(currentKitchen(), {
        images: this.data.includeImages,
        progress: (text) => {
          if (epoch === this._epoch) this.setData({ progress: text });
        },
        cancelled: () => epoch !== this._epoch,
      });
      if (!this._visible || epoch !== this._epoch) return;
      const saved = await savedBackups();
      if (this._visible && epoch === this._epoch)
        this.setData({
          files: saved,
          progress:
            "已完成 " +
            files.length +
            " 个备份分卷，请把本次生成的文件全部保存。",
        });
    } catch (e) {
      if (!this._visible || epoch !== this._epoch) return;
      const saved = await savedBackups().catch(() => []);
      if (this._visible && epoch === this._epoch)
        this.setData({
          error: (e as Error).message,
          progress: "导出未完成，已生成的部分不能当作完整备份。",
          files: saved,
        });
    } finally {
      if (epoch === this._epoch) this.setData({ busy: false });
      else this.setData({ busy: false });
    }
  },
  async favorite(e: WechatMiniprogram.TouchEvent) {
    const file = this.data.files[Number(e.currentTarget.dataset.index)];
    if (!file) return;
    try {
      if (typeof wx.addFileToFavorites !== "function")
        throw Error("当前微信不支持直接收藏文件，可发送给自己后在微信中收藏。");
      await wx.addFileToFavorites({ filePath: file.path, fileName: file.name });
      wx.showToast({ title: "收藏操作已完成" });
    } catch (e) {
      if (!(e as any).errMsg?.includes("cancel")) failure(e);
    }
  },
  async share(e: WechatMiniprogram.TouchEvent) {
    const file = this.data.files[Number(e.currentTarget.dataset.index)];
    if (!file) return;
    try {
      await wx.shareFileMessage({ filePath: file.path, fileName: file.name });
    } catch (e) {
      if (!(e as any).errMsg?.includes("cancel")) failure(e);
    }
  },
  async removeFile(e: WechatMiniprogram.TouchEvent) {
    const file = this.data.files[Number(e.currentTarget.dataset.index)];
    if (!file) return;
    const epoch = this._epoch;
    const r = await wx.showModal({
      title: "删除本机备份副本",
      content:
        "请先确认已收藏或另存。这里只删除本机文件，不会删除厨房数据或微信收藏中的副本。",
      confirmText: "删除副本",
    });
    if (r.confirm && this._visible && epoch === this._epoch)
      try {
        await removeLocalBackup(file.path);
        const files = await savedBackups();
        if (this._visible && epoch === this._epoch) this.setData({ files });
      } catch (e) {
        failure(e);
      }
  },
  async select() {
    if (this.data.busy) return;
    try {
      const selected = await wx.chooseMessageFile({
        count: 1,
        type: "file",
        extension: ["zip"],
      });
      const file = selected.tempFiles[0];
      const archive = await loadBackup(file.path, file.size);
      if (!this._visible) return;
      this._archive = archive;
      this.setData({
        preview: {
          name: archive.data.kitchen.name,
          part: archive.data.part,
          recipes: archive.data.records.filter((r: any) => r.kind === "dish")
            .length,
          photos: Object.keys(archive.images).length,
          total: archive.data.counts.dishes,
        },
        textOnly: !archive.data.images_included,
        error: "",
        progress: "校验通过。恢复会创建新厨房，原有厨房保持不变。",
        history: archive.data.records
          .filter((r: any) => r.kind === "meal" && !r.data.empty)
          .map((r: any) => ({
            title: r.data.title,
            dishes: (r.data.menu || []).map((d: any) => d.name).join("、"),
            note: r.data.selection?.note || "",
          })),
      });
    } catch (e) {
      if (!(e as any).errMsg?.includes("cancel"))
        this.setData({ error: (e as Error).message });
    }
  },
  history() {
    this.setData({ historyExpanded: !this.data.historyExpanded });
  },
  async restore() {
    if (this.data.busy || !this._archive) return;
    const archive = this._archive,
      promptEpoch = this._epoch;
    const answer = await wx.showModal({
      title: "恢复为一间新厨房",
      content: this.data.textOnly
        ? "只恢复此分卷的菜谱文字与有权导出的内部参考价，不恢复图片。历史饭局保留在备份文件中，不重开饭局或恢复旧成员权限。"
        : "恢复此分卷的菜谱与图片；图片需要重新通过平台审核。历史饭局保留在备份文件中，不重开饭局或恢复旧成员权限。",
      confirmText: "开始恢复",
    });
    if (
      !answer.confirm ||
      !this._visible ||
      promptEpoch !== this._epoch ||
      archive !== this._archive
    )
      return;
    const epoch = ++this._epoch;
    this.setData({ busy: true, error: "", progress: "正在恢复…" });
    try {
      const r = await restoreBackup(
        archive,
        (text) => {
          if (epoch === this._epoch) this.setData({ progress: text });
        },
        this.data.textOnly,
        () => epoch !== this._epoch,
      );
      if (epoch !== this._epoch) return;
      this.setData({
        restoredKitchen: r.kitchenId,
        progress: r.pending
          ? "有 " +
            r.pending +
            " 张图片等待审核，稍后点击继续恢复；不会使用未审核图片。"
          : "已恢复 " +
            r.restored +
            " / " +
            r.total +
            " 道菜谱。若有其他分卷，继续选择同批次文件恢复。",
      });
    } catch (e) {
      if (epoch === this._epoch) this.setData({ error: (e as Error).message });
    } finally {
      this.setData({ busy: false });
    }
  },
  open() {
    if (this.data.restoredKitchen) {
      chooseKitchen(this.data.restoredKitchen);
      wx.switchTab({ url: "/pages/menu/index" });
    }
  },
});
