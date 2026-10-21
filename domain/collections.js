"use strict";
// Keep reads bounded and let the CloudBase adapter fetch one batch per table.
async function getMany(tx, table, ids) {
  const unique = [...new Set(ids || [])];
  const result = new Map();
  for (let i = 0; i < unique.length; i += 80) {
    const group = unique.slice(i, i + 80);
    const rows = tx.getMany
      ? await tx.getMany(table, group)
      : await Promise.all(
          group.map(async (id) => ({ id, data: await tx.get(table, id) })),
        );
    for (const { id, data } of rows) if (data) result.set(id, data);
  }
  return result;
}
module.exports = { getMany };
