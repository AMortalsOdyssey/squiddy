import {
  saveForm,
  loadForm,
  clearForm,
  warnUnsaved,
  clearUnsavedWarning,
} from "../../services/forms";
import {
  kitchen,
  currentKitchen,
  mutate,
  completeMedia,
  call,
  failure,
  isLocal,
  money,
  profile,
  resolveImages,
  parseMoney,
} from "../../services/api";
Page({
  data: {
    local: isLocal,
    mediaAvailable: isLocal,
    draftSaved: false,
    dirty: false,
    loading: true,
    busy: false,
    dishId: "",
    revision: 0,
    name: "",
    subtitle: "",
    sourceUrl: "",
    stepTitle: "跟着这样做",
    stepRows: [] as {
      text: string;
      image_id: string;
      image_url?: string;
      image_status?: string;
    }[],
    variants: "",
    variantPrices: [] as { variant: string; value: string }[],
    attributes: "",
    nutritionVisible: false,
    nutritionSource: "",
    nutritionBasis: "每份",
    calories: "",
    protein: "",
    fat: "",
    carbs: "",
    fiber: "",
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
      const [k, p] = await Promise.all([kitchen(), profile()]);
      this.setData({ mediaAvailable: isLocal || !!p.features.media });
      if (k.role === "member") throw Error("只有厨房管理员可以编辑菜谱");
      let d = k.dishes.find((d) => d.id === q.id);
      if (q.id && !d) throw Error("菜谱不存在");
      this.setData({
        canPrice: k.can_price,
        categories: k.categories.map((c) => c.name),
        categoryIds: k.categories.map((c) => c.id),
      });
      if (d) [d] = await resolveImages([d]);
      if (d)
        this.setData({
          revision: d.revision,
          subtitle: d.subtitle || "",
          sourceUrl: d.source_url || "",
          stepTitle: d.step_title || "跟着这样做",
          stepRows: (d.recipe_steps || []).map((s) => ({
            ...s,
            image_status: s.image_id ? "approved" : "",
          })),
          variants: (d.variants || []).join("、"),
          variantPrices: (d.variants || []).map((variant) => ({
            variant,
            value:
              d!.default_variant_prices?.find((p) => p.variant === variant)
                ?.unit_price_minor == null
                ? ""
                : money(
                    d!.default_variant_prices!.find(
                      (p) => p.variant === variant,
                    )!.unit_price_minor,
                  ),
          })),
          attributes: (d.attributes || [])
            .map((a) => a.name + ":" + a.options.join("、"))
            .join("\n"),
          nutritionVisible: !!d.nutrition?.visible,
          nutritionSource: d.nutrition?.source || "",
          nutritionBasis: d.nutrition?.basis || "每份",
          ...Object.fromEntries(
            ["calories", "protein", "fat", "carbs", "fiber"].map((k) => [
              k,
              d!.nutrition?.[k as "calories"] == null
                ? ""
                : String(d!.nutrition![k as "calories"]),
            ]),
          ),
          name: d.name,
          ingredients: d.ingredients.join("、"),
          allergens: d.allergens.join("、"),
          steps: d.steps,
          minutes: String(d.minutes),
          defaultServes: String(d.default_serves),
          ingredientComplete: d.ingredient_complete,
          categoryIndex: Math.max(
            0,
            this.data.categoryIds.indexOf(d.category_id || d.category),
          ),
          vegetarian: d.vegetarian,
          spicy: d.spicy,
          active: d.active,
          price:
            d.default_price_minor == null ? "" : money(d.default_price_minor),
          imageId: d.image_id,
          imageUrl: d.image_url || "",
          imageStatus: d.image_id ? "approved" : "",
        });
      const draft = loadForm("editor", q.id || "");
      if (draft) {
        const answer = await wx.showModal({
          title: "发现未保存的菜谱",
          content:
            draft.revision === this.data.revision
              ? "要继续上次编辑的文字内容吗？图片与内部价格不会从草稿恢复。"
              : "菜谱已有更新。恢复会替换当前表单文字，保存前请核对最新内容；图片与内部价格不会从草稿恢复。",
          confirmText: "恢复草稿",
          cancelText: "放弃草稿",
        });
        if (answer.confirm) {
          this.setData({ ...draft.fields, dirty: true, draftSaved: true });
          this.syncVariantPrices();
          warnUnsaved();
        } else clearForm("editor", q.id || "");
      }
    } catch (e) {
      this.setData({ error: (e as Error).message });
    } finally {
      this.setData({ loading: false });
    }
  },
  onUnload() {
    this.setData({ price: "", variantPrices: [] });
    clearUnsavedWarning();
  },
  remember() {
    this.setData({
      dirty: true,
      draftSaved: saveForm(
        "editor",
        this.data.dishId,
        this.data,
        this.data.revision,
      ),
    });
    warnUnsaved();
  },
  input(e: WechatMiniprogram.Input) {
    const field = e.currentTarget.dataset.field;
    if (
      ![
        "name",
        "subtitle",
        "sourceUrl",
        "stepTitle",
        "variants",
        "attributes",
        "nutritionVisible",
        "nutritionSource",
        "nutritionBasis",
        "calories",
        "protein",
        "fat",
        "carbs",
        "fiber",
        "ingredients",
        "allergens",
        "steps",
        "minutes",
        "defaultServes",
        "price",
        "vegetarian",
        "spicy",
        "active",
        "ingredientComplete",
      ].includes(field)
    )
      return;
    this.setData({ [field]: e.detail.value });
    if (field === "variants") this.syncVariantPrices();
    this.remember();
  },
  syncVariantPrices() {
    this.setData({
      variantPrices: Array.from(
        new Set(
          this.data.variants
            .split(/[、,，\n]/)
            .map((v) => v.trim())
            .filter(Boolean),
        ),
      ).map((variant) => ({
        variant,
        value:
          this.data.variantPrices.find((p) => p.variant === variant)?.value ||
          "",
      })),
    });
  },
  variantPriceInput(e: WechatMiniprogram.Input) {
    this.setData({
      ["variantPrices[" + Number(e.currentTarget.dataset.index) + "].value"]:
        e.detail.value,
    });
    this.remember();
  },
  category(e: WechatMiniprogram.PickerChange) {
    this.setData({ categoryIndex: Number(e.detail.value) });
    this.remember();
  },
  toggle(e: WechatMiniprogram.SwitchChange) {
    const field = e.currentTarget.dataset.field;
    if (
      ![
        "name",
        "subtitle",
        "sourceUrl",
        "stepTitle",
        "variants",
        "attributes",
        "nutritionVisible",
        "nutritionSource",
        "nutritionBasis",
        "calories",
        "protein",
        "fat",
        "carbs",
        "fiber",
        "ingredients",
        "allergens",
        "steps",
        "minutes",
        "defaultServes",
        "price",
        "vegetarian",
        "spicy",
        "active",
        "ingredientComplete",
      ].includes(field)
    )
      return;
    this.setData({ [field]: e.detail.value });
    this.remember();
  },
  addStep() {
    if (this.data.stepRows.length >= 15) return;
    this.setData({
      stepRows: [...this.data.stepRows, { text: "", image_id: "" }],
    });
    this.remember();
  },
  stepInput(e: WechatMiniprogram.Input) {
    this.setData({
      ["stepRows[" + Number(e.currentTarget.dataset.index) + "].text"]:
        e.detail.value,
    });
    this.remember();
  },
  removeStep(e: WechatMiniprogram.TouchEvent) {
    this.setData({
      stepRows: this.data.stepRows.filter(
        (_, i) => i !== Number(e.currentTarget.dataset.index),
      ),
    });
    this.remember();
  },
  splitSteps() {
    const rows = this.data.steps
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 15);
    if (!rows.length) return;
    this.setData({ stepRows: rows.map((text) => ({ text, image_id: "" })) });
    this.remember();
  },
  suggestSubtitle() {
    if (!this.data.name) return;
    this.setData({
      subtitle:
        "约" + this.data.minutes + "分钟，把" + this.data.name + "端上桌",
    });
    this.remember();
  },
  async checkStepImage(e: WechatMiniprogram.TouchEvent) {
    const i = Number(e.currentTarget.dataset.index),
      step = this.data.stepRows[i];
    if (!step?.image_id) return;
    try {
      const r = await call("media.read", { media_id: step.image_id });
      this.setData({ ["stepRows[" + i + "].image_status"]: r.status });
      if (r.status !== "approved")
        wx.showToast({ title: "图片仍在审核，请稍后重试", icon: "none" });
    } catch (e) {
      failure(e);
    }
  },
  removeStepImage(e: WechatMiniprogram.TouchEvent) {
    const i = Number(e.currentTarget.dataset.index);
    this.setData({
      ["stepRows[" + i + "].image_id"]: "",
      ["stepRows[" + i + "].image_url"]: "",
      ["stepRows[" + i + "].image_status"]: "",
    });
    this.remember();
  },
  async photo(e?: WechatMiniprogram.TouchEvent) {
    const stepIndex = e?.currentTarget.dataset.step;
    if (this.data.busy) return;
    if (!this.data.mediaAvailable) {
      wx.showToast({
        title: "照片功能准备中，文字菜谱可以正常保存",
        icon: "none",
      });
      return;
    }
    try {
      const pick = await wx.chooseMedia({
        count: 1,
        mediaType: ["image"],
        sourceType: ["album", "camera"],
        sizeType: ["compressed"],
      });
      const file = pick.tempFiles[0];
      if (file.size > 2 * 1024 * 1024) throw Error("图片请控制在2MB以内");
      this.setData({ busy: true });
      if (stepIndex === undefined)
        this.setData({ imageUrl: file.tempFilePath, imageStatus: "uploading" });
      const ticket = await mutate("media.prepare", {
        kitchen_id: currentKitchen(),
      });
      if (stepIndex === undefined) this.setData({ imageId: ticket.id });
      else
        this.setData({
          ["stepRows[" + Number(stepIndex) + "].image_id"]: ticket.id,
          ["stepRows[" + Number(stepIndex) + "].image_status"]: "uploading",
          ["stepRows[" + Number(stepIndex) + "].image_url"]: file.tempFilePath,
        });
      const payload: Record<string, unknown> = { media_id: ticket.id };
      if (isLocal) payload.local_path = file.tempFilePath;
      else
        payload.base64 = await new Promise<string>((resolve, reject) =>
          wx.getFileSystemManager().readFile({
            filePath: file.tempFilePath,
            encoding: "base64",
            success: (r) => resolve(r.data as string),
            fail: reject,
          }),
        );
      const uploaded = await completeMedia(payload);
      if (stepIndex === undefined)
        this.setData({ imageId: ticket.id, imageStatus: uploaded.status });
      else {
        this.setData({
          ["stepRows[" + Number(stepIndex) + "].image_id"]: ticket.id,
          ["stepRows[" + Number(stepIndex) + "].image_status"]: uploaded.status,
          ["stepRows[" + Number(stepIndex) + "].image_url"]: file.tempFilePath,
        });
        this.remember();
      }
    } catch (e) {
      if (!(e as any).errMsg?.includes("cancel")) failure(e);
      if (stepIndex === undefined) this.setData({ imageStatus: "failed" });
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
      for (const step of this.data.stepRows) {
        if (
          step.image_id &&
          (await call("media.read", { media_id: step.image_id })).status !==
            "approved"
        )
          throw Error("步骤图片需审核通过才能保存，或先移除图片");
      }
      const list = (s: string) =>
        s
          .split(/[、,，\n]/)
          .map((v) => v.trim())
          .filter(Boolean);
      if (this.data.nutritionVisible && !this.data.nutritionSource.trim())
        throw Error("展示营养数据前，请填写来源与计量依据");
      const data: Record<string, unknown> = {
        kitchen_id: currentKitchen(),
        dish_id: this.data.dishId || undefined,
        expected_revision: this.data.revision,
        name: this.data.name,
        subtitle: this.data.subtitle,
        source_url: this.data.sourceUrl,
        step_title: this.data.stepTitle,
        recipe_steps: this.data.stepRows.map((s) => ({
          text: s.text,
          image_id: s.image_id,
        })),
        variants: list(this.data.variants),
        attributes: this.data.attributes
          .split(/\n/)
          .filter((s) => s.trim())
          .map((s) => {
            const pair = s.split(/[:：]/);
            if (pair.length !== 2)
              throw Error("口味属性请按 名称:选项、选项 填写");
            return { name: pair[0].trim(), options: list(pair[1]) };
          }),
        nutrition: this.data.nutritionSource.trim()
          ? {
              visible: this.data.nutritionVisible,
              source: this.data.nutritionSource,
              basis: this.data.nutritionBasis,
              ...Object.fromEntries(
                ["calories", "protein", "fat", "carbs", "fiber"].map((k) => [
                  k,
                  this.data[k as "calories"].trim() === ""
                    ? null
                    : Number(this.data[k as "calories"]),
                ]),
              ),
            }
          : null,
        ingredients: list(this.data.ingredients),
        allergens: list(this.data.allergens),
        steps: this.data.steps,
        minutes: Number(this.data.minutes),
        default_serves: Number(this.data.defaultServes),
        ingredient_complete: this.data.ingredientComplete,
        category_id: this.data.categoryIds[this.data.categoryIndex],
        vegetarian: this.data.vegetarian,
        spicy: this.data.spicy,
        active: this.data.active,
        image_id: this.data.imageId,
      };
      if (!data.dish_id) delete data.dish_id;
      if (this.data.canPrice) {
        data.default_price_minor = parseMoney(this.data.price);
        data.variant_prices = this.data.variantPrices
          .filter((p) => p.value.trim())
          .map((p) => ({
            variant: p.variant,
            unit_price_minor: parseMoney(p.value),
          }));
      }
      await mutate("dish.save", data);
      clearForm("editor", this.data.dishId);
      this.setData({ dirty: false, draftSaved: false });
      clearUnsavedWarning();
      wx.showToast({ title: "菜谱已保存", icon: "success" });
      wx.navigateBack();
    } catch (e) {
      failure(e);
    } finally {
      this.setData({ busy: false });
    }
  },
});
