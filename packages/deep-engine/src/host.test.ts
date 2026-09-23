import { describe, expect, it } from "vitest";
import * as host from "./host.js";
// 编译期存在性检查：类型导出被显式引用成联合别名，若从入口丢失会在 typecheck 报错。
import type {
  DeepRuntimePackage, GpuParticleSnapshot, HostCapabilitiesV1,
  PbrRendererOptions, PreparedPacket, ProbeGridBakeGrid, RayTracingCapability,
} from "./host.js";

/** 入口稳定值导出清单：新增导出必须同步登记，删除/改名视为破坏性变更。 */
const EXPECTED_VALUE_EXPORTS = [
  // 组 1：渲染后端创建与切换
  "PbrRenderer", "DEFAULT_PBR_RENDERER_FEATURES", "resolvePbrRendererFeatures", "DeviceSession",
  "BackendSwitchCoordinator", "BackendPreferenceController",
  // 组 2：探针 GI / 粒子 / 烘焙服务
  "ProbeGridBakeService", "ProbeClipmapPbrController", "DEFAULT_PROBE_CLIPMAP_RUNTIME_OPTIONS",
  "GpuParticleRuntime", "GPU_PARTICLE_CAMERA_UNIFORM_BYTES", "GPU_PARTICLE_DEFAULT_CAPACITY",
  "GPU_PARTICLE_FLAG_LOOP", "GPU_PARTICLE_FLAG_PULSE", "GPU_PARTICLE_FRAME_UNIFORM_BYTES",
  "GPU_PARTICLE_INDIRECT_BYTES", "GPU_PARTICLE_MAX_CAPACITY", "GPU_PARTICLE_STRIDE",
  "GPU_PARTICLE_WORKGROUP_SIZE",
  // 组 3：runtime-package 构建 / 校验 / 序列化 / 哈希
  "BUILTIN_RUNTIME_IBL_ID", "validateDeepRuntimePackage", "DYNAMIC_SCENE_RUNTIME_SCHEMA",
  "DYNAMIC_SCENE_RUNTIME_VERSION", "validateDynamicSceneRuntime", "parseDeepRuntimePackage",
  "serializeDeepRuntimePackage", "RUNTIME_CANONICAL_DOMAIN", "runtimeContentSha256",
  "runtimePackageSha256", "buildDeepRuntimePackage", "RuntimePackageError",
  // 组 4：能力探测与宿主合同
  "resolveRayTracingCapability", "resolveRayTracingDecision", "validateRayTracingCapabilities",
  "HOST_CAPABILITIES_SCHEMA_VERSION", "HOST_CAPABILITY_NAMES", "HOST_PROTOCOL_BUDGETS",
  "HOST_PROTOCOL_SCHEMA_VERSION", "validateHostCapabilities", "SessionAuthorityCoordinator",
  "createSessionAuthorityCoordinator",
  // 组 5：渲染包准备合同
  "MAX_EMISSIVE_STRENGTH", "prepareInstanceUpdate", "prepareRenderPacket",
] as const;

// 未被上方注释引用的类型占位引用，保证 type-only 导入全部参与编译。
export type HostEntryTypeSurface = [
  DeepRuntimePackage, GpuParticleSnapshot, HostCapabilitiesV1,
  PbrRendererOptions, PreparedPacket, ProbeGridBakeGrid, RayTracingCapability,
];

describe("deep-engine 统一宿主入口（host.ts）smoke", () => {
  it("全部预期值导出存在且不为 undefined", () => {
    for (const name of EXPECTED_VALUE_EXPORTS) {
      expect(host, `宿主入口缺少导出：${name}`).toHaveProperty(name);
      expect(host[name as keyof typeof host], `宿主入口导出为 undefined：${name}`).not.toBeUndefined();
    }
  });

  it("入口没有未登记的多余值导出（导出面与清单逐一对应）", () => {
    const actual = Object.keys(host).sort();
    const expected = [...EXPECTED_VALUE_EXPORTS].sort();
    expect(actual).toEqual(expected);
  });

  it("经入口调用的运行包校验功能真实可用（fail-closed 双向）", () => {
    expect(host.validateDynamicSceneRuntime({ schema: "deep-engine.runtime-package" }).valid).toBe(false);
    expect(host.validateDeepRuntimePackage({ schema: "unknown" }).valid).toBe(false);
  });
});
