const { test } = require("node:test");
const assert = require("node:assert/strict");
const data = new Map();
global.wx = {
  getStorageSync: (k) => data.get(k),
  setStorageSync: (k, v) => data.set(k, structuredClone(v)),
  removeStorageSync: (k) => data.delete(k),
  showToast: () => {},
};
const api = require("../miniprogram/services/api");
test("发布回包丢失再遇审核限额时保留原请求号，恢复后确认结果而不创建新意图", async () => {
  const fs = require("node:fs"),
    vm = require("node:vm"),
    { createRequire } = require("node:module");
  const file = require.resolve("../miniprogram/services/api"),
    ownRequire = createRequire(file);
  const storage = new Map(),
    requests = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), {
    module,
    exports: module.exports,
    console,
    require: (id) =>
      id === "../config/runtime" ? { mode: "cloud" } : ownRequire(id),
    wx: {
      getStorageSync: (k) => storage.get(k),
      setStorageSync: (k, v) => storage.set(k, structuredClone(v)),
      removeStorageSync: (k) => storage.delete(k),
      cloud: {
        callFunction: async (options) => {
          requests.push(options.data.payload.request_id);
          if (requests.length === 1)
            throw Object.assign(Error("acknowledgement lost"), {
              code: "NETWORK",
            });
          if (requests.length === 2)
            return {
              result: {
                ok: false,
                error: {
                  code: "CONTENT_RATE_LIMITED",
                  message: "文字审核日额度已用尽",
                },
              },
            };
          return {
            result: { ok: true, data: { id: "already-committed-meal" } },
          };
        },
      },
    },
  });
  const mutate = module.exports.mutate;
  const payload = {
    kitchen_id: "kitchen",
    title: "原发布内容",
    dish_ids: ["dish"],
  };
  await assert.rejects(
    mutate("meal.publish", payload),
    (e) => e.code === "NETWORK",
  );
  assert.equal(requests.length, 1);
  assert.equal(storage.size, 1);
  await assert.rejects(
    mutate("meal.publish", payload),
    (e) => e.code === "CONTENT_RATE_LIMITED",
  );
  assert.equal(requests.length, 2, "不得自动重试");
  assert.equal(storage.size, 1);
  assert.equal(
    (await mutate("meal.publish", payload)).id,
    "already-committed-meal",
  );
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests).size, 1);
  assert.equal(storage.size, 0);
});
test("启动清理不使用同步文件API，新图片等待旧文件清理，备份文件保留", async () => {
  const fs = require("node:fs"),
    vm = require("node:vm"),
    { createRequire } = require("node:module");
  const file = require.resolve("../miniprogram/services/api"),
    ownRequire = createRequire(file);
  const files = new Map([
    ["/test/squiddy-media-one.jpg", "old"],
    ["/test/backup.zip", "keep"],
  ]);
  let directory,
    deletion,
    calls = 0;
  const manager = {
    readdir: (options) => {
      directory = options;
    },
    unlink: (options) => {
      deletion = options;
    },
    readdirSync: () => {
      throw Error("must not block startup");
    },
    unlinkSync: () => {
      throw Error("must not block startup");
    },
    writeFile: ({ filePath, data, success }) => {
      files.set(filePath, data);
      success();
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), {
    module,
    exports: module.exports,
    require: (id) =>
      id === "../config/runtime" ? { mode: "cloud" } : ownRequire(id),
    console,
    wx: {
      env: { USER_DATA_PATH: "/test" },
      getFileSystemManager: () => manager,
      cloud: {
        callFunction: async () => {
          calls++;
          return {
            result: { ok: true, data: { base64: "fresh", type: "jpeg" } },
          };
        },
      },
    },
  });
  const cloudApi = module.exports;
  const cleanup = cloudApi.clearMediaFilesAtLaunch();
  const rendering = cloudApi.mediaImage("one");
  await Promise.resolve();
  assert.equal(calls, 0);
  directory.success({ files: ["squiddy-media-one.jpg", "backup.zip"] });
  assert.equal(deletion.filePath, "/test/squiddy-media-one.jpg");
  assert.equal(calls, 0);
  files.delete(deletion.filePath);
  deletion.complete();
  await cleanup;
  assert.equal(await rendering, "/test/squiddy-media-one.jpg");
  assert.equal(calls, 1);
  assert.equal(files.get("/test/squiddy-media-one.jpg"), "fresh");
  assert.equal(files.get("/test/backup.zip"), "keep");
});
test("实际草稿模块拒绝损坏数量、重复菜品并白名单过滤价格", () => {
  const id = "draft1";
  data.set(api.draftKey(id), {
    items: [{ dish_id: "a", quantity: -1 }],
    revision: 0,
  });
  assert.equal(api.loadSelection(id), null);
  assert.equal(
    api.saveSelection(id, {
      items: [{ dish_id: "a", quantity: 2, price: 999 }],
      note: "不要香菜",
      revision: 0,
      people: 2,
      secret: "x",
    }),
    true,
  );
  assert.deepEqual(api.loadSelection(id), {
    items: [{ line_id: "a", dish_id: "a", quantity: 2 }],
    note: "不要香菜",
    people: 2,
    revision: 0,
  });
  assert.equal(
    api.saveSelection(id, {
      items: [
        { dish_id: "a", quantity: 1 },
        { dish_id: "a", quantity: 1 },
      ],
      revision: 0,
    }),
    false,
  );
});
test("草稿按演练身份隔离", () => {
  data.set("squiddy-rehearsal-actor", "alice");
  assert.equal(api.loadSelection("draft1"), null);
  data.set("squiddy-rehearsal-actor", "chef");
  assert.equal(api.loadSelection("draft1").people, 2);
});
test("存储失败不报告草稿保存成功", () => {
  const original = wx.setStorageSync;
  wx.setStorageSync = () => {
    throw Error("full");
  };
  assert.equal(
    api.saveSelection("x", { items: [], note: "", revision: 0, people: 1 }),
    false,
  );
  wx.setStorageSync = original;
});
test("货币转换拒绝指数、负数及三位小数，零与未填不同", () => {
  assert.equal(api.parseMoney(""), null);
  assert.equal(api.parseMoney("0"), 0);
  assert.equal(api.parseMoney("12.30"), 1230);
  for (const v of ["1e2", "-1", "1.234", "100000"])
    assert.throws(() => api.parseMoney(v));
});
test("云图片调用超时后只回读同一上传任务，不重新上传；确定性失败不掩盖", async () => {
  const fs = require("node:fs"),
    vm = require("node:vm"),
    { createRequire } = require("node:module");
  const file = require.resolve("../miniprogram/services/api"),
    ownRequire = createRequire(file);
  const source = fs.readFileSync(file, "utf8"),
    calls = [],
    saved = new Map(),
    files = new Map([["user-document.txt", "keep"]]);
  let rejected = false;
  const module = { exports: {} };
  const wxCloud = {
    getStorageSync: (k) => saved.get(k),
    setStorageSync: (k, v) => saved.set(k, v),
    removeStorageSync: (k) => saved.delete(k),
    env: { USER_DATA_PATH: "/private-render-test" },
    getFileSystemManager: () => ({
      writeFile: ({ filePath, data, success }) => {
        files.set(filePath.split("/").at(-1), data);
        success();
      },
      readdirSync: () => [...files.keys()],
      unlinkSync: (path) => files.delete(path.split("/").at(-1)),
    }),
    cloud: {
      callFunction: async ({ data: { action, payload } }) => {
        calls.push([action, payload.media_id]);
        if (action === "media.content")
          return {
            result: { ok: true, data: { type: "jpeg", base64: "/9j/2Q==" } },
          };
        if (action === "media.complete") {
          if (rejected)
            return {
              result: {
                ok: false,
                error: { code: "INVALID_IMAGE", message: "图片格式错误" },
              },
            };
          throw {
            errCode: -504003,
            errMsg: "Invoking task timed out after 3 seconds",
          };
        }
        return {
          result: {
            ok: true,
            data: { id: payload.media_id, status: "pending" },
          },
        };
      },
    },
  };
  const run = vm.runInNewContext(
    "(function(exports,require,module){" + source + "\n})",
    { wx: wxCloud, console: { info() {}, warn() {} } },
  );
  run(
    module.exports,
    (name) =>
      name === "../config/runtime" ? { mode: "cloud" } : ownRequire(name),
    module,
  );
  const cloudApi = module.exports;
  const result = await cloudApi.completeMedia({
    media_id: "same-ticket",
    base64: "aGVsbG8=",
  });
  assert.equal(result.status, "pending");
  assert.deepEqual(calls, [
    ["media.complete", "same-ticket"],
    ["media.read", "same-ticket"],
  ]);
  rejected = true;
  calls.length = 0;
  await assert.rejects(
    cloudApi.completeMedia({ media_id: "invalid-ticket" }),
    (e) => e.code === "INVALID_IMAGE",
  );
  assert.deepEqual(calls, [["media.complete", "invalid-ticket"]]);
  const image = await cloudApi.mediaImage("approved-render");
  assert.equal(image, "/private-render-test/squiddy-media-approved-render.jpg");
  assert.equal(files.get("squiddy-media-approved-render.jpg"), "/9j/2Q==");
  cloudApi.clearMediaFiles();
  assert.equal(files.has("squiddy-media-approved-render.jpg"), false);
  assert.equal(files.get("user-document.txt"), "keep");
});
