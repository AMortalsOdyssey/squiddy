"use strict";
// wx-server-sdk uses {data} for writes, and object data for document reads.
function cloudStore(db) {
  return {
    transaction: (fn) =>
      db.runTransaction(async (transaction) =>
        fn({
          async get(table, id) {
            try {
              const result = await transaction.collection(table).doc(id).get();
              return Array.isArray(result.data) ? result.data[0] : result.data;
            } catch (e) {
              if (
                e.errCode === -502001 &&
                /document.*not.*exist|document.*not.*found/i.test(
                  e.errMsg || "",
                )
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
          async scan(table, limit = 20, cursor = "") {
            let query = transaction.collection(table);
            if (cursor) query = query.where({ _id: db.command.gt(cursor) });
            const result = await query.orderBy("_id", "asc").limit(limit).get();
            return result.data.map((data) => ({ id: data._id, data }));
          },
        }),
      ),
  };
}
module.exports = { cloudStore };
