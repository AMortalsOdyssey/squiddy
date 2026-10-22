import { mode, cloudEnv } from "./config/runtime";
import { clearMediaFilesAtLaunch } from "./services/api";
App({
  onLaunch() {
    const started = Date.now();
    clearMediaFilesAtLaunch();
    const initStarted = Date.now();
    if (mode === "cloud") {
      if (!cloudEnv || !wx.cloud)
        throw new Error("云环境尚未配置或基础库不支持");
      wx.cloud.init({ env: cloudEnv, traceUser: false });
    }
    console.info("app.launch", {
      mode,
      work_ms: Date.now() - started,
      cloud_init_ms: Date.now() - initStarted,
    });
  },
});
