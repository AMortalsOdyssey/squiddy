import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const local = fs.existsSync("config/local.json")
  ? JSON.parse(fs.readFileSync("config/local.json", "utf8"))
  : { mode: "demo", appid: "", cloudEnv: "" };
if (!["demo", "cloud"].includes(local.mode)) throw Error("Invalid mode");
if (
  local.mode === "cloud" &&
  (!/^wx[a-zA-Z0-9]{16}$/.test(local.appid) || !local.cloudEnv)
)
  throw Error(
    "Cloud mode requires real AppID and cloudEnv; never silently falls back to demo",
  );
fs.rmSync("miniprogram", { recursive: true, force: true });
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc"], {
  stdio: "inherit",
});
function copy(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) copy(p);
    else if (!p.endsWith(".ts")) {
      const dest = p.replace(/^src/, "miniprogram");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(p, dest);
    }
  }
}
copy("src");
fs.mkdirSync("miniprogram/config", { recursive: true });
fs.writeFileSync(
  "miniprogram/config/runtime.js",
  "module.exports = " +
    JSON.stringify({ mode: local.mode, cloudEnv: local.cloudEnv }) +
    ";\n",
);
// The devtools project identity is read from project.config.json, not the
// per-developer overrides in project.private.config.json.
const projectPath = "project.config.json";
const project = JSON.parse(
  fs.readFileSync(
    fs.existsSync(projectPath) ? projectPath : "project.config.example.json",
    "utf8",
  ),
);
project.appid = local.appid || "touristappid";
project.description = "鱿鱼须须个人主体小程序";
fs.writeFileSync(projectPath, JSON.stringify(project, null, 2) + "\n");
const privatePath = "project.private.config.json";
if (fs.existsSync(privatePath)) {
  const privateConfig = JSON.parse(fs.readFileSync(privatePath, "utf8"));
  if ("appid" in privateConfig) {
    delete privateConfig.appid;
    fs.writeFileSync(
      privatePath,
      JSON.stringify(privateConfig, null, 2) + "\n",
    );
  }
}
if (local.mode === "demo")
  fs.cpSync("domain", "miniprogram/domain", { recursive: true });
else {
  fs.rmSync("miniprogram/domain", { recursive: true, force: true });
  fs.rmSync("miniprogram/services/local.js", { force: true });
}
for (const name of ["api", "publicRead", "platformCallback", "maintenance"]) {
  const dir = "cloudfunctions/" + name;
  if (fs.existsSync(dir)) {
    fs.cpSync("domain", dir + "/domain", { recursive: true });
    fs.cpSync("cloud/shared", dir + "/shared", { recursive: true });
  }
}
console.log(
  "Built native mini program. Mode: " +
    local.mode +
    ". Not a WeChat compile or cloud deployment.",
);
