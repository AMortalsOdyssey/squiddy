import {
  kitchen,
  currentKitchen,
  mutate,
  call,
  failure,
  isLocal,
  money,
  parseMoney,
} from "../../services/api";
Page({
  data: {
    local: isLocal,
    loading: true,
    busy: false,
    dishId: "",
    revision: 0,
    name: "",
    ingredients: "",
    allergens: "",
    steps: "",
    minutes: "20",
    defaultServes: "2",
    ingredientComplete: false,
    categoryIndex: 0,
    categories: ["荤菜", "素菜", "汤羹", "主食", "甜点"],
    categoryIds: ["protein", "vegetable", "soup", "staple", "dessert"],
    vegetarian: false,
    spicy: false,
    active: true,
    canPrice: false,
    price: "",
    imageId: "",
    imageUrl: "",
    imageStatus: "",
    error: "",
  },
  async onLoad(q: Record<string, string>) {
    this.setData({ dishId: q.id || "" });
    try {
      const k = await kitchen();
      if (k.role === "member") throw Error("只有厨房管理员可以编辑菜谱");
      const d = k.dishes.find((d) => d.id === q.id);
      if (q.id && !d) throw Error("菜谱不存在");
      this.setData({ canPrice: k.can_price });
      if (d)
        this.setData({
          revision: d.revision,
          name: d.name,
          ingredients: d.ingredients.join("、"),
          allergens: d.allergens.join("、"),
          steps: d.steps,
          minutes: String(d.minutes),
          defaultServes: String(d.default_serves),
          ingredientComplete: d.ingredient_complete,
          categoryIndex: this.data.categoryIds.indexOf(d.category),
          vegetarian: d.vegetarian,
          spicy: d.spicy,
          active: d.active,
          price:
            d.default_price_minor == null ? "" : money(d.default_price_minor),
          imageId: d.image_id,
          imageStatus: d.image_id ? "approved" : "",
        });
    } catch (e) {
      this.setData({ error: (e as Error).message });
    } finally {
      this.setData({ loading: false });
    }
  },
  onUnload() {
    this.setData({ price: "" });
  },
  input(e: WechatMiniprogram.Input) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  category(e: WechatMiniprogram.PickerChange) {
    this.setData({ categoryIndex: Number(e.detail.value) });
  },
  toggle(e: WechatMiniprogram.SwitchChange) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  async photo() {
    if (this.data.busy) return;
    try {
      const pick = await wx.chooseMedia({
        count: 1,
        mediaType: ["image"],
        sourceType: ["album", "camera"],
        sizeType: ["compressed"],
      });
      const file = pick.tempFiles[0];
      if (file.size > 2 * 1024 * 1024) throw Error("图片请控制在2MB以内");
      this.setData({
        busy: true,
        imageUrl: file.tempFilePath,
        imageStatus: "uploading",
      });
      const ticket = await mutate("media.prepare", {
        kitchen_id: currentKitchen(),
      });
      const payload: Record<string, unknown> = { media_id: ticket.id };
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
      const uploaded = await mutate("media.complete", payload);
      this.setData({ imageId: ticket.id, imageStatus: uploaded.status });
    } catch (e) {
      if (!(e as any).errMsg?.includes("cancel")) failure(e);
      this.setData({ imageStatus: "failed" });
    } finally {
      this.setData({ busy: false });
    }
  },
  async checkImage() {
    try {
      const result = await call("media.read", { media_id: this.data.imageId });
      this.setData({ imageStatus: result.status });
      if (result.status === "pending")
        wx.showToast({ title: "平台仍在审核，请稍后重试", icon: "none" });
    } catch (e) {
      failure(e);
    }
  },
  removeImage() {
    this.setData({ imageId: "", imageUrl: "", imageStatus: "" });
  },
  async save() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      if (this.data.imageId && this.data.imageStatus !== "approved")
        throw Error("图片需审核通过才能保存，或先移除图片");
      const list = (s: string) =>
        s
          .split(/[、,，\n]/)
          .map((v) => v.trim())
          .filter(Boolean);
      const data: Record<string, unknown> = {
        kitchen_id: currentKitchen(),
        dish_id: this.data.dishId || undefined,
        expected_revision: this.data.revision,
        name: this.data.name,
        ingredients: list(this.data.ingredients),
        allergens: list(this.data.allergens),
        steps: this.data.steps,
        minutes: Number(this.data.minutes),
        default_serves: Number(this.data.defaultServes),
        ingredient_complete: this.data.ingredientComplete,
        category: this.data.categoryIds[this.data.categoryIndex],
        vegetarian: this.data.vegetarian,
        spicy: this.data.spicy,
        active: this.data.active,
        image_id: this.data.imageId,
      };
      if (!data.dish_id) delete data.dish_id;
      if (this.data.canPrice)
        data.default_price_minor = parseMoney(this.data.price);
      await mutate("dish.save", data);
      wx.showToast({ title: "菜谱已保存", icon: "success" });
      wx.navigateBack();
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
});
