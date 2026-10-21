const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  backup,
  restore,
  archive,
  openArchive,
  restorePlan,
  missingRestoreRows,
} = require("../scripts/backup.cjs");
const original = "cloud://private.bucket/private-images/picture.jpg";
const target =
  "cloud://private.bucket/squiddy-restore/test/" + "a".repeat(64) + ".jpg";
const snapshot = {
  kitchens: { kitchen: { _id: "kitchen", image_id: "picture" } },
  media: { picture: { _id: "picture", file_id: original } },
};
const bytes = Buffer.from("actual-file-bytes");
const envelope = () => archive(snapshot, { [original]: bytes });
test("完整备份同时保存数据库和文件，旧离线格式保留兼容", () => {
  assert.deepEqual(restore(backup(snapshot)).snapshot(), snapshot);
  const data = openArchive(envelope());
  assert.deepEqual(data.snapshot, snapshot);
  assert.deepEqual(data.files[original], bytes);
  assert.throws(() => archive(snapshot, {}), /Missing/);
});
test("数据库、附件和附件清单损坏均在云写入前拒绝", () => {
  const damaged = envelope();
  damaged.data += " ";
  assert.throws(() => openArchive(damaged), /checksum/);
  for (const change of [
    (v) => (v.files[0].base64 = Buffer.from("corrupt").toString("base64")),
    (v) => (v.files = []),
    (v) => v.files.push(v.files[0]),
  ]) {
    const e = envelope(),
      data = JSON.parse(e.data);
    change(data);
    e.data = JSON.stringify(data);
    e.sha256 = crypto.createHash("sha256").update(e.data).digest("hex");
    assert.throws(() => openArchive(e), /checksum|incomplete|Invalid/);
  }
});
test("非法文档和危险集合键不能进入恢复库", () => {
  for (const data of [
    { media: { id: null } },
    { media: { id: [] } },
    { media: { id: { _id: "other" } } },
    JSON.parse('{"__proto__":{}}'),
  ])
    assert.throws(() => backup(data), /Invalid/);
});
test("恢复只使用隔离文件副本，替换全部文件引用并保留关联ID", () => {
  const plan = restorePlan(envelope(), { [original]: target });
  assert.equal(plan.snapshot.media.picture.file_id, target);
  assert.equal(plan.snapshot.kitchens.kitchen.image_id, "picture");
  assert.equal(plan.rows.length, 2);
  assert.throws(
    () => restorePlan(envelope(), { [original]: original }),
    /isolated/,
  );
  assert.throws(() => restorePlan(envelope(), {}), /isolated/);
});
test("恢复中断只补缺失记录，完全相同无需重写，冲突拒绝覆盖", () => {
  const plan = restorePlan(envelope(), { [original]: target });
  assert.equal(missingRestoreRows(plan, []).length, 2);
  assert.equal(missingRestoreRows(plan, plan.rows.slice(0, 1)).length, 1);
  assert.deepEqual(missingRestoreRows(plan, plan.rows), []);
  const changed = JSON.parse(JSON.stringify(plan.rows));
  changed[0].value.name = "changed after restore";
  assert.throws(() => missingRestoreRows(plan, changed), /conflict/);
  assert.throws(
    () => missingRestoreRows(plan, [{ _id: "unexpected" }]),
    /conflict/,
  );
});
test("注销清理保留上传预约的等待时间，文件完成回收后才结束注销", async () => {
  const { cleanupBatch } = require("../domain/maintenance");
  const { createMemoryStore } = require("../domain/store");
  const store = createMemoryStore({
    media: { uploading: { actor: "actor", file_id: original } },
    file_deletions: {
      uploading: {
        file_id: original,
        status: "upload_reserved",
        not_before: 9999999999999,
      },
    },
    cleanup_jobs: {
      job: {
        kind: "account",
        actor: "actor",
        table: 10,
        cursor: "",
        file_ids: [],
      },
    },
  });
  await cleanupBatch(store, "job");
  assert.equal(store.snapshot().media.uploading, undefined);
  assert.equal(
    store.snapshot().file_deletions.uploading.status,
    "upload_reserved",
  );
  assert.equal(
    store.snapshot().file_deletions.uploading.not_before,
    9999999999999,
  );
  for (let i = 0; i < 25; i++) await cleanupBatch(store, "job");
  assert.equal(store.snapshot().cleanup_jobs.job.status, "running");
  await store.transaction((tx) => tx.remove("file_deletions", "uploading"));
  assert.equal((await cleanupBatch(store, "job")).status, "completed");
});
