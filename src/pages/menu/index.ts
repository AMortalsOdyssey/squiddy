import {
  call,
  profile,
  kitchen,
  meal,
  currentKitchen,
  currentMeal,
  chooseKitchen,
  chooseMeal,
  loadSelection,
  saveSelection,
  isLocal,
  failure,
  resolveImages,
  dateLabel,
  statusLabel,
} from "../../services/api";
import type { Kitchen, Dish, Meal, Profile } from "../../services/types";
type Row = Dish & { quantity: number };
Page({
  data: {
    local: isLocal,
    loading: true,
    error: "",
    kitchen: null as Kitchen | null,
    profile: null as Profile | null,
    meal: null as Meal | null,
    dishes: [] as Row[],
    visible: [] as Row[],
    count: 0,
    portions: 0,
    search: "",
    category: "all",
    status: "",
    when: "",
    cutoff: "",
    coverUrl: "",
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
  async onPullDownRefresh() {
    await this.refresh();
    wx.stopPullDownRefresh();
  },
  async refresh() {
    this.setData({
      loading: true,
      error: "",
      meal: null,
      dishes: [],
      visible: [],
    });
    try {
      const p = await profile();
      let kid = currentKitchen();
      if (!p.kitchens.some((k) => k.id === kid)) {
        kid = p.kitchens[0]?.id || "";
        if (kid) chooseKitchen(kid);
      }
      this.setData({ profile: p });
      if (!kid) {
        this.setData({ kitchen: null, loading: false });
        return;
      }
      const k = await kitchen(kid);
      let mid = currentMeal();
      if (!k.meals.some((m) => m.id === mid)) {
        mid = k.meals.find((m) => m.status === "open")?.id || "";
        if (mid) chooseMeal(mid);
      }
      const m = mid ? await meal(mid) : null;
      let draft = m ? loadSelection(m.id) : null;
      if (m && !draft) draft = m.selection;
      const dishes = await resolveImages(
        m ? m.menu.filter((d) => d.active) : k.dishes.filter((d) => d.active),
      );
      const rows = dishes.map((d) => ({
        ...d,
        quantity: draft?.items.find((i) => i.dish_id === d.id)?.quantity || 0,
      }));
      let coverUrl = "";
      if (k.image_id)
        try {
          if (isLocal)
            coverUrl = (await call("media.read", { media_id: k.image_id }))
              .file_id;
          else
            coverUrl = (await call("media.url", { media_id: k.image_id })).url;
        } catch {}
      this.setData({
        coverUrl,
        categories: [
          { id: "all", name: "全部" },
          ...k.categories
            .filter((c) => !c.hidden)
            .map((c) => ({
              id: c.id,
              name:
                m?.menu.find((d) => d.category_id === c.id)?.category_name ||
                c.name,
            })),
          ...Array.from(
            new Map(
              rows
                .filter(
                  (d) => !k.categories.some((c) => c.id === d.category_id),
                )
                .map((d) => [
                  d.category_id,
                  { id: d.category_id, name: d.category_name },
                ]),
            ).values(),
          ),
        ],
        kitchen: k,
        meal: m,
        dishes: rows,
        count: rows.filter((d) => d.quantity > 0).length,
        portions: rows.reduce((sum, d) => sum + d.quantity, 0),
        status: m ? statusLabel(m.status, m.served) : "",
        when: m ? dateLabel(m.scheduled_at) : "",
        cutoff: m ? dateLabel(m.cutoff_at) : "",
      });
      this.filter();
    } catch (e) {
      this.setData({ error: (e as Error).message, kitchen: null, meal: null });
    } finally {
      this.setData({ loading: false });
    }
  },
  searchInput(e: WechatMiniprogram.Input) {
    this.setData({ search: e.detail.value });
    this.filter();
  },
  category(e: WechatMiniprogram.TouchEvent) {
    this.setData({ category: e.currentTarget.dataset.id });
    this.filter();
  },
  filter() {
    const q = this.data.search.toLowerCase();
    this.setData({
      visible: this.data.dishes.filter(
        (d) =>
          (this.data.category === "all" ||
            (d.category_id || d.category) === this.data.category) &&
          (d.name + d.ingredients.join(",")).toLowerCase().includes(q),
      ),
    });
  },
  change(e: WechatMiniprogram.TouchEvent) {
    const m = this.data.meal;
    if (!m || m.status !== "open" || Date.now() >= m.cutoff_at) {
      wx.showToast({ title: "本餐已停止点菜", icon: "none" });
      return;
    }
    const id = e.currentTarget.dataset.id,
      delta = Number(e.currentTarget.dataset.delta);
    if (![-1, 1].includes(delta)) return;
    const target = this.data.dishes.find((d) => d.id === id);
    const previous = loadSelection(m.id) || m.selection;
    if (
      delta > 0 &&
      target &&
      (target.variants?.length || target.attributes?.length) &&
      !previous.items.some((i) => i.dish_id === id)
    ) {
      wx.navigateTo({ url: "/pages/dish/index?id=" + id });
      return;
    }
    const rows = this.data.dishes.map((d) =>
      d.id === id
        ? { ...d, quantity: Math.max(0, Math.min(20, d.quantity + delta)) }
        : d,
    );
    const old = loadSelection(m.id) || m.selection;
    const draft = {
      ...old,
      items: rows
        .filter((d) => d.quantity > 0)
        .map((d) => ({
          ...old.items.find((i) => i.dish_id === d.id),
          dish_id: d.id,
          quantity: d.quantity,
        })),
    };
    if (saveSelection(m.id, draft)) {
      this.setData({
        dishes: rows,
        count: draft.items.length,
        portions: rows.reduce((sum, d) => sum + d.quantity, 0),
      });
      this.filter();
    }
  },
  detail(e: WechatMiniprogram.TouchEvent) {
    const d = this.data.dishes.find((d) => d.id === e.currentTarget.dataset.id);
    if (d) wx.navigateTo({ url: "/pages/dish/index?id=" + d.id });
  },
  async switchKitchen() {
    const p = this.data.profile;
    if (!p?.kitchens.length) return;
    try {
      const r = await wx.showActionSheet({
        itemList: p.kitchens.map((k) => k.name),
      });
      chooseKitchen(p.kitchens[r.tapIndex].id);
      await this.refresh();
    } catch {}
  },
  async switchMeal() {
    wx.navigateTo({ url: "/pages/history/index" });
  },
  join() {
    wx.navigateTo({ url: "/pages/invite/index" });
  },
  create() {
    wx.navigateTo({ url: "/pages/kitchen/index?create=1" });
  },
  manage() {
    wx.navigateTo({ url: "/pages/kitchen/index" });
  },
  publish() {
    wx.navigateTo({ url: "/pages/publish/index" });
  },
  recommend() {
    wx.navigateTo({ url: "/pages/recommend/index" });
  },
  review() {
    wx.switchTab({ url: "/pages/meal/index" });
  },
});
