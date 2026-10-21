import { mode, cloudEnv } from "./config/runtime";
import { clearMediaFiles } from "./services/api";
App({
  onLaunch() {
    clearMediaFiles();
    if (mode === "cloud") {
      if (!cloudEnv || !wx.cloud)
        throw new Error("云环境尚未配置或基础库不支持");
      wx.cloud.init({ env: cloudEnv, traceUser: false });
    }
    console.info("app.launch", { mode });
  },
});
