import {
  kitchen,
  currentKitchen,
  mutate,
  failure,
  isLocal,
} from "../../services/api";
const { parseRecipeText } = require("../../services/import-recipe");
Page({
  data: {
    local: isLocal,
    raw: "",
    name: "",
    sourceUrl: "",
    ingredients: "",
    steps: "",
    categories: [] as { id: string; name: string }[],
    categoryIndex: 0,
    parsed: false,
    busy: false,
    error: "",
    done: false,
  },
  async onLoad() {
    try {
      const k = await kitchen();
      if (k.role === "member") throw Error("只有厨房管理员可以导入菜谱");
      this.setData({ categories: k.categories });
    } catch (e) {
      this.setData({ error: (e as Error).message });
    }
  },
  input(e: WechatMiniprogram.Input) {
    const field = e.currentTarget.dataset.field;
    if (["raw", "name", "sourceUrl", "ingredients", "steps"].includes(field))
      this.setData({ [field]: e.detail.value });
  },
  category(e: WechatMiniprogram.PickerChange) {
    this.setData({ categoryIndex: Number(e.detail.value) });
  },
  async paste() {
    try {
      const r = await wx.getClipboardData();
      this.setData({ raw: r.data.slice(0, 6000) });
    } catch (e) {
      failure(e);
    }
  },
  parse() {
    const r = parseRecipeText(this.data.raw);
    this.setData({
      name: r.name,
      sourceUrl: r.source_url,
      ingredients: r.ingredients,
      steps: r.steps,
      parsed: true,
    });
  },
  async save() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      await mutate("dish.save", {
        kitchen_id: currentKitchen(),
        name: this.data.name,
        source_url: this.data.sourceUrl,
        ingredients: this.data.ingredients
          .split(/[、,，\n]/)
          .map((s) => s.trim())
          .filter(Boolean),
        steps: this.data.steps,
        category_id: this.data.categories[this.data.categoryIndex]?.id,
        minutes: 20,
        allergens: [],
        ingredient_complete: false,
      });
      this.setData({ done: true });
      wx.showToast({ title: "已导入厨房" });
      wx.navigateBack();
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
});
