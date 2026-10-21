import {
  kitchen,
  mutate,
  currentKitchen,
  requestId,
  failure,
  isLocal,
} from "../../services/api";
import type { Kitchen } from "../../services/types";
type Category = Kitchen["categories"][number];
Page({
  data: {
    local: isLocal,
    loading: true,
    busy: false,
    error: "",
    revision: 0,
    categories: [] as Category[],
    rows: [] as any[],
    dishes: [] as any[],
    expanded: "",
    kinds: ["荤菜", "素菜", "汤羹", "主食", "甜点"],
  },
  onShow() {
    void this.refresh();
  },
  async refresh() {
    this.setData({ loading: true, error: "" });
    try {
      const k = await kitchen();
      if (k.role === "member") throw Error("只有厨房管理员可以整理分类");
      this.setData({
        revision: k.revision,
        categories: k.categories,
        dishes: k.dishes,
      });
      this.renderRows();
    } catch (e) {
      this.setData({ error: (e as Error).message });
    } finally {
      this.setData({ loading: false });
    }
  },
  renderRows() {
    this.setData({
      rows: this.data.categories.map((c, index) => ({
        ...c,
        index,
        dishes: this.data.dishes.filter(
          (d) => (d.category_id || d.category) === c.id,
        ),
        kindName: (
          {
            protein: "荤菜",
            vegetable: "素菜",
            soup: "汤羹",
            staple: "主食",
            dessert: "甜点",
          } as Record<string, string>
        )[c.kind],
      })),
    });
  },
  async persist(rows: Category[]) {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      await mutate("category.save", {
        kitchen_id: currentKitchen(),
        expected_revision: this.data.revision,
        categories: rows,
      });
      await this.refresh();
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
  async add() {
    if (this.data.busy) return;
    try {
      const a = await wx.showModal({
        title: "新建分类",
        editable: true,
        placeholderText: "12字以内，例如：拿手小炒",
      });
      if (!a.confirm) return;
      const b = await wx.showActionSheet({ itemList: this.data.kinds });
      const kind = ["protein", "vegetable", "soup", "staple", "dessert"][
        b.tapIndex
      ];
      await this.persist([
        ...this.data.categories,
        { id: requestId(), name: a.content || "", kind, hidden: false },
      ]);
    } catch (e) {
      if (!(e as any).errMsg?.includes("cancel")) failure(e);
    }
  },
  async menu(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const c = this.data.categories.find(
      (c) => c.id === e.currentTarget.dataset.id,
    );
    if (!c) return;
    try {
      const a = await wx.showActionSheet({
        itemList: [
          "修改名称",
          c.hidden ? "显示在菜单" : "从菜单分类栏隐藏",
          "修改搭配菜类",
          "删除空分类",
        ],
      });
      let rows = this.data.categories.map((x) => ({ ...x }));
      const item = rows.find((x) => x.id === c.id)!;
      if (a.tapIndex === 0) {
        const b = await wx.showModal({
          title: "修改分类名称",
          editable: true,
          content: c.name,
          placeholderText: "12字以内",
        });
        if (!b.confirm) return;
        item.name = b.content || "";
      } else if (a.tapIndex === 1) item.hidden = !item.hidden;
      else if (a.tapIndex === 2) {
        const b = await wx.showActionSheet({ itemList: this.data.kinds });
        item.kind = ["protein", "vegetable", "soup", "staple", "dessert"][
          b.tapIndex
        ];
      } else {
        if (
          this.data.dishes.some((d) => (d.category_id || d.category) === c.id)
        )
          throw Error("分类里还有菜，请先在菜谱编辑里移动分类");
        const b = await wx.showModal({
          title: "删除空分类",
          content: "只删除这个空分类，菜谱和历史饭局会保留。",
        });
        if (!b.confirm) return;
        rows = rows.filter((x) => x.id !== c.id);
      }
      await this.persist(rows);
    } catch (e) {
      if (!(e as any).errMsg?.includes("cancel")) failure(e);
    }
  },
  async move(e: WechatMiniprogram.TouchEvent) {
    const i = this.data.categories.findIndex(
        (c) => c.id === e.currentTarget.dataset.id,
      ),
      j = i + Number(e.currentTarget.dataset.delta);
    if (i < 0 || j < 0 || j >= this.data.categories.length) return;
    const rows = this.data.categories.map((c) => ({ ...c }));
    [rows[i], rows[j]] = [rows[j], rows[i]];
    await this.persist(rows);
  },
  expand(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id;
    this.setData({ expanded: this.data.expanded === id ? "" : id });
  },
  edit(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({
      url: "/pages/editor/index?id=" + e.currentTarget.dataset.id,
    });
  },
  async moveDish(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const d = this.data.dishes.find((d) => d.id === e.currentTarget.dataset.id);
    if (!d) return;
    const group = this.data.dishes.filter(
      (x) => x.category_id === d.category_id,
    );
    const i = group.findIndex((x) => x.id === d.id),
      j = i + Number(e.currentTarget.dataset.delta);
    if (j < 0 || j >= group.length) return;
    const ids = this.data.dishes.map((x) => x.id),
      a = ids.indexOf(d.id),
      b = ids.indexOf(group[j].id);
    [ids[a], ids[b]] = [ids[b], ids[a]];
    this.setData({ busy: true });
    try {
      await mutate("dish.reorder", {
        kitchen_id: currentKitchen(),
        expected_revision: this.data.revision,
        dish_ids: ids,
      });
      await this.refresh();
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
});
