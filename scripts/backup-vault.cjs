"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const { openArchive } = require("./backup.cjs");
function seal(archive, key) {
  openArchive(archive);
  if (!Buffer.isBuffer(key) || key.length !== 32)
    throw Error("A separate 32-byte recovery key is required");
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const bytes = Buffer.concat([
    cipher.update(JSON.stringify(archive)),
    cipher.final(),
  ]);
  return {
    format: "squiddy-encrypted-backup-v1",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: bytes.toString("base64"),
  };
}
function unseal(envelope, key) {
  if (
    envelope?.format !== "squiddy-encrypted-backup-v1" ||
    !Buffer.isBuffer(key) ||
    key.length !== 32
  )
    throw Error("Backup format or recovery key invalid");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const bytes = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64")),
    decipher.final(),
  ]);
  const archive = JSON.parse(bytes.toString("utf8"));
  openArchive(archive);
  return archive;
}
function main() {
  const [mode, input, keyPath, output] = process.argv.slice(2);
  if (!["seal", "open"].includes(mode) || !input || !keyPath || !output)
    throw Error(
      "Usage: backup-vault.cjs seal|open input PRIVATE-key NEW-output",
    );
  if ((fs.statSync(keyPath).mode & 0o077) !== 0)
    throw Error("Recovery key permissions must be private");
  const key = fs.readFileSync(keyPath),
    data = JSON.parse(fs.readFileSync(input, "utf8"));
  fs.writeFileSync(
    output,
    JSON.stringify(mode === "seal" ? seal(data, key) : unseal(data, key)) +
      "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    mode === "seal"
      ? "Encrypted backup written; store the recovery key separately."
      : "Backup decrypted and database/file checksums verified.",
  );
}
if (require.main === module) main();
module.exports = { seal, unseal };
