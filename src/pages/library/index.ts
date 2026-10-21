import {
  call,
  mutate,
  currentKitchen,
  failure,
  isLocal,
} from "../../services/api";
interface Recipe {
  id: string;
  name: string;
  category: string;
  category_name: string;
  subtitle: string;
  steps: string;
  ingredients: string[];
  allergens: string[];
  minutes: number;
  favorite: boolean;
  wished: boolean;
  wish_count: number;
  in_kitchen: boolean;
}
Page({
  data: {
    local: isLocal,
    loading: true,
    busy: false,
    error: "",
    panel: "all",
    search: "",
    category: "all",
    canImport: false,
    revision: 0,
    hasKitchen: false,
    recipes: [] as Recipe[],
    visible: [] as Recipe[],
    selected: [] as string[],
    expanded: "",
    categories: [
      { id: "all", name: "全部" },
      { id: "protein", name: "荤菜" },
      { id: "vegetable", name: "素菜" },
      { id: "soup", name: "汤羹" },
      { id: "staple", name: "主食" },
      { id: "dessert", name: "甜点" },
    ],
  },
  onShow() {
    void this.refresh();
  },
  async refresh() {
    this.setData({ loading: true, error: "" });
    try {
      const kid = currentKitchen();
      const r = await call("library.read", kid ? { kitchen_id: kid } : {});
      this.setData({
        hasKitchen: !!kid,
        recipes: r.recipes,
        canImport: r.can_import,
        revision: r.kitchen_revision,
        selected: this.data.selected.filter((id) =>
          r.recipes.some((x: Recipe) => x.id === id && !x.in_kitchen),
        ),
      });
      this.filterRows();
    } catch (e) {
      this.setData({ error: (e as Error).message });
    } finally {
      this.setData({ loading: false });
    }
  },
  filterRows() {
    const q = this.data.search.trim().toLowerCase();
    this.setData({
      visible: this.data.recipes
        .filter(
          (r) =>
            (this.data.panel === "all" ||
              (this.data.panel === "favorites"
                ? r.favorite
                : r.wish_count > 0)) &&
            (this.data.category === "all" ||
              r.category === this.data.category) &&
            (r.name + r.subtitle + r.ingredients.join(" "))
              .toLowerCase()
              .includes(q),
        )
        .map((r) => ({
          ...r,
          selected: this.data.selected.includes(r.id),
          ingredientsText: r.ingredients.join("、"),
          allergensText: r.allergens.join("、"),
        })),
    });
  },
  panel(e: WechatMiniprogram.TouchEvent) {
    this.setData({ panel: e.currentTarget.dataset.id });
    this.filterRows();
  },
  category(e: WechatMiniprogram.TouchEvent) {
    this.setData({ category: e.currentTarget.dataset.id });
    this.filterRows();
  },
  input(e: WechatMiniprogram.Input) {
    this.setData({ search: e.detail.value });
    this.filterRows();
  },
  expand(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id;
    this.setData({ expanded: this.data.expanded === id ? "" : id });
  },
  async favorite(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const r = this.data.recipes.find(
      (r) => r.id === e.currentTarget.dataset.id,
    );
    if (!r) return;
    this.setData({ busy: true });
    try {
      await mutate("library.favorite", {
        recipe_id: r.id,
        favorite: !r.favorite,
      });
      await this.refresh();
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
  async wish(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const r = this.data.recipes.find(
      (r) => r.id === e.currentTarget.dataset.id,
    );
    if (!r) return;
    this.setData({ busy: true });
    try {
      await mutate("library.wish", {
        kitchen_id: currentKitchen(),
        recipe_id: r.id,
        wished: !r.wished,
        expected_revision: this.data.revision,
      });
      await this.refresh();
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
  select(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id;
    const r = this.data.recipes.find((r) => r.id === id);
    if (!r || r.in_kitchen) return;
    const ids = this.data.selected.includes(id)
      ? this.data.selected.filter((x) => x !== id)
      : [...this.data.selected, id];
    this.setData({ selected: ids });
    this.filterRows();
  },
  async importSelected() {
    if (this.data.busy || !this.data.selected.length) return;
    this.setData({ busy: true });
    try {
      const r = await mutate("library.import", {
        kitchen_id: currentKitchen(),
        recipe_ids: this.data.selected,
        expected_revision: this.data.revision,
      });
      this.setData({ selected: [] });
      await this.refresh();
      wx.showToast({ title: "已加入" + r.imported + "道菜", icon: "success" });
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
  fromShare() {
    wx.navigateTo({ url: "/pages/import/index" });
  },
  manual() {
    if (this.data.hasKitchen) wx.navigateTo({ url: "/pages/editor/index" });
    else this.create();
  },
  create() {
    wx.navigateTo({ url: "/pages/kitchen/index?create=1" });
  },
});
