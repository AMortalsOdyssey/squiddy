"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
function configuration() {
  const c = JSON.parse(
    fs.readFileSync(path.resolve("config/local.json"), "utf8"),
  );
  if (c.mode !== "cloud" || !c.appid || !c.cloudEnv)
    throw Error("Explicit existing cloud configuration required");
  return c;
}
function privateSave(file, value, exclusive = true) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", {
    flag: exclusive ? "wx" : "w",
    mode: 0o600,
  });
}
function official(tool, args, receipt) {
  const c = configuration(),
    argv = ["-c", "Codex", tool];
  if (tool !== "polling_task_result")
    argv.push("--appid", c.appid, "--env", c.cloudEnv);
  for (const [k, v] of Object.entries(args)) {
    argv.push("--" + k);
    if (v !== true)
      argv.push(typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  const out = execFileSync(process.env.WECHATIDE_BIN || "wechatide", argv, {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const result = JSON.parse(out.slice(out.indexOf("{")));
  privateSave(receipt, result);
  if (!result.ok || result.result?.success === false)
    throw Error("Official tool failed; inspect private receipt");
  return result.result;
}
module.exports = { configuration, privateSave, official, hash };
