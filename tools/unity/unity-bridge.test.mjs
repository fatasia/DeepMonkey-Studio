import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const packageBridgePath = new URL("./com.bim-studio.bridge/Editor/unity-bridge.js", import.meta.url);
const publicBridgePath = new URL("../../apps/web/public/unity-bridge.js", import.meta.url);

function loadBridge(source) {
  const messages = [];
  const listeners = new Map();
  const parent = {
    postMessage(message, origin) {
      messages.push({ message, origin });
    },
  };
  const window = {
    parent,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };
  vm.runInNewContext(source, { Array, Date, Error, Number, Object, Promise, window });
  return { bridge: window.BimStudioUnityBridge, messages };
}

test("package and public browser bridges stay identical", () => {
  assert.equal(readFileSync(packageBridgePath, "utf8"), readFileSync(publicBridgePath, "utf8"));
});

test("tracked Unity creation reports real monotonic loader progress and preserves the template callback", async () => {
  const { bridge, messages } = loadBridge(readFileSync(packageBridgePath, "utf8"));
  const callbackValues = [];
  const instance = { SendMessage() {} };
  const canvas = {};
  const config = { dataUrl: "Build/factory.data" };

  const result = await bridge.createTrackedInstance(
    (receivedCanvas, receivedConfig, onProgress) => {
      assert.equal(receivedCanvas, canvas);
      assert.equal(receivedConfig, config);
      onProgress(0.15);
      onProgress(0.65);
      onProgress(0.4);
      onProgress(1.2);
      return Promise.resolve(instance);
    },
    canvas,
    config,
    (progress) => callbackValues.push(progress),
  );
  bridge.register(result, "BimStudioBridge");

  assert.equal(result, instance);
  assert.deepEqual(callbackValues, [0.15, 0.65, 0.4, 1.2]);
  assert.deepEqual(
    messages.filter(({ message }) => message.type === "load-progress").map(({ message }) => message.progress),
    [0, 0.15, 0.65, 1],
  );
  assert.equal(messages.at(-1).message.type, "ready");
});
