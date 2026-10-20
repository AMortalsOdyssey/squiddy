"use strict";
// Deterministic, serializable adapter for local development and adversarial tests.
// Production uses the CloudBase transaction adapter, never this client-owned store.
function createMemoryStore(initial = {}, onCommit = () => {}) {
  let state = JSON.parse(JSON.stringify(initial)),
    tail = Promise.resolve();
  const clone = (value) =>
    value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  return {
    transaction(fn) {
      const run = tail.then(async () => {
        const working = clone(state);
        const tx = {
          async get(c, id) {
            return clone(working[c]?.[id]);
          },
          async put(c, id, data) {
            (working[c] || (working[c] = {}))[id] = clone(data);
          },
          async remove(c, id) {
            if (working[c]) delete working[c][id];
          },
          async scan(c, limit = 100, cursor = "") {
            return Object.entries(working[c] || {})
              .sort(([a], [b]) => a.localeCompare(b))
              .filter(([id]) => id > cursor)
              .slice(0, limit)
              .map(([id, data]) => ({ id, data: clone(data) }));
          },
        };
        const result = await fn(tx);
        await onCommit(working);
        state = working;
        return clone(result);
      });
      tail = run.catch(() => {});
      return run;
    },
    snapshot() {
      return clone(state);
    },
  };
}
module.exports = { createMemoryStore };
