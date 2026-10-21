import { call, isLocal, failure, profile } from "../../services/api";
Page({
  data: {
    local: isLocal,
    hasCode: false,
    share: "",
    error: "",
    loading: true,
    imagePath: "",
    title: "",
    dishes: [] as { name: string }[],
  },
  onLoad(q: Record<string, string>) {
    this.setData({ share: q.share || "" });
  },
  async onReady() {
    await this.render();
  },
  async render() {
    this.setData({ loading: true, error: "", imagePath: "" });
    try {
      const hasCode = !isLocal && !!(await profile()).features.poster;
      this.setData({ hasCode });
      const result = hasCode
        ? await call("poster.code", { share_id: this.data.share })
        : await call("share.ownerRead", { share_id: this.data.share });
      this.setData({ title: result.title, dishes: result.dishes });
      const canvas: any = await new Promise((resolve, reject) =>
        wx
          .createSelectorQuery()
          .in(this)
          .select("#poster")
          .fields({ node: true, size: true })
          .exec((r) =>
            r[0]?.node
              ? resolve(r[0].node)
              : reject(Error("当前环境不支持海报画布")),
          ),
      );
      const ctx = canvas.getContext("2d"),
        scale = 2;
      canvas.width = 640;
      canvas.height = 1000;
      ctx.scale(scale, scale);
      ctx.fillStyle = "#F6F3EB";
      ctx.fillRect(0, 0, 320, 500);
      ctx.fillStyle = "#244B3B";
      ctx.font = "15px sans-serif";
      ctx.fillText("鱿鱼须须 · 一桌好饭", 24, 42);
      ctx.font = "bold 24px sans-serif";
      ctx.fillText(result.title.slice(0, 11), 24, 85);
      ctx.font = "16px sans-serif";
      for (let i = 0; i < Math.min(8, result.dishes.length); i++)
        ctx.fillText(
          "· " + result.dishes[i].name.slice(0, 15),
          26,
          126 + i * 28,
        );
      if (result.dishes.length > 8) {
        ctx.font = "12px sans-serif";
        ctx.fillText("还有" + (result.dishes.length - 8) + "道拿手菜", 24, 356);
      }
      if (!hasCode) {
        ctx.font = "14px sans-serif";
        ctx.fillText(
          isLocal ? "本地演练 · 没有可扫码凭据" : "一张菜单分享图 · 无扫码入口",
          24,
          414,
        );
      } else {
        const path = wx.env.USER_DATA_PATH + "/squiddy-code.png";
        await new Promise<void>((resolve, reject) =>
          wx.getFileSystemManager().writeFile({
            filePath: path,
            data: result.base64,
            encoding: "base64",
            success: () => resolve(),
            fail: reject,
          }),
        );
        const image = canvas.createImage();
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = reject;
          image.src = path;
        });
        ctx.drawImage(image, 216, 376, 80, 80);
        ctx.font = "13px sans-serif";
        ctx.fillText("扫码只看公开菜单摘要", 24, 410);
        ctx.fillText("不含成员、备注和价格", 24, 434);
      }
      ctx.font = "11px sans-serif";
      ctx.fillStyle = "#657168";
      ctx.fillText("分享可撤销，实时内容以小程序为准。", 24, 478);
      const image =
        await new Promise<WechatMiniprogram.CanvasToTempFilePathSuccessCallbackResult>(
          (resolve, reject) =>
            wx.canvasToTempFilePath(
              {
                canvas,
                width: 320,
                height: 500,
                destWidth: 640,
                destHeight: 1000,
                fileType: "png",
                success: resolve,
                fail: reject,
              } as any,
              this,
            ),
        );
      this.setData({ imagePath: image.tempFilePath });
    } catch (e) {
      this.setData({ error: (e as Error).message });
    } finally {
      this.setData({ loading: false });
    }
  },
  async preview() {
    if (this.data.imagePath)
      await wx.previewImage({ urls: [this.data.imagePath] });
  },
  async save() {
    try {
      if (!this.data.imagePath) throw Error("请先生成海报");
      await wx.saveImageToPhotosAlbum({ filePath: this.data.imagePath });
      wx.showToast({ title: "海报已保存" });
    } catch (e) {
      failure(e);
    }
  },
});
