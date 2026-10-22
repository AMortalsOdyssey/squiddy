"use strict";
// wx-server-sdk uses {data} for writes, and object data for document reads.
function cloudStore(db) {
  const adapter = (transaction) => ({
    async get(table, id) {
      try {
        const result = await transaction.collection(table).doc(id).get();
        return Array.isArray(result.data) ? result.data[0] : result.data;
      } catch (e) {
        const message = e.errMsg || "";
        if (
          (e.errCode === -502001 &&
            /document.*not.*exist|document.*not.*found/i.test(message)) ||
          (e.errCode === -1 &&
            /^document\.get:fail document with _id .+ does not exist$/.test(
              message,
            ))
        )
          return undefined;
        throw e;
      }
    },
    async put(table, id, value) {
      const data = JSON.parse(JSON.stringify(value));
      delete data._id;
      await transaction.collection(table).doc(id).set({ data });
    },
    async remove(table, id) {
      await transaction.collection(table).doc(id).remove();
    },
    async removeMany(table, ids) {
      // The bundled SDK's Query.remove omits transactionId. Only document
      // removals participate in rollback with the cleanup cursor write.
      // CloudBase rejects parallel operations in one transaction (TransactionBusy).
      for (const id of ids)
        await transaction.collection(table).doc(id).remove();
    },
    async getMany(table, ids) {
      if (!ids.length) return [];
      const result = await transaction
        .collection(table)
        .where({ _id: db.command.in(ids) })
        .limit(ids.length)
        .get();
      return result.data.map((data) => ({ id: data._id, data }));
    },
    async scan(table, limit = 20, cursor = "", whereAny) {
      let query = transaction.collection(table);
      const conditions = [];
      if (whereAny) {
        const branches = whereAny
          .filter((x) => x.values.length)
          .map(({ field, values }) => ({
            [field]: db.command.in(values),
          }));
        if (!branches.length) return [];
        conditions.push(
          branches.length === 1 ? branches[0] : db.command.or(branches),
        );
      }
      if (cursor) conditions.push({ _id: db.command.gt(cursor) });
      if (conditions.length)
        query = query.where(
          conditions.length === 1 ? conditions[0] : db.command.and(conditions),
        );
      const result = await query.orderBy("_id", "asc").limit(limit).get();
      return result.data.map((data) => ({ id: data._id, data }));
    },
  });
  return {
    transaction: (fn) =>
      db.runTransaction((transaction) => fn(adapter(transaction))),
    read: (fn) => {
      const { get, getMany, scan } = adapter(db);
      return fn({ get, getMany, scan });
    },
  };
}
module.exports = { cloudStore };
