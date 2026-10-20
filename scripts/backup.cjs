"use strict";
// An operator-only, offline snapshot format. Never deployed as a client API.
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createMemoryStore } = require("../domain/store");
function backup(snapshot) {
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
  const data = JSON.parse(envelope.data);
  if (!data || Array.isArray(data) || typeof data !== "object")
    throw Error("Invalid database snapshot");
  for (const table of Object.values(data))
    if (!table || Array.isArray(table) || typeof table !== "object")
      throw Error("Invalid collection");
  return createMemoryStore(data);
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
module.exports = { backup, restore };
