"use strict";
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
let runtime;
exports.main = async (event) => {
  runtime ||= require("./shared/runtime").makeRuntime({ cloud });
  return runtime.handle("api", event, cloud.getWXContext());
};
