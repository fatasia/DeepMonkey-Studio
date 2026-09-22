// F6 第三方独立使用示例（Browser 侧）：与 node-standalone.mjs 消费同一对纯逻辑导出，
// 证明 @bim-studio/deep-engine 的 runtime-package / lighting 子路径在浏览器 bundle
// 环境可加载、可执行——不创建 WebGPU 设备，纯数据进、纯结果出。
// 入口约定：
//   - 导出 runBrowserProbe()：返回结果对象，供自动化断言复用；
//   - 在浏览器 DOM 中加载时，自动把 JSON 结果写入 #standalone-output，
//     并挂到 window.__F6_STANDALONE_RESULT__ 供门禁脚本读取。

import { validateDynamicSceneRuntime } from "@bim-studio/deep-engine/runtime-package";
import { packNativeProbeGridRecords } from "@bim-studio/deep-engine/lighting";

/** 执行两个纯逻辑探针，返回可 JSON 序列化的结果摘要。 */
export function runBrowserProbe() {
  // 探针 1：动态运行时合同校验——合法输入通过，非法输入 fail-closed。
  const validRuntime = {
    schema: "deep-engine.dynamic-runtime",
    schemaVersion: 1,
    id: "example-runtime",
    revision: 1,
    interaction: {
      schema: "deep-engine.dynamic-interaction",
      schemaVersion: 1,
      trigger: "pointer-select",
      action: "select",
      targetId: "door",
    },
  };
  const accepted = validateDynamicSceneRuntime(validRuntime);
  const rejected = validateDynamicSceneRuntime({ ...validRuntime, schemaVersion: 99 });

  // 探针 2：GI 探针网格打包——2x2x2 网格输出 (1+8)*96 字节，网格头字段对位。
  const packed = packNativeProbeGridRecords(
    { origin: [0, 0, 0], spacing: 2, gridSize: [2, 2, 2] },
    Array.from({ length: 8 }, () => ({
      irradiance: [1, 0.5, 0.25], validity: 1, meanDistance: 0.5, distanceVariance: 0.01,
    })),
  );
  const header = new DataView(packed);
  return {
    module: "esm-browser-bundle",
    runtime: {
      valid: accepted.valid,
      rejectedValid: rejected.valid,
      issuePath: rejected.valid ? null : rejected.issues[0]?.path ?? null,
    },
    probeGrid: {
      bytes: packed.byteLength,
      headerCount: header.getFloat32(11 * 4, true),
      headerSpacing: header.getFloat32(3 * 4, true),
    },
  };
}

// 在浏览器环境中自运行：把结果写进 DOM 并挂到 window，页面无需任何额外脚本。
if (typeof document !== "undefined") {
  const summary = runBrowserProbe();
  window.__F6_STANDALONE_RESULT__ = summary;
  const output = document.getElementById("standalone-output");
  if (output) output.textContent = JSON.stringify(summary);
}
