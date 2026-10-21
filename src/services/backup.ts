import { call, mutate, completeMedia, isLocal, profile } from "./api";
const {
  makePart,
  openPart,
  imageIds,
  MAX_PART,
} = require("../shared/portable");
const { sha256 } = require("../shared/hash");
export type BackupFile = {
  path: string;
  name: string;
  size: number;
  records: number;
};
const storagePrefix = "squiddy-backups-v1-";
const progressPrefix = "squiddy-restore-v1-";
function id() {
  return sha256(String(Date.now()) + Math.random()).slice(0, 24);
}
function fs() {
  return wx.getFileSystemManager();
}
function readFile(path: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) =>
    fs().readFile({
      filePath: path,
      success: (r) => resolve(r.data as ArrayBuffer),
      fail: reject,
    }),
  );
}
function writeFile(path: string, data: Uint8Array): Promise<void> {
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
  return new Promise((resolve, reject) =>
    fs().writeFile({
      filePath: path,
      data: buffer,
      success: () => resolve(),
      fail: reject,
    }),
  );
}
export async function savedBackups(): Promise<BackupFile[]> {
  const p = await profile();
  return wx.getStorageSync(storagePrefix + p.display_id) || [];
}
export async function removeLocalBackup(path: string) {
  const p = await profile(),
    key = storagePrefix + p.display_id;
  const files = (wx.getStorageSync(key) || []) as BackupFile[];
  if (
    !files.some((f) => f.path === path) ||
    !path.startsWith(wx.env.USER_DATA_PATH + "/") ||
    !/^squiddy-backup-[a-zA-Z0-9-]+\.zip$/.test(
      path.slice(wx.env.USER_DATA_PATH.length + 1),
    )
  )
    throw Error("不能删除这个文件");
  fs().unlinkSync(path);
  wx.setStorageSync(
    key,
    files.filter((f) => f.path !== path),
  );
}
async function remember(files: BackupFile[]) {
  const p = await profile();
  const key = storagePrefix + p.display_id;
  const previous = (wx.getStorageSync(key) || []) as BackupFile[];
  const known = new Set(previous.map((f) => f.path));
  wx.setStorageSync(key, [
    ...previous,
    ...files.filter((f) => !known.has(f.path)),
  ]);
}
export async function exportKitchen(
  kid: string,
  options: {
    images: boolean;
    progress: (s: string) => void;
    cancelled?: () => boolean;
  },
): Promise<BackupFile[]> {
  const meta = await call("backup.read", {
    kitchen_id: kid,
    section: "kitchen",
  });
  const group = id(),
    dishes: any[] = [];
  let cursor = "";
  do {
    const p = await call("backup.read", {
      kitchen_id: kid,
      section: "dishes",
      cursor,
    });
    dishes.push(...p.items);
    cursor = p.next_cursor;
  } while (cursor);
  const files: BackupFile[] = [],
    base = {
      group,
      kitchen: meta.kitchen,
      personal: meta.personal,
      scope: meta.scope,
      exported_at: Date.now(),
      counts: { dishes: dishes.length, source_meals: meta.counts.meals },
      images_included: options.images,
    };
  let records: any[] = [],
    images: Record<string, Uint8Array> = Object.create(null),
    size = 0,
    part = 0;
  const check = () => {
    if (options.cancelled?.())
      throw Error("导出已停止，已生成的分卷不代表完整备份");
  };
  async function flush() {
    if (!records.length && !Object.keys(images).length) return;
    check();
    const bytes = makePart({ ...base, part: ++part, records }, images);
    const path =
      wx.env.USER_DATA_PATH + "/squiddy-backup-" + group + "-" + part + ".zip";
    const name =
      "鱿鱼须须-" +
      String(meta.kitchen.name)
        .replace(/[\\/:*?"<>|]/g, "")
        .slice(0, 20) +
      "-" +
      new Date().toISOString().slice(0, 10) +
      "-" +
      String(part).padStart(2, "0") +
      ".zip";
    await writeFile(path, bytes);
    const file = { path, name, size: bytes.length, records: records.length };
    files.push(file);
    await remember([file]);
    records = [];
    images = Object.create(null);
    size = 0;
  }
  async function imageBytes(imageId: string): Promise<Uint8Array> {
    if (isLocal) {
      const m = await call("media.read", { media_id: imageId });
      if (m.status !== "approved") throw Error("演练图片未就绪");
      return new Uint8Array(await readFile(m.file_id));
    }
    const r = await call("media.content", { media_id: imageId });
    return new Uint8Array(wx.base64ToArrayBuffer(r.base64));
  }
  async function append(record: any) {
    check();
    const found: Record<string, Uint8Array> = Object.create(null);
    if (record.kind === "meal" && options.images) {
      if (records.length >= 15) await flush();
      records.push(record);
      size += JSON.stringify(record).length * 3;
      for (const imageId of imageIds(record.data)) {
        if (images[imageId]) continue;
        const bytes = await imageBytes(imageId);
        check();
        if (size + bytes.length > 8 * 1024 * 1024) {
          await flush();
          records.push(record);
          size = JSON.stringify(record).length * 3;
        }
        images[imageId] = bytes;
        size += bytes.length;
      }
      return;
    }
    if (options.images)
      for (const imageId of imageIds(record.data)) {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(imageId))
          throw Error("图片标识无效，导出已停止");
        found[imageId] = images[imageId] || (await imageBytes(imageId));
      }
    const bytes =
      Object.values(found).reduce((n, b) => n + b.length, 0) +
      JSON.stringify(record).length * 3;
    if (
      records.length &&
      (size + bytes > 8 * 1024 * 1024 || records.length >= 15)
    )
      await flush();
    records.push(record);
    for (const [key, value] of Object.entries(found))
      if (!images[key]) {
        images[key] = value;
        size += value.length;
      }
    size += JSON.stringify(record).length * 3;
  }
  if (options.images && meta.kitchen.image_id) {
    images[meta.kitchen.image_id] = await imageBytes(meta.kitchen.image_id);
    size += images[meta.kitchen.image_id].length;
  }
  for (let i = 0; i < dishes.length; i++) {
    options.progress("正在备份菜谱 " + (i + 1) + " / " + dishes.length);
    await append({ kind: "dish", data: dishes[i] });
  }
  cursor = "";
  let meals = 0;
  do {
    check();
    const p = await call("backup.read", {
      kitchen_id: kid,
      section: "meals",
      cursor,
    });
    for (const m of p.items) {
      await append({ kind: "meal", data: m });
      meals++;
      options.progress(
        "已备份 " + dishes.length + " 道菜谱、" + meals + " 场饭局",
      );
    }
    cursor = p.next_cursor;
  } while (cursor);
  // Even an empty kitchen gets a portable metadata file.
  if (!files.length && !records.length)
    records.push({ kind: "meal", data: { title: "空厨房备份", empty: true } });
  await flush();
  const end = await call("backup.read", {
    kitchen_id: kid,
    section: "kitchen",
  });
  if (end.kitchen.revision !== meta.kitchen.revision)
    throw Error("厨房在备份期间发生变化，请重新导出；本次分卷不代表一致备份");
  options.progress(
    "导出完成：" + files.length + " 个文件，请全部保存。饭局按读取时状态备份。",
  );
  return files;
}
export async function loadBackup(path: string, size?: number) {
  if (size && size > MAX_PART) throw Error("请选择12MB以内的Squiddy备份分卷");
  const bytes = new Uint8Array(await readFile(path));
  return openPart(bytes);
}
type RestoreState = {
  session: string;
  kitchenId: string;
  images: Record<string, string>;
  dishes: Record<string, string>;
  coverDone?: boolean;
  categoriesDone?: boolean;
};
function recipePayload(d: any) {
  const allowed = [
    "name",
    "category",
    "category_id",
    "ingredients",
    "steps",
    "minutes",
    "vegetarian",
    "spicy",
    "allergens",
    "active",
    "default_serves",
    "ingredient_complete",
    "subtitle",
    "source_url",
    "step_title",
    "recipe_steps",
    "variants",
    "attributes",
    "nutrition",
  ];
  const out: Record<string, any> = {};
  for (const key of allowed) if (d[key] !== undefined) out[key] = d[key];
  if (d.default_price_minor !== undefined)
    out.default_price_minor = d.default_price_minor;
  if (d.default_variant_prices) out.variant_prices = d.default_variant_prices;
  return out;
}
export async function restoreBackup(
  archive: any,
  progress: (text: string) => void,
  textOnly = false,
  cancelled: () => boolean = () => false,
) {
  const check = () => {
    if (cancelled()) throw Error("恢复已暂停，重新选择同批次文件可继续");
  };
  check();
  const p = await profile(),
    { data, images } = archive;
  const stateKey = progressPrefix + p.display_id + "-" + data.group;
  const state: RestoreState = wx.getStorageSync(stateKey) || {
    session: id(),
    kitchenId: "",
    images: {},
    dishes: {},
  };
  const save = () => wx.setStorageSync(stateKey, state);
  if (!state.kitchenId) {
    check();
    const k = await mutate("backup.restoreKitchen", {
      backup_group: state.session,
      name: ("恢复 · " + data.kitchen.name).slice(0, 32),
      description: data.kitchen.description || "",
    });
    state.kitchenId = k.id;
    save();
  }
  if (!state.categoriesDone) {
    check();
    if (data.kitchen.categories?.length) {
      const k = await call("kitchen.read", { kitchen_id: state.kitchenId });
      await mutate("category.save", {
        kitchen_id: state.kitchenId,
        expected_revision: k.revision,
        categories: data.kitchen.categories,
      });
    }
    state.categoriesDone = true;
    save();
  }
  const records = data.records.filter((r: any) => r.kind === "dish");
  const required = new Set<string>(
    textOnly ? [] : records.flatMap((r: any) => imageIds(r.data)),
  );
  if (
    !textOnly &&
    data.kitchen.image_id &&
    (images[data.kitchen.image_id] || state.images[data.kitchen.image_id])
  )
    required.add(data.kitchen.image_id);
  let pending = 0;
  for (const original of required) {
    check();
    if (!images[original] && !state.images[original])
      throw Error(
        "此分卷缺少菜谱图片，不能标记恢复完成。请使用带图片的备份，或明确选择仅恢复文字。",
      );
    let mediaId = state.images[original],
      status = "";
    if (mediaId) {
      try {
        status = (await call("media.read", { media_id: mediaId })).status;
      } catch (e) {
        if ((e as any).code !== "NOT_FOUND") throw e;
        mediaId = "";
      }
    }
    if (status === "rejected")
      throw Error("备份图片未通过平台审核，不能导入菜谱");
    if (!mediaId || status === "failed") {
      const ticket = await mutate("media.prepare", {
        kitchen_id: state.kitchenId,
      });
      mediaId = ticket.id;
      state.images[original] = mediaId;
      save();
      status = "awaiting_upload";
    }
    if (status === "awaiting_upload") {
      const bytes = images[original];
      if (!bytes) throw Error("请重新选择含有此图片的备份分卷");
      let payload: Record<string, unknown> = { media_id: mediaId };
      if (isLocal) {
        const file =
          wx.env.USER_DATA_PATH +
          "/squiddy-restore-" +
          state.session +
          "-" +
          original +
          ".jpg";
        await writeFile(file, bytes);
        payload.local_path = file;
      } else
        payload.base64 = wx.arrayBufferToBase64(
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer,
        );
      status = (await completeMedia(payload)).status;
    }
    if (status !== "approved") pending++;
    progress("正在检查备份图片，待审核 " + pending + " 张");
  }
  if (pending)
    return {
      kitchenId: state.kitchenId,
      pending,
      restored: Object.keys(state.dishes).length,
      total: data.counts.dishes,
    };
  const map = (imageId: string) =>
    !textOnly && imageId ? state.images[imageId] || "" : "";
  if (
    !textOnly &&
    data.kitchen.image_id &&
    state.images[data.kitchen.image_id] &&
    !state.coverDone
  ) {
    const k = await call("kitchen.read", { kitchen_id: state.kitchenId });
    await mutate("kitchen.update", {
      kitchen_id: k.id,
      expected_revision: k.revision,
      name: k.name,
      description: k.description,
      image_id: map(data.kitchen.image_id),
    });
    state.coverDone = true;
    save();
  }
  for (const record of records) {
    check();
    const d = record.data;
    if (state.dishes[d.id]) continue;
    const payload = recipePayload(d);
    payload.image_id = map(d.image_id);
    if (payload.recipe_steps)
      payload.recipe_steps = payload.recipe_steps.map((s: any) => ({
        text: s.text,
        image_id: map(s.image_id),
      }));
    const imported = await mutate("backup.restoreDish", {
      ...payload,
      kitchen_id: state.kitchenId,
      backup_group: state.session,
      source_id: d.id,
    });
    state.dishes[d.id] = imported.id;
    save();
    progress(
      "已恢复 " +
        Object.keys(state.dishes).length +
        " / " +
        data.counts.dishes +
        " 道菜谱",
    );
  }
  return {
    kitchenId: state.kitchenId,
    pending: 0,
    restored: Object.keys(state.dishes).length,
    total: data.counts.dishes,
  };
}
export function clearLocalBackups() {
  try {
    for (const name of fs().readdirSync(wx.env.USER_DATA_PATH))
      if (
        /^squiddy-(backup-[a-zA-Z0-9-]+\.zip|restore-[a-zA-Z0-9_-]+\.jpg)$/.test(
          name,
        )
      )
        fs().unlinkSync(wx.env.USER_DATA_PATH + "/" + name);
  } catch {}
  for (const key of wx.getStorageInfoSync().keys)
    if (key.startsWith(storagePrefix) || key.startsWith(progressPrefix))
      wx.removeStorageSync(key);
}
