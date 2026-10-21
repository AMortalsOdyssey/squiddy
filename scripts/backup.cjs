"use strict";
// An operator-only, offline snapshot format. Never deployed as a client API.
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createMemoryStore } = require("../domain/store");
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
function validateSnapshot(data) {
  if (!data || Array.isArray(data) || typeof data !== "object")
    throw Error("Invalid database snapshot");
  for (const [name, table] of Object.entries(data)) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name) ||
      ["constructor", "prototype"].includes(name) ||
      !table ||
      Array.isArray(table) ||
      typeof table !== "object"
    )
      throw Error("Invalid collection");
    for (const [key, row] of Object.entries(table))
      if (
        !key ||
        ["__proto__", "constructor", "prototype"].includes(key) ||
        !row ||
        Array.isArray(row) ||
        typeof row !== "object" ||
        (row._id !== undefined && row._id !== key)
      )
        throw Error("Invalid document");
  }
  return data;
}
function backup(snapshot) {
  validateSnapshot(snapshot);
  const data = JSON.stringify(snapshot);
  return {
    format: "squiddy-backup-v1",
    created_at: new Date().toISOString(),
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
    data,
  };
}
function restore(envelope) {
  if (
    envelope?.format !== "squiddy-backup-v1" ||
    typeof envelope.data !== "string" ||
    crypto.createHash("sha256").update(envelope.data).digest("hex") !==
      envelope.sha256
  )
    throw Error("Backup checksum or format invalid");
  return createMemoryStore(validateSnapshot(JSON.parse(envelope.data)));
}
function fileReferences(snapshot) {
  const result = new Set();
  function visit(value) {
    if (typeof value === "string" && value.startsWith("cloud://"))
      result.add(value);
    else if (value && typeof value === "object")
      Object.values(value).forEach(visit);
  }
  visit(snapshot);
  return [...result].sort();
}
// Portable private archive: database plus actual file bytes. Never upload this
// archive to a public repository or deploy it with the application.
function archive(snapshot, files) {
  validateSnapshot(snapshot);
  const entries = fileReferences(snapshot).map((fileId) => {
    const bytes = files[fileId];
    if (
      !Buffer.isBuffer(bytes) ||
      !bytes.length ||
      bytes.length > 2 * 1024 * 1024
    )
      throw Error("Missing or oversized backup file");
    return {
      file_id: fileId,
      sha256: digest(bytes),
      size: bytes.length,
      base64: bytes.toString("base64"),
    };
  });
  const data = JSON.stringify({ snapshot, files: entries });
  return {
    format: "squiddy-backup-v2",
    created_at: new Date().toISOString(),
    sha256: digest(data),
    data,
  };
}
function openArchive(envelope) {
  if (
    envelope?.format !== "squiddy-backup-v2" ||
    typeof envelope.data !== "string" ||
    digest(envelope.data) !== envelope.sha256
  )
    throw Error("Backup checksum or format invalid");
  const value = JSON.parse(envelope.data);
  validateSnapshot(value.snapshot);
  if (!Array.isArray(value.files)) throw Error("Invalid file manifest");
  const files = Object.create(null);
  for (const entry of value.files) {
    if (
      !entry ||
      typeof entry.file_id !== "string" ||
      !entry.file_id.startsWith("cloud://") ||
      files[entry.file_id] ||
      typeof entry.base64 !== "string" ||
      entry.base64.length > 2800000
    )
      throw Error("Invalid backup file");
    const bytes = Buffer.from(entry.base64, "base64");
    if (
      !bytes.length ||
      bytes.length !== entry.size ||
      bytes.toString("base64") !== entry.base64 ||
      digest(bytes) !== entry.sha256
    )
      throw Error("Backup file checksum invalid");
    files[entry.file_id] = bytes;
  }
  const references = fileReferences(value.snapshot);
  if (
    references.length !== Object.keys(files).length ||
    references.some((id) => !files[id])
  )
    throw Error("Backup file references incomplete");
  return { snapshot: value.snapshot, files };
}
function restorePlan(envelope, fileMap) {
  const { snapshot, files } = openArchive(envelope);
  const targets = new Set();
  for (const id of Object.keys(files)) {
    const target = fileMap[id];
    if (
      typeof target !== "string" ||
      !/^cloud:\/\/[^/]+\/squiddy-restore\/[a-zA-Z0-9_-]+\/[a-f0-9]{64}\.jpg$/.test(
        target,
      ) ||
      targets.has(target)
    )
      throw Error("Restore files must use distinct isolated paths");
    targets.add(target);
  }
  function rewrite(value) {
    if (typeof value === "string" && files[value]) return fileMap[value];
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, rewrite(item)]),
      );
    return value;
  }
  const restored = rewrite(snapshot);
  const rows = Object.entries(restored).flatMap(([table, data]) =>
    Object.entries(data).map(([key, value]) => ({
      _id: digest(table + "\0" + key),
      table,
      key,
      value,
    })),
  );
  return { snapshot: restored, rows };
}
function missingRestoreRows(plan, existing) {
  const wanted = new Map(plan.rows.map((row) => [row._id, row]));
  const canonical = (value) =>
    value && typeof value === "object"
      ? Array.isArray(value)
        ? value.map(canonical)
        : Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
      : value;
  for (const row of existing) {
    const expected = wanted.get(row._id);
    if (
      !expected ||
      JSON.stringify(canonical(row)) !== JSON.stringify(canonical(expected))
    )
      throw Error(
        "Restore target conflict; existing data will not be overwritten",
      );
    wanted.delete(row._id);
  }
  return [...wanted.values()];
}
if (require.main === module) {
  const [mode, input, output] = process.argv.slice(2);
  if (!["backup", "restore"].includes(mode) || !input || !output)
    throw Error(
      "Usage: node scripts/backup.cjs backup|restore input.json NEW-output.json",
    );
  const source = JSON.parse(fs.readFileSync(input, "utf8"));
  const result =
    mode === "backup" ? backup(source) : restore(source).snapshot();
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    "Created isolated " +
      mode +
      " output. Existing files were not overwritten.",
  );
}
module.exports = {
  backup,
  restore,
  archive,
  openArchive,
  restorePlan,
  missingRestoreRows,
  fileReferences,
};
