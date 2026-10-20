"use strict";
class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}
function ensure(test, code, message) {
  if (!test) throw new AppError(code, message);
}
const input = (test, message = "请检查填写内容") =>
  ensure(test, "INVALID_INPUT", message);
function text(value, max, label, optional = false) {
  input(typeof value === "string", `${label}格式不正确`);
  const valueTrimmed = value.trim();
  input(
    (optional || valueTrimmed.length > 0) && valueTrimmed.length <= max,
    `${label}请填写${max}字以内`,
  );
  return valueTrimmed;
}
function integer(value, min, max, label) {
  input(
    Number.isSafeInteger(value) && value >= min && value <= max,
    `${label}须为${min}至${max}的整数`,
  );
  return value;
}
function id(value) {
  input(
    typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value),
    "编号无效",
  );
  return value;
}
function revision(value, current) {
  input(Number.isSafeInteger(value) && value >= 0, "缺少有效版本号");
  ensure(value === current, "CONFLICT", "内容已被更新，请刷新后再试");
}
function keys(value, allowed) {
  input(value && typeof value === "object" && !Array.isArray(value));
  input(
    Object.keys(value).every((key) => allowed.includes(key)),
    "请求中包含不允许的字段",
  );
}
module.exports = { AppError, ensure, input, text, integer, id, revision, keys };
