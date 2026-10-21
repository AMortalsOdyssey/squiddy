const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
test("云模式构建在隔离目录排除演练引擎，缺环境配置则失败", () => {
  const root = path.resolve(__dirname, ".."),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "squiddy-build-"));
  try {
    for (const name of [
      "src",
      "domain",
      "scripts",
      "tsconfig.json",
      "project.config.example.json",
    ])
      fs.cpSync(path.join(root, name), path.join(dir, name), {
        recursive: true,
      });
    fs.symlinkSync(
      path.join(root, "node_modules"),
      path.join(dir, "node_modules"),
      "dir",
    );
    fs.mkdirSync(path.join(dir, "config"));
    const config = path.join(dir, "config/local.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        mode: "cloud",
        appid: "wx0000000000000000",
        cloudEnv: "",
      }),
    );
    assert.throws(() =>
      execFileSync(process.execPath, ["scripts/build.mjs"], {
        cwd: dir,
        stdio: "pipe",
      }),
    );
    fs.writeFileSync(
      config,
      JSON.stringify({
        mode: "cloud",
        appid: "wx0000000000000000",
        cloudEnv: "build-test-only",
      }),
    );
    execFileSync(process.execPath, ["scripts/build.mjs"], {
      cwd: dir,
      stdio: "pipe",
    });
    assert.equal(fs.existsSync(path.join(dir, "miniprogram/domain")), false);
    assert.equal(
      fs.existsSync(path.join(dir, "miniprogram/services/local.js")),
      false,
    );
    assert.match(
      fs.readFileSync(path.join(dir, "miniprogram/config/runtime.js"), "utf8"),
      /cloud/,
    );
    const appRoot = path.join(dir, "miniprogram");
    const before = fs.statSync(appRoot).ino;
    const appFile = path.join(appRoot, "app.json");
    const appBefore = fs.statSync(appFile).ino;
    fs.writeFileSync(path.join(appRoot, "obsolete.js"), "old build");
    execFileSync(process.execPath, ["scripts/build.mjs"], {
      cwd: dir,
      stdio: "pipe",
    });
    assert.equal(
      fs.statSync(appRoot).ino,
      before,
      "preserve Developer Tools root watcher",
    );
    assert.equal(
      fs.statSync(appFile).ino,
      appBefore,
      "app.json must never disappear",
    );
    assert.equal(fs.existsSync(path.join(appRoot, "obsolete.js")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("CloudBase适配器保留SDK的data包装，不把网络错误当成不存在", async () => {
  const { cloudStore } = require("../cloud/shared/store");
  const values = {};
  const db = {
    command: { gt: (x) => ({ $gt: x }) },
    runTransaction: async (fn) =>
      fn({
        collection: (table) => ({
          doc: (id) => ({
            get: async () => {
              if (id === "network") throw { errCode: -1, errMsg: "network" };
              return { data: values[table + id] };
            },
            set: async (body) => {
              assert.deepEqual(Object.keys(body), ["data"]);
              values[table + id] = body.data;
            },
            remove: async () => delete values[table + id],
          }),
        }),
      }),
  };
  const store = cloudStore(db);
  await store.transaction(async (tx) => {
    await tx.put("meals", "id", { _id: "ignored", title: "晚饭" });
    assert.deepEqual(await tx.get("meals", "id"), { title: "晚饭" });
    await assert.rejects(tx.get("meals", "network"));
    await tx.remove("meals", "id");
    assert.equal(await tx.get("meals", "id"), undefined);
  });
});
test("CloudBase适配器兼容实际微信SDK的缺失文档错误", async () => {
  const cloud = require("../cloudfunctions/api/node_modules/wx-server-sdk");
  const { cloudStore } = require("../cloud/shared/store");
  cloud.init({ env: "squiddy-contract-test" });
  const sdkDb = cloud.database();
  const reference = sdkDb.collection("users").doc("missing-user");
  // Exercise the real SDK's document wrapper without making network calls.
  reference._document.get = async () => ({ data: [] });
  await assert.rejects(reference.get(), (error) => error.errCode === -1);
  const store = cloudStore({
    runTransaction: (fn) =>
      fn({ collection: () => ({ doc: () => reference }) }),
  });
  assert.equal(
    await store.transaction((tx) => tx.get("users", "missing-user")),
    undefined,
  );
  reference._document.get = async () => {
    throw new Error("network unavailable");
  };
  await assert.rejects(
    store.transaction((tx) => tx.get("users", "missing-user")),
    /network unavailable/,
  );
});
