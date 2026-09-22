// F6 第三方独立使用示例（Node 侧）：不依赖 Studio 编辑器与仓库源码，
// 仅消费 npm 安装的 @bim-studio/deep-engine 两个纯逻辑子路径导出：
//   1. `@bim-studio/deep-engine/runtime-package` 的 validateDynamicSceneRuntime
//      —— 发布包动态运行时（动画/交互/物理）合同校验，纯数据进、纯结果出；
//   2. `@bim-studio/deep-engine/lighting` 的 packNativeProbeGridRecords
//      —— GI 探针网格打包成 Native `probe_gi` storage 的 96B 小端记录序列，
//      字节布局与 Rust `probe_gi_grid.rs` 逐字对齐。
// 运行方式（在安装了该包的项目里）：node examples/node-standalone.mjs
// 全部断言通过时最后一行打印 `F6-NODE-STANDALONE:ALL-OK`。

import assert from "node:assert/strict";

import { validateDynamicSceneRuntime } from "@bim-studio/deep-engine/runtime-package";
import { packNativeProbeGridRecords } from "@bim-studio/deep-engine/lighting";

// ---------- 示例 1：发布包动态运行时校验 ----------

// 一个最小合法的 v1 动态运行时：schema/schemaVersion/id/revision 为必备字段，
// 动态通道至少要有一个（这里给 animation 与 interaction 两条）。
const validRuntime = {
  schema: "deep-engine.dynamic-runtime",
  schemaVersion: 1,
  id: "example-runtime",
  revision: 1,
  animation: {
    schema: "deep-engine.dynamic-animation",
    schemaVersion: 1,
    durationMs: 1000,
    tracks: [{
      targetId: "door",
      property: "translation",
      keyframes: [
        { timeMs: 0, value: [0, 0, 0, 0, 0, 0, 1], transition: "linear" },
        { timeMs: 1000, value: [2, 0, 0, 0, 0, 0, 1] },
      ],
    }],
  },
  interaction: {
    schema: "deep-engine.dynamic-interaction",
    schemaVersion: 1,
    trigger: "pointer-select",
    action: "select",
    targetId: "door",
  },
};

const accepted = validateDynamicSceneRuntime(validRuntime);
assert.equal(accepted.valid, true, "合法输入必须通过校验");
assert.equal(accepted.value.animation.tracks.length, 1);
console.log("[1] validateDynamicSceneRuntime 合法输入: valid=true, 通道=animation+interaction");

// 一个非法输入：schemaVersion 不在支持范围（1..3），校验必须 fail-closed 并给出定位。
const rejected = validateDynamicSceneRuntime({ ...validRuntime, schemaVersion: 99 });
assert.equal(rejected.valid, false, "非法输入必须被拒绝");
assert.ok(rejected.issues.length > 0 && rejected.issues[0].path === "$.schema");
console.log("[1] validateDynamicSceneRuntime 非法输入: valid=false, issue=%s",
  JSON.stringify(rejected.issues[0]));

// ---------- 示例 2：GI 探针网格打包（纯函数，返回 ArrayBuffer） ----------

// 2x2x2 的单层网格 → 8 个探针；输出 = 1 条网格头 + 8 条探针记录，每条 96 字节。
const level = { origin: [0, 0, 0], spacing: 2, gridSize: [2, 2, 2] };
// 探针顺序与线性下标 (z*gridY + y)*gridX + x 一致；这里所有探针同值，
// 数量与网格体积匹配即可被打包。
const probes = Array.from({ length: 2 * 2 * 2 }, () => ({
  irradiance: [1, 0.5, 0.25],
  validity: 1,
  meanDistance: 0.5,
  distanceVariance: 0.01,
  positionOffset: [0, 0, 0],
}));
const packed = packNativeProbeGridRecords(level, probes);
assert.equal(packed.byteLength, (1 + 8) * 96, "输出必须是 (1+探针数)*96 字节");

// 网格头是小端 f32：words[0..3]=origin、[3]=spacing、[4..7]=gridSize、
// [7]=baseProbeRecords(恒 1)、[8..11]=maxPosition、[11]=探针数。
const header = new DataView(packed);
assert.equal(header.getFloat32(3 * 4, true), 2);
assert.equal(header.getFloat32(4 * 4, true), 2);
assert.equal(header.getFloat32(6 * 4, true), 2);
assert.equal(header.getFloat32(7 * 4, true), 1);
assert.equal(header.getFloat32(11 * 4, true), 8);
console.log("[2] packNativeProbeGridRecords: %d 字节, 网格头 origin/spacing/gridSize/count 全部对位",
  packed.byteLength);

// 打包器 fail-closed：探针数量与网格不匹配时在写第一个字节前抛错。
assert.throws(() => packNativeProbeGridRecords(level, probes.slice(0, 3)), /probe-count-mismatch/);
console.log("[2] packNativeProbeGridRecords 非法输入: probe-count-mismatch 按预期抛出");

console.log(JSON.stringify({
  runtime: { valid: accepted.valid, schemaVersion: accepted.value.schemaVersion },
  probeGrid: { bytes: packed.byteLength, probes: 8, recordBytes: 96 },
}));
console.log("F6-NODE-STANDALONE:ALL-OK");
