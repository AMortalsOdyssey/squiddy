"use strict";
// Standard uncompressed ZIP parts. JPEGs are already compressed. Deliberately
// accept only this format: no arbitrary zip extraction or executable contents.
const { sha256, sha256Bytes } = require("./hash");
const MAX_PART = 12 * 1024 * 1024;
const crcTable = Array.from({ length: 256 }, (_, i) => {
  let n = i;
  for (let k = 0; k < 8; k++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  return n >>> 0;
});
function utf8(s) {
  const value = encodeURIComponent(s),
    bytes = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "%") {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(value.charCodeAt(i));
  }
  return new Uint8Array(bytes);
}
function decode(bytes) {
  let s = "";
  for (const byte of bytes) s += "%" + byte.toString(16).padStart(2, "0");
  return decodeURIComponent(s);
}
function crc32(bytes) {
  let n = 0xffffffff;
  for (const b of bytes) n = (n >>> 8) ^ crcTable[(n ^ b) & 255];
  return (n ^ 0xffffffff) >>> 0;
}
function join(arrays) {
  const size = arrays.reduce((n, a) => n + a.length, 0);
  if (size > MAX_PART) throw Error("备份单个文件过大，请分批导出");
  const out = new Uint8Array(size);
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}
function header(size) {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}
function zip(entries) {
  const local = [],
    central = [];
  let offset = 0;
  for (const [name, bytes] of Object.entries(entries)) {
    const n = utf8(name),
      crc = crc32(bytes),
      h = header(30),
      c = header(46);
    h.view.setUint32(0, 0x04034b50, true);
    h.view.setUint16(4, 20, true);
    h.view.setUint16(12, 33, true);
    h.view.setUint32(14, crc, true);
    h.view.setUint32(18, bytes.length, true);
    h.view.setUint32(22, bytes.length, true);
    h.view.setUint16(26, n.length, true);
    c.view.setUint32(0, 0x02014b50, true);
    c.view.setUint16(4, 20, true);
    c.view.setUint16(6, 20, true);
    c.view.setUint16(14, 33, true);
    c.view.setUint32(16, crc, true);
    c.view.setUint32(20, bytes.length, true);
    c.view.setUint32(24, bytes.length, true);
    c.view.setUint16(28, n.length, true);
    c.view.setUint32(42, offset, true);
    local.push(h.bytes, n, bytes);
    central.push(c.bytes, n);
    offset += 30 + n.length + bytes.length;
  }
  const directory = join(central),
    end = header(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, Object.keys(entries).length, true);
  end.view.setUint16(10, Object.keys(entries).length, true);
  end.view.setUint32(12, directory.length, true);
  end.view.setUint32(16, offset, true);
  return join([...local, directory, end.bytes]);
}
function unzip(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length > MAX_PART ||
    bytes.length < 22
  )
    throw Error("不是有效的Squiddy备份文件");
  const out = Object.create(null),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  while (p + 30 <= bytes.length && view.getUint32(p, true) === 0x04034b50) {
    if (view.getUint16(p + 6, true) !== 0 || view.getUint16(p + 8, true) !== 0)
      throw Error("请选择Squiddy生成的未加密备份文件");
    const size = view.getUint32(p + 18, true),
      plain = view.getUint32(p + 22, true),
      n = view.getUint16(p + 26, true),
      extra = view.getUint16(p + 28, true);
    const start = p + 30 + n + extra,
      end = start + size;
    if (size !== plain || end > bytes.length) throw Error("备份文件已损坏");
    const name = decode(bytes.subarray(p + 30, p + 30 + n));
    if (
      !/^(data\.json|images\/[a-zA-Z0-9_-]{1,128}\.jpg)$/.test(name) ||
      out[name]
    )
      throw Error("备份含有重复或未知文件");
    const content = bytes.subarray(start, end);
    if (crc32(content) !== view.getUint32(p + 14, true))
      throw Error("备份文件校验失败");
    out[name] = content;
    p = end;
    if (Object.keys(out).length > 500) throw Error("备份附件过多");
  }
  const footer = bytes.length - 22;
  if (
    view.getUint32(footer, true) !== 0x06054b50 ||
    view.getUint32(footer + 16, true) !== p ||
    view.getUint32(footer + 12, true) !== footer - p ||
    view.getUint16(footer + 10, true) !== Object.keys(out).length
  )
    throw Error("备份目录已损坏");
  if (!out["data.json"] || out["data.json"].length > 2 * 1024 * 1024)
    throw Error("备份清单无效");
  return out;
}
function makePart(payload, images = {}) {
  const descriptors = Object.entries(images).map(([id, bytes]) => {
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/.test(id) ||
      !(bytes instanceof Uint8Array) ||
      !bytes.length ||
      bytes.length > 512 * 1024
    )
      throw Error("备份图片无效");
    return { id, size: bytes.length, sha256: sha256Bytes(bytes) };
  });
  const data = JSON.stringify({ ...payload, images: descriptors }),
    envelope = { format: "squiddy-user-backup-v1", sha256: sha256(data), data };
  return zip({
    "data.json": utf8(JSON.stringify(envelope)),
    ...Object.fromEntries(
      Object.entries(images).map(([id, b]) => ["images/" + id + ".jpg", b]),
    ),
  });
}
function openPart(bytes) {
  const entries = unzip(bytes),
    envelope = JSON.parse(decode(entries["data.json"]));
  if (
    envelope.format !== "squiddy-user-backup-v1" ||
    typeof envelope.data !== "string" ||
    sha256(envelope.data) !== envelope.sha256
  )
    throw Error("备份清单校验失败");
  const data = JSON.parse(envelope.data);
  if (
    !/^[a-zA-Z0-9]{16,32}$/.test(data.group) ||
    !data.kitchen ||
    typeof data.kitchen.name !== "string" ||
    !Array.isArray(data.records) ||
    data.records.length > 50 ||
    !Array.isArray(data.images) ||
    !Number.isInteger(data.counts?.dishes) ||
    data.counts.dishes < 0 ||
    data.counts.dishes > 80
  )
    throw Error("备份内容格式不正确");
  const images = Object.create(null);
  for (const f of data.images) {
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/.test(f?.id) ||
      ["__proto__", "constructor", "prototype"].includes(f.id)
    )
      throw Error("备份图片标识无效");
    const content = entries["images/" + f.id + ".jpg"];
    if (
      images[f.id] ||
      !content ||
      content.length !== f.size ||
      content.length > 512 * 1024 ||
      sha256Bytes(content) !== f.sha256
    )
      throw Error("备份图片校验失败");
    images[f.id] = content;
  }
  if (Object.keys(entries).length !== data.images.length + 1)
    throw Error("备份包含未登记的文件");
  for (const r of data.records)
    if (
      !["dish", "meal"].includes(r?.kind) ||
      !r.data ||
      typeof r.data !== "object" ||
      (r.kind === "dish" &&
        (!/^[a-zA-Z0-9_-]{1,128}$/.test(r.data.id) ||
          ["__proto__", "constructor", "prototype"].includes(r.data.id)))
    )
      throw Error("备份记录格式不正确");
  for (const imageId of imageIds(data.records))
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/.test(imageId) ||
      ["__proto__", "constructor", "prototype"].includes(imageId)
    )
      throw Error("备份图片引用无效");
  return { data, images, checksum: envelope.sha256 };
}
function imageIds(value) {
  const result = new Set();
  function walk(v) {
    if (v && typeof v === "object")
      for (const [k, item] of Object.entries(v)) {
        if (k === "image_id" && typeof item === "string" && item)
          result.add(item);
        else if (item && typeof item === "object") walk(item);
      }
  }
  walk(value);
  return [...result];
}
module.exports = { makePart, openPart, imageIds, crc32, utf8, MAX_PART };
