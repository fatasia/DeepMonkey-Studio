import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { validateFunctionLifecycle } from "./functionLifecycle.mjs";

test("lifecycle validation rejects bare await in On Stop but permits it in message and setup", () => {
  assert.doesNotThrow(() => validateFunctionLifecycle({ id: "valid", type: "function", func: "await Promise.resolve();", initialize: "await Promise.resolve();" }));
  assert.throws(() => validateFunctionLifecycle({ id: "broken", type: "function", finalize: "await connection.close();" }), /broken \(finalize\)/);
});

test("built-in and exported cleanup clear ownership and handle async/sync close failure", async () => {
  for (const file of ["flows.json", "examples/tdengine-oracle-dashboard.json"]) {
    const nodes = JSON.parse(await readFile(new URL(file, import.meta.url), "utf8"));
    for (const node of nodes) validateFunctionLifecycle(node);
    const finalize = nodes.find(node => node.id === "example-td-request").finalize;
    const run = new Function("context", "node", finalize);
    for (const mode of ["none", "success", "rejected", "throws"]) {
      let closes = 0;
      const errors = [];
      let connection = mode === "none" ? undefined : { close() {
        closes += 1;
        if (mode === "throws") throw new Error("sync close");
        return mode === "rejected" ? Promise.reject(new Error("async close")) : Promise.resolve();
      } };
      const context = { get: () => connection, set: (_key, value) => { connection = value; } };
      run(context, { warn: error => errors.push(error.message) });
      assert.equal(connection, undefined);
      run(context, { warn: error => errors.push(error.message) });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(closes, mode === "none" ? 0 : 1);
      assert.equal(errors.length, ["rejected", "throws"].includes(mode) ? 1 : 0);
    }
  }
});
