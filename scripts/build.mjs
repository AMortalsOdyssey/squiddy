import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
const output = fs.mkdtempSync(path.join(os.tmpdir(), "squiddy-output-"));
try {
  execFileSync(
    process.execPath,
    ["node_modules/typescript/bin/tsc", "--outDir", output],
    {
      // Publish only after TypeScript succeeds. Keep the watched app root and
      // existing app.json in place while the Developer Tools project is open.
      // Removing the root makes its file index lose the application altogether.
      stdio: "inherit",
    },
  );
  function copy(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) copy(p);
      else if (!p.endsWith(".ts")) {
        const dest = path.join(output, path.relative("src", p));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(p, dest);
      }
    }
  }
  copy("src");
  fs.cpSync("shared", path.join(output, "shared"), { recursive: true });
  fs.mkdirSync(path.join(output, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(output, "config/runtime.js"),
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
  const projectOutput = JSON.stringify(project, null, 2) + "\n";
  if (
    !fs.existsSync(projectPath) ||
    fs.readFileSync(projectPath, "utf8") !== projectOutput
  )
    fs.writeFileSync(projectPath, projectOutput);
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
    fs.cpSync("domain", path.join(output, "domain"), { recursive: true });
  else {
    fs.rmSync(path.join(output, "services/local.js"), { force: true });
  }
  function publish(from, to) {
    fs.mkdirSync(to, { recursive: true });
    const names = new Set(fs.readdirSync(from));
    // Register new page files before publishing app.json to the watching IDE.
    for (const name of [...names].sort((a, b) =>
      a === "app.json" ? 1 : b === "app.json" ? -1 : 0,
    )) {
      const source = path.join(from, name),
        target = path.join(to, name);
      if (fs.statSync(source).isDirectory()) publish(source, target);
      else if (
        !fs.existsSync(target) ||
        !fs.readFileSync(target).equals(fs.readFileSync(source))
      )
        if (name === "app.json") {
          const temporary = target + ".squiddy-tmp";
          fs.copyFileSync(source, temporary);
          fs.renameSync(temporary, target);
        } else fs.copyFileSync(source, target);
    }
    for (const name of fs.readdirSync(to))
      if (!names.has(name))
        fs.rmSync(path.join(to, name), { recursive: true, force: true });
  }
  publish(output, "miniprogram");
} finally {
  fs.rmSync(output, { recursive: true, force: true });
}
for (const name of ["api", "publicRead", "platformCallback", "maintenance"]) {
  const dir = "cloudfunctions/" + name;
  if (fs.existsSync(dir)) {
    fs.cpSync("domain", dir + "/domain", { recursive: true });
    fs.cpSync("cloud/shared", dir + "/shared", { recursive: true });
    fs.cpSync("shared", dir + "/shared", { recursive: true });
  }
}
console.log(
  "Built native mini program. Mode: " +
    local.mode +
    ". Not a WeChat compile or cloud deployment.",
);
