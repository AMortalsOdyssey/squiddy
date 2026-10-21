import fs from "node:fs";
const config = fs.existsSync("config/local.json")
  ? JSON.parse(fs.readFileSync("config/local.json", "utf8"))
  : {};
const app = JSON.parse(fs.readFileSync("miniprogram/app.json", "utf8"));
const missing = app.pages
  .flatMap((p) =>
    ["js", "json", "wxml", "wxss"].map((ext) => `miniprogram/${p}.${ext}`),
  )
  .filter((p) => !fs.existsSync(p));
if (missing.length) throw Error("Missing page files: " + missing.join(", "));
const realAppIdConfigured = /^wx[a-zA-Z0-9]{16}$/.test(config.appid || "");
const project = JSON.parse(fs.readFileSync("project.config.json", "utf8"));
if (project.appid !== (config.appid || "touristappid"))
  throw Error(
    "Project AppID differs from local configuration; rebuild before opening devtools",
  );
console.log(
  JSON.stringify(
    {
      node: process.version,
      pages: app.pages.length,
      nativeFilesComplete: true,
      mode: config.mode || "demo",
      realAppIdConfigured,
      projectAppIdMatches: true,
      cloudConfigured: !!config.cloudEnv,
      verificationBoundary:
        "这里只检查本地文件，不能证明微信登录、云部署或真机成功",
      awaiting: [
        ...(!realAppIdConfigured ? ["个人小程序注册与真实AppID"] : []),
        "云端部署与安全规则的独立验收（doctor不检查）",
        "双机三账号验收",
      ],
    },
    null,
    2,
  ),
);
