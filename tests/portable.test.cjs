const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { makePart, openPart, imageIds, crc32 } = require("../shared/portable");
const { sha256Bytes } = require("../shared/hash");
function payload() {
  return {
    group: "a".repeat(24),
    kitchen: { name: "厨房与中文🍚" },
    counts: { dishes: 1 },
    part: 1,
    records: [
      {
        kind: "dish",
        data: {
          id: "dish1",
          name: "家常菜",
          image_id: "photo1",
          recipe_steps: [{ text: "步骤", image_id: "photo1" }],
        },
      },
    ],
  };
}
test("标准ZIP备份携带真实图片字节、UTF8菜谱与SHA256，可恢复校验", () => {
  const image = crypto.randomBytes(2000),
    bytes = makePart(payload(), { photo1: new Uint8Array(image) });
  const restored = openPart(bytes);
  assert.equal(restored.data.kitchen.name, "厨房与中文🍚");
  assert.deepEqual(Buffer.from(restored.images.photo1), image);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.deepEqual(imageIds(restored.data.records), ["photo1"]);
  assert.equal(
    sha256Bytes(image),
    crypto.createHash("sha256").update(image).digest("hex"),
  );
});
test("备份损坏、截断、加密ZIP、未知格式均拒绝，不盲目解压文件", () => {
  const original = makePart(payload(), { photo1: new Uint8Array([1, 2, 3]) });
  for (const alter of [
    (b) => {
      b[35] ^= 1;
    },
    (b) => {
      b[6] = 1;
    },
    (b) => {
      b[b.length - 22] = 0;
    },
  ]) {
    const b = original.slice();
    alter(b);
    assert.throws(() => openPart(b));
  }
  assert.throws(() => openPart(original.slice(0, original.length - 1)));
  assert.throws(() => openPart(new Uint8Array(12 * 1024 * 1024 + 1)));
});
test("多个分卷共享批次，完整保留权限投影，附件大小与非法源键受限", () => {
  const data = payload();
  delete data.records[0].data.image_id;
  data.records[0].data.recipe_steps = [];
  const first = openPart(makePart(data));
  const second = openPart(makePart({ ...data, part: 2 }));
  assert.equal(first.data.group, second.data.group);
  assert.equal(second.data.part, 2);
  assert.throws(() =>
    makePart(data, { photo1: new Uint8Array(512 * 1024 + 1) }),
  );
  assert.throws(() =>
    openPart(
      makePart({
        ...data,
        records: [{ kind: "dish", data: { id: "constructor" } }],
      }),
    ),
  );
});
