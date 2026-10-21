"use strict";
// Read-only cloud capture plus private local backup. Scheduling is explicitly
// external; this command never creates a system job or changes cloud settings.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { seal, unseal } = require("./backup-vault.cjs");
const { openArchive } = require("./backup.cjs");
function main() {
  const [mode = "status", rootArg = "artifacts/operator-backups"] =
      process.argv.slice(2),
    root = path.resolve(rootArg);
  if (!["status", "run", "due"].includes(mode))
    throw Error("Usage: backup-run.cjs status|run|due [PRIVATE-directory]");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const statusFile = path.join(root, "last-run.json"),
    readStatus = () =>
      fs.existsSync(statusFile)
        ? JSON.parse(fs.readFileSync(statusFile, "utf8"))
        : null;
  if (mode === "status") {
    const s = readStatus();
    console.log(JSON.stringify(s || { status: "never_run" }));
    return;
  }
  const day = new Date().toISOString().slice(0, 10),
    previous = readStatus();
  if (
    mode === "due" &&
    previous?.status === "success" &&
    previous.day === day
  ) {
    const data = JSON.parse(
      fs.readFileSync(
        path.join(root, previous.directory, "archive-private.json"),
        "utf8",
      ),
    );
    openArchive(data);
    console.log("Today already has a verified private backup.");
    return;
  }
  const lock = path.join(root, ".running");
  if (fs.existsSync(lock)) {
    const old = Number(fs.readFileSync(lock, "utf8"));
    let alive = true;
    try {
      process.kill(old, 0);
    } catch (e) {
      if (e.code === "ESRCH") alive = false;
      else throw e;
    }
    if (alive)
      throw Error(
        "Another backup is running; no duplicate capture was started",
      );
    fs.unlinkSync(lock);
  }
  const fd = fs.openSync(lock, "wx", 0o600);
  fs.writeSync(fd, String(process.pid));
  let directory;
  try {
    directory =
      "backup-" +
      new Date().toISOString().replace(/[:.]/g, "-") +
      "-" +
      crypto.randomBytes(3).toString("hex");
    const target = path.join(root, directory);
    execFileSync(
      process.execPath,
      [path.join(__dirname, "cloud-backup.cjs"), "capture", target],
      { stdio: "pipe", timeout: 240000 },
    );
    const archive = JSON.parse(
      fs.readFileSync(path.join(target, "archive-private.json"), "utf8"),
    );
    openArchive(archive);
    const keyPath = path.resolve("config/backup.key");
    if (!fs.existsSync(keyPath))
      fs.writeFileSync(keyPath, crypto.randomBytes(32), {
        flag: "wx",
        mode: 0o600,
      });
    if ((fs.statSync(keyPath).mode & 0o077) !== 0)
      throw Error("Recovery key must have private permissions");
    const key = fs.readFileSync(keyPath),
      encrypted = seal(archive, key);
    const replay = unseal(encrypted, key);
    if (replay.sha256 !== archive.sha256)
      throw Error("Encrypted backup verification failed");
    fs.writeFileSync(
      path.join(target, "encrypted-backup.sqb"),
      JSON.stringify(encrypted) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    const status = {
      status: "success",
      day,
      directory,
      verified_at: new Date().toISOString(),
      collections: Object.keys(openArchive(archive).snapshot).length,
      encrypted: true,
      remote_copied: false,
    };
    fs.writeFileSync(statusFile, JSON.stringify(status, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(JSON.stringify(status));
  } catch (e) {
    fs.writeFileSync(
      statusFile,
      JSON.stringify({
        status: "failed",
        day,
        directory,
        previous_success:
          previous?.status === "success"
            ? previous
            : previous?.previous_success,
        failed_at: new Date().toISOString(),
        reason:
          "Capture or checksum failed; inspect private receipts. No previous backups were removed.",
      }) + "\n",
      { mode: 0o600 },
    );
    throw Error(
      "Backup failed; previous backups preserved. Inspect the private job directory.",
    );
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
if (require.main === module) main();
module.exports = { main };
