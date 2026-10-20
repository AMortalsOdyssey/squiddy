import {
  call,
  mutate,
  publicRead,
  chooseKitchen,
  chooseMeal,
  failure,
  isLocal,
  dateLabel,
} from "../../services/api";
Page({
  data: {
    local: isLocal,
    token: "",
    share: "",
    loading: false,
    busy: false,
    error: "",
    preview: null as any,
    publicMode: false,
    when: "",
  },
  onLoad(q: Record<string, string>) {
    if (q.scene) {
      try {
        const scene = decodeURIComponent(q.scene);
        if (/^s=[a-f0-9]{24}$/.test(scene)) q.share = scene.slice(2);
      } catch {}
    }
    this.setData({
      token: q.token || "",
      share: q.share || "",
      publicMode: !!q.share,
    });
    if (q.token || q.share) void this.resolve();
  },
  input(e: WechatMiniprogram.Input) {
    this.setData({ token: e.detail.value.trim(), preview: null, error: "" });
  },
  async resolve() {
    this.setData({ loading: true, error: "", preview: null });
    try {
      const p = this.data.publicMode
        ? await publicRead(this.data.share)
        : await call("invitation.resolve", { token: this.data.token });
      this.setData({
        preview: p,
        when: p.scheduled_at ? dateLabel(p.scheduled_at) : "",
      });
    } catch (e) {
      this.setData({ error: (e as Error).message });
    } finally {
      this.setData({ loading: false });
    }
  },
  async accept() {
    if (this.data.busy || this.data.publicMode) return;
    this.setData({ busy: true });
    try {
      const r = await mutate("invitation.accept", { token: this.data.token });
      chooseKitchen(r.kitchen_id);
      chooseMeal(r.meal_id);
      wx.switchTab({ url: "/pages/menu/index" });
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
  onShareAppMessage() {
    return {
      title: this.data.preview?.title || "一桌好饭",
      path:
        "/pages/invite/index?" +
        (this.data.publicMode
          ? "share=" + this.data.share
          : "token=" + this.data.token),
    };
  },
  onShareTimeline() {
    return {
      title: this.data.preview?.title || "一桌好饭",
      query: this.data.publicMode ? "share=" + this.data.share : "",
    };
  },
});
