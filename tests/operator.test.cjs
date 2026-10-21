const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { archive } = require("../scripts/backup.cjs");
const { seal, unseal } = require("../scripts/backup-vault.cjs");
const { replyPlan } = require("../scripts/support.cjs");
const { summarize } = require("../scripts/health.cjs");
test("运营备份以独立密钥加密，损坏或错密钥拒绝，不改源备份", () => {
  const backup = archive({ users: { one: { name: "private" } } }, {}),
    key = crypto.randomBytes(32),
    encrypted = seal(backup, key);
  assert.equal(JSON.stringify(encrypted).includes("private"), false);
  assert.deepEqual(unseal(encrypted, key), backup);
  assert.throws(() => unseal(encrypted, crypto.randomBytes(32)));
  const broken = { ...encrypted, data: encrypted.data.slice(0, -4) + "AAAA" };
  assert.throws(() => unseal(broken, key));
});
test("反馈处理计划只允许单条目标与受控状态，用旧版本护栏拒绝盲目覆盖", () => {
  const p = replyPlan(
    { _id: "ticket123", revision: 3 },
    "已处理",
    "resolved",
    "env-fingerprint",
  );
  assert.deepEqual(p.query, { _id: "ticket123", revision: 3 });
  assert.equal(p.update.$set.revision, 4);
  assert.throws(() => replyPlan({ _id: "ticket123" }, "", "resolved", "env"));
  assert.throws(() =>
    replyPlan({ _id: "ticket123" }, "reply", "deleted", "env"),
  );
});
test("健康检查明确过期游标、失败文件、陈旧任务和样本截断，未知不当作零", () => {
  const now = Date.now(),
    r = summarize(
      {
        maintenance: [{ last_completed_at: now - 20 * 60000 }],
        files: [{ failures: 2 }],
        jobs: [{ status: "running", created_at: now - 25 * 3600000 }],
        audits: [],
      },
      now,
    );
  assert.equal(r.status, "needs_attention");
  assert.equal(r.scheduler_stale, true);
  assert.equal(r.failed_files_observed, 1);
  assert.equal(r.stalled_jobs_observed, 1);
  const ok = summarize(
    {
      maintenance: [{ last_completed_at: now }],
      files: [],
      jobs: [],
      audits: [],
    },
    now,
  );
  assert.equal(ok.status, "ok");
  const bounded = summarize(
    {
      maintenance: [{ last_completed_at: now }],
      files: [],
      jobs: [],
      audits: Array.from({ length: 100 }, () => ({ created_at: 0 })),
    },
    now,
  );
  assert.equal(bounded.counts_may_be_truncated, true);
});
