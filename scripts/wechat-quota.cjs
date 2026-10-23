"use strict";

const fs = require("node:fs");
const { parseArgs } = require("node:util");

const endpoint = "https://api.weixin.qq.com/cgi-bin/openapi/quota/get";
const cgiPath = "/wxa/msg_sec_check";

function fail(message) {
  const error = new Error(message);
  error.safeMessage = message;
  throw error;
}

function numericLimits(value, depth = 0) {
  if (depth > 6) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => numericLimits(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (/token|secret|authorization|cookie|url/i.test(key)) continue;
      const safe = numericLimits(item, depth + 1);
      if (safe !== undefined) result[key] = safe;
    }
    return result;
  }
  return undefined;
}

function summarize(response, observedAt, source) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    fail("响应必须是JSON对象。");
  }
  if (!observedAt || !Number.isFinite(Date.parse(observedAt))) {
    fail("必须提供有效的采集时间，不能把历史响应写成今日读数。");
  }
  if (response.errcode !== undefined && response.errcode !== 0) {
    const code = Number.isSafeInteger(response.errcode)
      ? response.errcode
      : "unknown";
    fail(`微信查询失败，错误码：${code}。未输出原始错误或凭据。`);
  }
  const quota = {};
  for (const key of ["daily_limit", "used", "remain"]) {
    const value = response.quota?.[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      fail(`响应缺少有效的quota.${key}；不能按0处理。`);
    }
    quota[key] = value;
  }
  return {
    source,
    interface: cgiPath,
    observed_at_utc: new Date(observedAt).toISOString(),
    observed_at_beijing: new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Shanghai",
      dateStyle: "short",
      timeStyle: "medium",
    }).format(new Date(observedAt)),
    quota,
    rate_limit: numericLimits(response.rate_limit),
    component_rate_limit: numericLimits(
      response.component_rate_limit ?? response.componentratelimit,
    ),
    quota_arithmetic_matches: quota.used + quota.remain === quota.daily_limit,
    account_identity_verified: false,
    counting_scope_verified: false,
    reset_rule_verified: false,
  };
}

async function requestQuota(token, fetchImpl = globalThis.fetch) {
  if (typeof token !== "string" || !token.trim() || /\s/.test(token.trim())) {
    fail("需要合法服务端access_token；通过环境变量或标准输入提供。");
  }
  const url = new URL(endpoint);
  url.searchParams.set("access_token", token.trim());
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cgi_path: cgiPath }),
    });
  } catch {
    fail("配额查询网络失败或超时；未自动重试，未输出请求地址或凭据。");
  }
  if (!response.ok) fail(`配额查询HTTP失败：${response.status}。`);
  const text = await response.text();
  if (text.length > 128 * 1024) fail("响应超出合理大小，停止解析。");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    fail("配额查询没有返回有效JSON；未输出原始响应。");
  }
  return summarize(data, new Date().toISOString(), "wechat_getApiQuota");
}

async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: "boolean" },
      query: { type: "boolean" },
      response: { type: "string" },
      "observed-at": { type: "string" },
      "token-stdin": { type: "boolean" },
      help: { type: "boolean" },
    },
    allowPositionals: false,
  });
  if (values.help || !Object.keys(values).length) {
    console.log(
      "用法：\n" +
        "  --plan                           离线查看固定只读请求\n" +
        "  --response FILE --observed-at ISO 离线解析已取得的响应\n" +
        "  --query [--token-stdin]           在允许访问的环境查询一次\n" +
        "在线查询默认从WECHAT_ACCESS_TOKEN读取凭据，不接受命令行token。\n" +
        "不会获取token、调用审核、重置额度或推断计数范围与重置规则。",
    );
    return;
  }
  if (
    [values.plan, values.query, !!values.response].filter(Boolean).length !== 1
  ) {
    fail("必须且只能选择--plan、--query或--response。");
  }
  let result;
  if (values.plan) {
    result = {
      mode: "offline-plan",
      method: "POST",
      endpoint,
      body: { cgi_path: cgiPath },
      cloud_call_supported: false,
      network_request_sent: false,
    };
  } else if (values.response) {
    const text = fs.readFileSync(values.response, "utf8");
    if (text.length > 128 * 1024) fail("输入文件过大。");
    result = summarize(
      JSON.parse(text),
      values["observed-at"],
      "imported-response",
    );
  } else {
    const token = values["token-stdin"]
      ? fs.readFileSync(0, "utf8").trim()
      : process.env.WECHAT_ACCESS_TOKEN;
    result = await requestQuota(token);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      error.safeMessage || "参数或输入解析失败；未输出原始数据和凭据。",
    );
    process.exitCode = 1;
  });
}

module.exports = { summarize, requestQuota };
