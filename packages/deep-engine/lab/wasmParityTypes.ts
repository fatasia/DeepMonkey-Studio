/** Wasm 桥黄金样例对等验收探针的报告形状(浏览器与 Node driver 共用)。 */

/**
 * W-2 环境口径(2026-09-29 切片):
 * - `no-ibl`:切片前现状,v2 solid-background-no-ibl(回归对照口径);
 * - `studio`:v8 solid-background-builtin-ibl——与 JS 侧 studioDeepNeutralEnvironment()
 *   返回 `{kind:"studio"}` 同一待遇,Rust 端 ibl.rs `builtin_default_environment()`
 *   (deep.builtin.studio-ibl.v1)消费;
 * - `studio-ground`:studio + renderPacket 注入程序化地面网格(GroundPlane 合同缺位的
 *   harness 受控实验口径;地面是显式声明的 packet 对象,不冒充引擎内置地面能力)。
 */
export type WasmParityEnvironment = "no-ibl" | "studio" | "studio-ground";

/** studio-ground 口径注入包内的地面对象清单(packet 计数增量,供 gate G2 补偿)。 */
export interface WasmParityGroundInjection {
  geometryId: string;
  materialId: string;
  instanceId: string;
  /** 地面半边长(世界单位;顶点基准 ±1 经实例 XZ 缩放)。 */
  halfSize: number;
}

export interface WasmParityCamera {
  position: readonly [number, number, number];
  target: readonly [number, number, number];
  verticalFovDegrees: number;
  near: number;
  far: number;
  focal: number;
}

export interface WasmParityReport {
  schema: "wasm-parity-probe.v1";
  startedAt: string;
  instances: number;
  orbitDegrees: number;
  asset: "FactoryMachine" | "procedural";
  environment: WasmParityEnvironment;
  fixture: {
    id: string;
    assetIdentity: { sha256: string; sourceSha256: string } | null;
    counts: { instances: number; geometries: number; materials: number; textures: number };
    triangles: number;
    camera: WasmParityCamera;
    view: { width: number; height: number };
  } | null;
  package: {
    sha256: string;
    byteLength: number;
    packetCounts: { instances: number; geometries: number; materials: number; textures: number } | null;
    documentKeys: string[];
    groundInjection: WasmParityGroundInjection | null;
  } | null;
  webgpu: {
    drawCalls: number;
    triangles: number;
    capture: { width: number; height: number; sha256: string;
      meanLuminance: number; geometryDetailFraction: number };
    repeatCapture: { sha256: string; meanLuminance: number; identical: boolean };
    errors: readonly string[];
  } | null;
  wasm: {
    handle: number;
    readyGeneration: number;
    failureMessage: string | null;
    timingsMs: { moduleLoad: number; rendererReady: number };
  } | null;
  webgpuError: string | null;
  wasmError: string | null;
  fatal?: string;
  consoleErrors: string[];
  wallMs?: number;
  startedAtPerformance?: number;
}
