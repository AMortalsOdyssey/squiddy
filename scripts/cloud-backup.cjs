"use strict";
// Operator-only. Uses the logged-in official Developer Tools CLI; no cloud keys.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const {
  archive,
  openArchive,
  restorePlan,
  missingRestoreRows,
} = require("./backup.cjs");
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const save = (p, data) =>
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
function main() {
  const [mode, input, arg, output] = process.argv.slice(2);
  if (mode === "verify") {
    const data = openArchive(read(input));
    console.log(
      JSON.stringify({
        collections: Object.keys(data.snapshot).length,
        documents: Object.values(data.snapshot).reduce(
          (n, rows) => n + Object.keys(rows).length,
          0,
        ),
        files: Object.keys(data.files).length,
        checksums: "verified",
      }),
    );
    return;
  }
  if (mode === "plan") {
    const plan = restorePlan(read(input), read(arg));
    save(output, { ...plan, sha256: hash(JSON.stringify(plan)) });
    console.log("Created isolated restore plan; no cloud writes performed.");
    return;
  }
  if (!["capture", "apply"].includes(mode))
    throw Error(
      "Usage: cloud-backup.cjs capture NEW-directory | verify archive | plan archive file-map NEW-plan | apply plan isolated-collection NEW-state",
    );
  const config = read(path.resolve("config/local.json"));
  if (config.mode !== "cloud" || !config.appid || !config.cloudEnv)
    throw Error("Explicit cloud configuration required");
  const binary = process.env.WECHATIDE_BIN || "wechatide";
  let counter = 0;
  const receiptDir =
    mode === "capture"
      ? path.resolve(input)
      : path.resolve(output + ".receipts");
  if (mode === "capture") fs.mkdirSync(receiptDir, { mode: 0o700 });
  else if (!fs.existsSync(receiptDir))
    fs.mkdirSync(receiptDir, { mode: 0o700 });
  function cli(tool, args, identity = true) {
    const argv = ["-c", "Codex", tool];
    if (identity) argv.push("--appid", config.appid, "--env", config.cloudEnv);
    for (const [key, value] of Object.entries(args)) {
      argv.push("--" + key);
      if (value !== true)
        argv.push(
          typeof value === "object" ? JSON.stringify(value) : String(value),
        );
    }
    const text = execFileSync(binary, argv, {
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const value = JSON.parse(text.slice(text.indexOf("{")));
    const receipt = path.join(
      receiptDir,
      Date.now() + "-" + counter++ + ".json",
    );
    save(receipt, value);
    if (!value.ok || value.result?.success === false)
      throw Error("Official cloud tool failed; inspect private receipt");
    return value.result;
  }
  function rows(collection) {
    let result = [],
      offset = 0;
    for (;;) {
      const page = cli("cloud_db_read_doc", {
        "collection-name": collection,
        query: {},
        limit: 100,
        offset,
      });
      if (!Array.isArray(page.data))
        throw Error("Invalid database read receipt");
      result.push(...page.data);
      if (page.data.length < 100) return result;
      offset += 100;
    }
  }
  if (mode === "capture") {
    const inventory = () => {
      let result = [],
        offset = 0;
      for (;;) {
        const page = cli("cloud_db_read_struct", {
          action: "listCollections",
          limit: 100,
          offset,
        });
        result.push(...page.collections.map((c) => c.TableName));
        if (page.collections.length < 100)
          return result
            .filter((c) => !/^squiddy_(drill|restore)_/.test(c))
            .sort();
        offset += 100;
      }
    };
    const names = inventory();
    const snapshot = Object.fromEntries(
      names.map((name) => [
        name,
        Object.fromEntries(rows(name).map((row) => [row._id, row])),
      ]),
    );
    // Two matching passes detect common concurrent edits. This is an observed
    // stable logical export, not a provider-wide point-in-time backup.
    const canonical = (value) =>
      value && typeof value === "object"
        ? Array.isArray(value)
          ? value.map(canonical)
          : Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((k) => [k, canonical(value[k])]),
            )
        : value;
    for (const name of names) {
      const next = Object.fromEntries(rows(name).map((row) => [row._id, row]));
      if (
        JSON.stringify(canonical(next)) !==
        JSON.stringify(canonical(snapshot[name]))
      )
        throw Error(
          "Source changed during capture; archive was not created. Retry into a new directory.",
        );
    }
    if (JSON.stringify(inventory()) !== JSON.stringify(names))
      throw Error("Collection inventory changed during capture");
    const ids = require("./backup.cjs").fileReferences(snapshot);
    const files = Object.create(null);
    const imageDir = path.join(receiptDir, "files");
    fs.mkdirSync(imageDir, { mode: 0o700 });
    for (const id of ids) {
      const match = /^cloud:\/\/[^/]+\/(.+)$/.exec(id);
      if (!match || match[1].split("/").some((p) => p === ".." || p === "."))
        throw Error("Invalid cloud file reference");
      const local = path.join(imageDir, hash(id) + ".jpg");
      cli("cloud_manage_storage", {
        action: "download",
        "cloud-path": match[1],
        "local-path": local,
      });
      fs.chmodSync(local, 0o600);
      files[id] = fs.readFileSync(local);
    }
    save(
      path.join(receiptDir, "archive-private.json"),
      archive(snapshot, files),
    );
    console.log("Private archive captured and file checksums verified.");
    return;
  }
  const target = arg;
  if (!/^squiddy_(drill|restore)_[0-9]{8}(?:_[a-z0-9]+)?$/.test(target))
    throw Error("Only explicitly isolated restore collections are allowed");
  const envelope = read(input),
    { sha256, ...plan } = envelope;
  if (hash(JSON.stringify(plan)) !== sha256 || !Array.isArray(plan.rows))
    throw Error("Restore plan checksum invalid");
  let unknownWrite = false;
  if (fs.existsSync(output)) {
    const previous = read(output);
    if (previous.plan_sha256 !== sha256 || previous.target !== target)
      throw Error("Restore state belongs to a different plan or target");
    if (previous.status === "pending") {
      const poll = cli(
        "polling_task_result",
        { "task-id": previous.task_id },
        false,
      );
      if (poll.status !== "success") {
        console.log(
          JSON.stringify({ status: poll.status, task_id: previous.task_id }),
        );
        return;
      }
    }
    unknownWrite = previous.status === "submitting";
  }
  const missing = missingRestoreRows(plan, rows(target));
  if (!missing.length) {
    fs.writeFileSync(
      output,
      JSON.stringify(
        {
          target,
          plan_sha256: sha256,
          status: "verified",
          documents: plan.rows.length,
          verified_at: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    console.log(
      "Cloud restore readback matches the complete plan; no writes needed.",
    );
    return;
  }
  if (unknownWrite)
    throw Error(
      "Earlier write result is unknown and current records are incomplete. Inspect its private receipt; no write was replayed.",
    );
  fs.writeFileSync(
    output,
    JSON.stringify({ target, plan_sha256: sha256, status: "submitting" }) +
      "\n",
    { mode: 0o600 },
  );
  const result = cli("cloud_db_write_doc", {
    action: "insert",
    "collection-name": target,
    documents: missing,
  });
  const state = {
    target,
    plan_sha256: sha256,
    status: result.status || "submitted",
    task_id: result.taskId,
    documents: missing.length,
  };
  // State is private, deliberately replaceable only after checking its plan/target.
  fs.writeFileSync(output, JSON.stringify(state, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify(state));
  if (result.status === "pending")
    console.log(
      "Confirm the cloud write in Developer Tools, then explicitly run this command again to poll and read back. Do not repeat the write manually.",
    );
}
if (require.main === module) main();
module.exports = { main };
